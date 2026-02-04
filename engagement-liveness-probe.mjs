#!/usr/bin/env node
/**
 * engagement-liveness-probe.mjs — Lightweight health check for engagement platforms.
 *
 * Runs before E sessions to mark degraded platforms in platform-circuits.json.
 * Only checks platforms from account-registry.json (engagement targets).
 *
 * Usage:
 *   node engagement-liveness-probe.mjs          # Check all engagement platforms
 *   node engagement-liveness-probe.mjs --json   # Machine-readable output
 *   node engagement-liveness-probe.mjs --dry    # Don't update circuits file
 *
 * wq-197: Engagement platform liveness monitor
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { safeFetch } from "./lib/safe-fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, "account-registry.json");
const CIRCUITS_PATH = join(__dirname, "platform-circuits.json");
const SERVICES_PATH = join(__dirname, "services.json");

const PROBE_TIMEOUT = 5000; // 5s per platform — keep it fast
const CIRCUIT_OPEN_THRESHOLD = 2; // Mark circuit open after 2 consecutive failures

// Platform URL mapping (registry has platform names, need to map to URLs)
// Some platforms have dedicated test endpoints in registry, use those if available
function getTestUrl(account, services) {
  // If account has a curl test URL, use that
  if (account.test?.url) {
    return account.test.url;
  }

  // Fall back to services.json URL
  const serviceName = account.platform.toLowerCase();
  const service = services?.services?.find(s =>
    s.name?.toLowerCase().includes(serviceName) ||
    s.id?.toLowerCase().includes(serviceName)
  );

  if (service?.url) {
    return service.url;
  }

  // Known platform URLs as last resort
  const urlMap = {
    "moltbook": "https://moltbook.xyz",
    "4claw.org": "https://4claw.org",
    "chatr.ai": "https://chatr.ai",
    "thecolony.cc": "https://thecolony.cc",
    "mydeadinternet.com": "https://mydeadinternet.com",
    "pinchwork.dev": "https://pinchwork.dev",
    "grove.ctxly.app": "https://grove.ctxly.app",
    "tulip": "https://tulip.fg-goose.online",
    "lobstack": "https://lobstack.ai",
    "darkclawbook": "https://darkclawbook.self.md",
    "lobchan": "https://lobchan.com",
    "imanagent.ai": "https://imanagent.ai",
  };

  return urlMap[serviceName] || null;
}

async function probeUrl(url) {
  const result = await safeFetch(url, {
    timeout: PROBE_TIMEOUT,
    bodyMode: "none",
    userAgent: "moltbook-liveness/1.0",
  });

  // Consider service reachable if we got any HTTP response (even 4xx/5xx)
  // Only mark unreachable on timeout (status=0) or DNS failure
  // 4xx/5xx means service is up, just auth/endpoint issues
  const reachable = result.status > 0;
  // For display, 2xx/3xx is "healthy", 4xx/5xx is "degraded", 0 is "down"
  const healthy = result.status >= 200 && result.status < 400;
  return {
    reachable,  // Used for circuit decisions
    healthy,    // Used for display
    status: result.status,
    elapsed: result.elapsed,
    error: result.error || null,
  };
}

function loadJSON(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const dryRun = args.includes("--dry");

  const registry = loadJSON(REGISTRY_PATH);
  const services = loadJSON(SERVICES_PATH);
  let circuits = loadJSON(CIRCUITS_PATH, {});

  if (!registry?.accounts?.length) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: "no_accounts", checked: 0 }));
    } else {
      console.log("[liveness-probe] No accounts in registry, skipping.");
    }
    return;
  }

  const results = [];
  const now = new Date().toISOString();
  let degraded = 0;
  let recovered = 0;

  for (const account of registry.accounts) {
    const url = getTestUrl(account, services);
    if (!url) {
      if (!jsonOutput) {
        console.log(`[?] ${account.platform} — no URL found, skipping`);
      }
      continue;
    }

    const probe = await probeUrl(url);
    // Use account.id as key (matches platform-picker getCircuitStatus lookup)
    const circuitKey = account.id;

    // Initialize circuit if not exists
    if (!circuits[circuitKey]) {
      circuits[circuitKey] = {
        consecutive_failures: 0,
        total_failures: 0,
        total_successes: 0,
      };
    }

    const circuit = circuits[circuitKey];
    const wasOpen = circuit.status === "open";

    // Use reachable (any HTTP response) for circuit decisions
    // 4xx/5xx = service is up, just auth issues — don't open circuit
    if (probe.reachable) {
      circuit.consecutive_failures = 0;
      circuit.total_successes = (circuit.total_successes || 0) + 1;
      circuit.last_success = now;

      // Close circuit if it was open
      if (wasOpen) {
        delete circuit.status;
        delete circuit.opened_at;
        delete circuit.reason;
        recovered++;
      }
    } else {
      // Only count as failure if truly unreachable (timeout/DNS)
      circuit.consecutive_failures = (circuit.consecutive_failures || 0) + 1;
      circuit.total_failures = (circuit.total_failures || 0) + 1;
      circuit.last_failure = now;
      circuit.last_error = probe.error || "unreachable";

      // Open circuit after threshold
      if (circuit.consecutive_failures >= CIRCUIT_OPEN_THRESHOLD && !wasOpen) {
        circuit.status = "open";
        circuit.opened_at = now;
        circuit.reason = `${circuit.consecutive_failures} consecutive failures (unreachable)`;
        degraded++;
      }
    }

    // Display uses healthy (2xx/3xx) for green checkmark
    const icon = probe.healthy ? "✓" : probe.reachable ? "~" : "✗";
    const ms = Math.round((probe.elapsed || 0) * 1000);

    results.push({
      platform: account.platform,
      url,
      reachable: probe.reachable,
      healthy: probe.healthy,
      status: probe.status,
      elapsed: ms,
      error: probe.error,
      circuit: circuit.status || "closed",
    });

    if (!jsonOutput) {
      const circuitInfo = circuit.status === "open" ? " [CIRCUIT OPEN]" : "";
      console.log(`[${icon}] ${account.platform} — ${probe.status || "ERR"} ${ms}ms${circuitInfo}`);
    }
  }

  // Save updated circuits
  if (!dryRun) {
    saveJSON(CIRCUITS_PATH, circuits);
  }

  // Summary
  const healthy = results.filter(r => r.healthy).length;
  const unhealthy = results.filter(r => !r.healthy).length;
  const openCircuits = results.filter(r => r.circuit === "open").length;

  if (jsonOutput) {
    console.log(JSON.stringify({
      checked: now,
      total: results.length,
      healthy,
      unhealthy,
      openCircuits,
      degraded,
      recovered,
      results,
    }, null, 2));
  } else {
    console.log(`\n--- Engagement Liveness ---`);
    console.log(`Checked: ${results.length} | Healthy: ${healthy} | Unhealthy: ${unhealthy} | Open circuits: ${openCircuits}`);
    if (degraded > 0) console.log(`Newly degraded: ${degraded}`);
    if (recovered > 0) console.log(`Recovered: ${recovered}`);
    if (dryRun) console.log("(dry run — circuits not updated)");
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});

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
 * wq-439: Liveness cache — skip re-probing platforms checked within CACHE_TTL sessions
 * R#221: Structural — time-based cache TTL + priority filtering (skip rejected/defunct)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { safeFetch } from "./lib/safe-fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, "account-registry.json");
const CIRCUITS_PATH = join(__dirname, "platform-circuits.json");
const SERVICES_PATH = join(__dirname, "services.json");
const CACHE_PATH = join(homedir(), ".config", "moltbook", "liveness-cache.json");
const TIMING_PATH = join(homedir(), ".config", "moltbook", "liveness-timing.json"); // wq-676

const PROBE_TIMEOUT = 3000; // 3s per platform — fast timeout, most respond in <1s
const CIRCUIT_OPEN_THRESHOLD = 2; // Mark circuit open after 2 consecutive failures
const BATCH_SIZE = 15; // Probe 15 at a time to avoid overwhelming DNS/network
const GLOBAL_TIMEOUT = 8000; // Hard cap: entire probe must finish in 8s
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // R#221: 2h time-based TTL — survives across session types

// R#221: Platforms with these statuses or note keywords are never selected by platform-picker,
// so probing them wastes time and contributes to the 12s timeout.
const SKIP_STATUSES = new Set(["rejected", "defunct"]);
const SKIP_NOTE_PATTERNS = /REJECTED|defunct|invitation.only/i;

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

function loadCache() {
  return loadJSON(CACHE_PATH, { entries: {}, session: 0 });
}

function saveCache(cache) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  saveJSON(CACHE_PATH, cache);
}

async function main() {
  const wallStart = performance.now(); // wq-676: timing telemetry
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const dryRun = args.includes("--dry");
  const noCache = args.includes("--no-cache");

  // Parse --session N flag (same pattern as inline-intel-capture.mjs)
  const sessionIdx = args.indexOf("--session");
  const sessionNum = (sessionIdx !== -1 && args[sessionIdx + 1])
    ? parseInt(args[sessionIdx + 1]) || 0
    : parseInt(process.env.SESSION_NUM) || 0;

  const registry = loadJSON(REGISTRY_PATH);
  const services = loadJSON(SERVICES_PATH);
  let circuits = loadJSON(CIRCUITS_PATH, {});
  const cache = noCache ? { entries: {}, session: 0 } : loadCache();

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

  // R#221: Build probe tasks, filtering out platforms that platform-picker would never select.
  // This reduces probe set from ~47 to ~20, keeping total probe time within the 8s budget.
  const probeTasks = [];
  let skippedCount = 0;
  for (const account of registry.accounts) {
    // Skip platforms with rejected/defunct status or matching note patterns
    if (SKIP_STATUSES.has(account.status)) { skippedCount++; continue; }
    if (account.notes && SKIP_NOTE_PATTERNS.test(account.notes)) { skippedCount++; continue; }

    const url = getTestUrl(account, services);
    if (!url) {
      if (!jsonOutput) {
        console.log(`[?] ${account.platform} — no URL found, skipping`);
      }
      continue;
    }
    probeTasks.push({ account, url });
  }
  if (!jsonOutput && skippedCount > 0) {
    console.log(`[filter] Skipped ${skippedCount} rejected/defunct platforms`);
  }

  // wq-439: Filter out platforms with fresh cache entries
  const staleTasks = [];
  const cachedResults = [];
  let cacheHits = 0;

  const nowMs = Date.now();
  for (const task of probeTasks) {
    const cacheKey = task.account.id;
    const cached = cache.entries[cacheKey];

    // R#221: Time-based cache TTL — survives across session types (B probes feed E cache)
    // Backwards compat: old entries have session but no timestamp — treat as stale (one-time migration)
    const cacheValid = cached && (
      (cached.timestamp && (nowMs - cached.timestamp) < CACHE_TTL_MS) ||
      (!cached.timestamp && sessionNum > 0 && cached.session === sessionNum) // same session = fresh
    );
    if (cacheValid) {
      // Cache hit — use cached result, skip network probe
      cacheHits++;
      cachedResults.push({
        account: task.account,
        url: task.url,
        probe: { reachable: cached.reachable, healthy: cached.healthy, status: cached.status, elapsed: 0, error: null },
        fromCache: true,
      });
    } else {
      staleTasks.push(task);
    }
  }

  if (!jsonOutput && cacheHits > 0) {
    console.log(`[cache] ${cacheHits} platforms cached (TTL=2h), probing ${staleTasks.length} stale`);
  }

  // R#206: Hard global timeout kills the process if probes hang.
  // 47 parallel DNS lookups overwhelm VPS resolver (30s+ observed).
  // Process.exit is the only reliable way to abort hanging fetch() calls.
  const forceExitTimer = setTimeout(() => {
    if (!jsonOutput) console.log(`[!] Hard timeout (${GLOBAL_TIMEOUT}ms) — force exiting with cached circuit state`);
    process.exit(0); // Exit cleanly so hook doesn't report failure
  }, GLOBAL_TIMEOUT);
  // Note: do NOT unref — we need this timer to fire even if fetches are pending

  // Batch stale platforms into groups to reduce DNS pressure
  const probeResults = [];
  for (let i = 0; i < staleTasks.length; i += BATCH_SIZE) {
    const batch = staleTasks.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async ({ account, url }) => {
        const probe = await probeUrl(url);
        return { account, url, probe };
      })
    );
    probeResults.push(...batchResults);
  }
  clearTimeout(forceExitTimer);

  // Merge cached results as fulfilled settled entries
  for (const cached of cachedResults) {
    probeResults.push({ status: "fulfilled", value: cached });
  }

  // Process results and update circuits
  for (const settled of probeResults) {
    if (settled.status === "rejected") continue;
    const { account, url, probe } = settled.value;

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
    const wasHalfOpen = circuit.status === "half-open";

    // Use reachable (any HTTP response) for circuit decisions
    // 4xx/5xx = service is up, just auth issues — don't open circuit
    if (probe.reachable) {
      circuit.consecutive_failures = 0;
      circuit.total_successes = (circuit.total_successes || 0) + 1;
      circuit.last_success = now;

      // Close circuit if it was open or half-open
      if (wasOpen || wasHalfOpen) {
        delete circuit.status;
        delete circuit.opened_at;
        delete circuit.half_open_at;
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
      const cacheTag = settled.value.fromCache ? " (cached)" : "";
      console.log(`[${icon}] ${account.platform} — ${probe.status || "ERR"} ${ms}ms${circuitInfo}${cacheTag}`);
    }
  }

  // Save updated circuits
  if (!dryRun) {
    saveJSON(CIRCUITS_PATH, circuits);
  }

  // R#221: Update cache with time-based TTL entries
  if (!dryRun && !noCache) {
    const cacheTs = Date.now();
    for (const settled of probeResults) {
      if (settled.status === "rejected") continue;
      const { account, probe, fromCache } = settled.value;
      if (fromCache) continue; // Don't re-cache already-cached entries
      cache.entries[account.id] = {
        timestamp: cacheTs,
        session: sessionNum, // Keep for backwards compat / debugging
        reachable: probe.reachable,
        healthy: probe.healthy,
        status: probe.status,
      };
    }
    cache.session = sessionNum;
    saveCache(cache);
  }

  // wq-676: Log timing telemetry on cache misses (actual live probes)
  // Appends to liveness-timing.json so A sessions can track probe latency trends.
  if (!dryRun && staleTasks.length > 0) {
    const wallMs = Math.round(performance.now() - wallStart);
    const probed = probeResults
      .filter(s => s.status === "fulfilled" && !s.value.fromCache)
      .map(s => ({
        platform: s.value.account.platform,
        ms: Math.round((s.value.probe.elapsed || 0) * 1000),
        ok: s.value.probe.reachable,
      }));
    const timingEntry = {
      ts: now,
      session: sessionNum,
      wallMs,
      probed: probed.length,
      cached: cacheHits,
      skipped: skippedCount,
      avgMs: probed.length > 0 ? Math.round(probed.reduce((a, p) => a + p.ms, 0) / probed.length) : 0,
      p95Ms: probed.length > 0 ? probed.map(p => p.ms).sort((a, b) => a - b)[Math.floor(probed.length * 0.95)] : 0,
      platforms: probed,
    };
    try {
      const timing = loadJSON(TIMING_PATH, { entries: [] });
      timing.entries.push(timingEntry);
      // Keep last 100 entries to bound file size
      if (timing.entries.length > 100) timing.entries = timing.entries.slice(-100);
      saveJSON(TIMING_PATH, timing);
    } catch { /* non-critical — don't fail probe on timing write error */ }
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
    console.log(`Checked: ${results.length} | Healthy: ${healthy} | Unhealthy: ${unhealthy} | Open circuits: ${openCircuits} | Cache hits: ${cacheHits}`);
    if (degraded > 0) console.log(`Newly degraded: ${degraded}`);
    if (recovered > 0) console.log(`Recovered: ${recovered}`);
    if (dryRun) console.log("(dry run — circuits not updated)");
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * circuit-reset-probe.mjs — Probe open circuits and reset on recovery.
 *
 * Background job that checks platforms with open circuits and transitions
 * them to "half-open" on success. The next E session liveness probe will
 * fully close them if still healthy.
 *
 * This enables faster recovery from transient outages without waiting for
 * E session rotation (every ~5 sessions in BBBRE cycle).
 *
 * Usage:
 *   node circuit-reset-probe.mjs          # Check all open circuits
 *   node circuit-reset-probe.mjs --json   # Machine-readable output
 *   node circuit-reset-probe.mjs --dry    # Don't update circuits file
 *
 * wq-230: Auto-circuit-breaker reset probe
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { safeFetch } from "./lib/safe-fetch.mjs";
import { getHealthUrl } from "./lib/platform-health-urls.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_PATH = join(__dirname, "platform-circuits.json");
const REGISTRY_PATH = join(__dirname, "account-registry.json");
const STATE_DIR = join(process.env.HOME, ".config/moltbook");
const RECOVERY_EVENTS_PATH = join(STATE_DIR, "circuit-recovery-events.json");
const PROBE_TIMEOUT = 3000; // 3s per platform (reduced from 5s for hook timing)

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

// wq-317: Track recovery events for E session notification
function logRecoveryEvent(platformId, transition, details) {
  const events = loadJSON(RECOVERY_EVENTS_PATH, { events: [], max_events: 20 });
  const event = {
    platform: platformId,
    transition,  // "open->half-open" or "half-open->closed"
    timestamp: new Date().toISOString(),
    session: parseInt(process.env.SESSION_NUM || "0", 10),
    ...details
  };
  events.events.unshift(event);
  // Keep only last N events
  events.events = events.events.slice(0, events.max_events || 20);
  saveJSON(RECOVERY_EVENTS_PATH, events);
}

function getUrlForPlatform(platformId) {
  const registry = loadJSON(REGISTRY_PATH);
  return getHealthUrl(platformId, registry);
}

async function probeUrl(url) {
  const result = await safeFetch(url, {
    timeout: PROBE_TIMEOUT,
    bodyMode: "none",
    userAgent: "moltbook-circuit-reset/1.0",
  });

  // Service is reachable if we got any HTTP response
  const reachable = result.status > 0;
  return {
    reachable,
    status: result.status,
    elapsed: result.elapsed,
    error: result.error || null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const dryRun = args.includes("--dry");

  const circuits = loadJSON(CIRCUITS_PATH, {});
  const now = new Date().toISOString();

  // Find all open circuits (transition to half-open on success)
  const openCircuits = Object.entries(circuits).filter(
    ([_id, circuit]) => circuit.status === "open"
  );

  // wq-300: Also find half-open circuits (close on success, re-open on failure)
  const halfOpenCircuits = Object.entries(circuits).filter(
    ([_id, circuit]) => circuit.status === "half-open"
  );

  if (openCircuits.length === 0 && halfOpenCircuits.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ checked: now, open_count: 0, half_open_count: 0, probed: 0, recovered: 0, closed: 0 }));
    } else {
      console.log("[circuit-reset] No open or half-open circuits to probe.");
    }
    return;
  }

  if (!jsonOutput) {
    console.log(`[circuit-reset] Found ${openCircuits.length} open + ${halfOpenCircuits.length} half-open circuit(s), probing...`);
  }

  const results = [];
  let recovered = 0;
  let closed = 0;
  let reopened = 0;

  // Resolve URLs and build probe tasks for both phases
  const allTasks = [];
  for (const [platformId, circuit] of openCircuits) {
    const url = getUrlForPlatform(platformId);
    if (!url) {
      if (!jsonOutput) console.log(`[?] ${platformId} — no URL found, skipping`);
      continue;
    }
    allTasks.push({ platformId, circuit, url, phase: "open" });
  }
  for (const [platformId, circuit] of halfOpenCircuits) {
    const url = getUrlForPlatform(platformId);
    if (!url) {
      if (!jsonOutput) console.log(`[?] ${platformId} — no URL found, skipping`);
      continue;
    }
    allTasks.push({ platformId, circuit, url, phase: "half-open" });
  }

  // Probe ALL circuits in parallel (open + half-open together)
  const probeResults = await Promise.allSettled(
    allTasks.map(async (task) => {
      const probe = await probeUrl(task.url);
      return { ...task, probe };
    })
  );

  // Process results sequentially (state mutations)
  for (const settled of probeResults) {
    if (settled.status !== "fulfilled") continue;
    const { platformId, circuit, url, probe, phase } = settled.value;
    const ms = Math.round((probe.elapsed || 0) * 1000);

    if (phase === "open") {
      // Phase 1: open circuits → half-open on success
      if (probe.reachable) {
        circuit.status = "half-open";
        circuit.half_open_at = now;
        circuit.consecutive_failures = 0;
        delete circuit.last_error;
        recovered++;
        if (!dryRun) {
          logRecoveryEvent(platformId, "open->half-open", {
            http_status: probe.status,
            latency_ms: ms
          });
        }
        if (!jsonOutput) console.log(`[✓] ${platformId} — recovered (${probe.status} ${ms}ms) → half-open`);
      } else {
        circuit.last_probe = now;
        circuit.last_error = probe.error || "unreachable";
        if (!jsonOutput) console.log(`[✗] ${platformId} — still down (${probe.error || "unreachable"} ${ms}ms)`);
      }
      results.push({
        platform: platformId, url,
        reachable: probe.reachable, status: probe.status,
        elapsed: ms, new_state: circuit.status,
      });
    } else {
      // Phase 2: half-open circuits → close on success, re-open on failure
      if (probe.reachable) {
        delete circuit.status;
        delete circuit.half_open_at;
        delete circuit.opened_at;
        delete circuit.reason;
        delete circuit.last_error;
        circuit.consecutive_failures = 0;
        circuit.total_successes = (circuit.total_successes || 0) + 1;
        circuit.last_success = now;
        closed++;
        if (!dryRun) {
          logRecoveryEvent(platformId, "half-open->closed", {
            http_status: probe.status, latency_ms: ms
          });
        }
        if (!jsonOutput) console.log(`[✓] ${platformId} — closed (${probe.status} ${ms}ms) → healthy`);
      } else {
        circuit.status = "open";
        circuit.opened_at = now;
        circuit.reason = `half-open probe failed: ${probe.error || "unreachable"}`;
        circuit.last_error = probe.error || "unreachable";
        circuit.last_failure = now;
        circuit.consecutive_failures = (circuit.consecutive_failures || 0) + 1;
        circuit.total_failures = (circuit.total_failures || 0) + 1;
        reopened++;
        if (!jsonOutput) console.log(`[✗] ${platformId} — re-opened (${probe.error || "unreachable"} ${ms}ms) → open`);
      }
      results.push({
        platform: platformId, url,
        reachable: probe.reachable, status: probe.status,
        elapsed: ms, new_state: circuit.status || "closed",
        was_half_open: true,
      });
    }
  }

  // Save updated circuits
  if (!dryRun && (recovered > 0 || closed > 0 || reopened > 0)) {
    saveJSON(CIRCUITS_PATH, circuits);
  }

  // Log to file for tracking
  if (!dryRun && results.length > 0) {
    const logPath = join(STATE_DIR, "logs/circuit-reset.log");
    const logEntry = `${now} probed=${results.length} recovered=${recovered} ${results.map(r => `${r.platform}:${r.new_state}`).join(" ")}\n`;
    try {
      const existing = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      // Keep last 100 lines
      const lines = existing.trim().split("\n").slice(-99);
      lines.push(logEntry.trim());
      writeFileSync(logPath, lines.join("\n") + "\n");
    } catch {
      // Ignore log errors
    }
  }

  if (jsonOutput) {
    console.log(
      JSON.stringify({
        checked: now,
        open_count: openCircuits.length,
        half_open_count: halfOpenCircuits.length,
        probed: results.length,
        recovered,
        closed,
        reopened,
        results,
      }, null, 2)
    );
  } else {
    console.log(`\n--- Circuit Reset Summary ---`);
    console.log(`Open: ${openCircuits.length} | Half-open: ${halfOpenCircuits.length} | Probed: ${results.length}`);
    console.log(`Recovered: ${recovered} | Closed: ${closed} | Reopened: ${reopened}`);
    if (dryRun) console.log("(dry run — circuits not updated)");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

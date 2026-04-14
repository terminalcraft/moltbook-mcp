#!/usr/bin/env node
/**
 * recovery-probe.mjs — Auto-recovery probe for circuit-broken platforms.
 *
 * d078 deliverable 2 (wq-990): Periodically checks platforms with status:"closed"
 * in platform-circuits.json and auto-reopens circuits when they respond correctly.
 *
 * Skips platforms with status:"defunct" or notes containing "Human intervention"
 * (these need manual action, not automated probing).
 *
 * On probe success (any HTTP response):
 *   - Resets consecutive_failures to 0
 *   - Removes status:"closed"
 *   - Updates last_success and last_probe
 *
 * On probe failure:
 *   - Updates last_probe timestamp only (doesn't increment failures)
 *
 * Usage:
 *   import { probeCircuitBroken } from './recovery-probe.mjs';
 *   const results = await probeCircuitBroken({ dryRun: false });
 *
 * Standalone:
 *   node lib/recovery-probe.mjs [--dry] [--json]
 *
 * Created: wq-990, d078 deliverable 2 (B#635)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { safeFetch } from "./safe-fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUIT_PATH = join(__dirname, "..", "platform-circuits.json");
const REGISTRY_PATH = join(__dirname, "..", "account-registry.json");
const SERVICES_PATH = join(__dirname, "..", "services.json");

const PROBE_TIMEOUT = 5000; // 5s — generous since we're only probing a few platforms
const SKIP_NOTES_RE = /Human intervention|DNS NXDOMAIN|never worked/i;

function loadJSON(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Get a probe URL for a platform by checking account-registry and services.json.
 * Reuses the same URL resolution logic as engagement-liveness-probe.mjs.
 */
function getProbeUrl(platformId, registry, services) {
  // Check account-registry for test URL
  const account = registry?.accounts?.find(a => a.id === platformId);
  if (account?.test?.url) return account.test.url;

  // Check services.json
  const service = services?.services?.find(s =>
    s.name?.toLowerCase().includes(platformId.toLowerCase()) ||
    s.id?.toLowerCase().includes(platformId.toLowerCase())
  );
  if (service?.url) return service.url;

  // Known URL fallbacks
  const urlMap = {
    "moltbook": "https://moltbook.xyz",
    "grove": "https://grove.ctxly.app",
    "thecolony": "https://thecolony.cc",
    "ctxly": "https://ctxly.app",
    "shipyard": "https://shipyard.fg-goose.online",
    "nicepick": "https://nicepick.ai",
    "4claw": "https://4claw.org",
    "chatr": "https://chatr.ai",
    "moltchan": "https://www.moltchan.org",
    "pinchwork": "https://pinchwork.dev",
  };
  return urlMap[platformId] || null;
}

/**
 * Probe all circuit-broken platforms and auto-reopen on success.
 * @param {Object} opts
 * @param {boolean} opts.dryRun - Don't write changes to disk
 * @returns {{ probed: number, recovered: string[], skipped: string[], failed: string[], results: Object[] }}
 */
export async function probeCircuitBroken(opts = {}) {
  const { dryRun = false } = opts;
  const circuits = loadJSON(CIRCUIT_PATH);
  const registry = loadJSON(REGISTRY_PATH);
  const services = loadJSON(SERVICES_PATH);
  const now = new Date().toISOString();

  const results = [];
  const recovered = [];
  const skipped = [];
  const failed = [];

  // Find all status:"closed" platforms (not defunct)
  const closedPlatforms = Object.entries(circuits).filter(([, entry]) => {
    if (entry.status !== "closed") return false;
    if (entry.status === "defunct") return false;
    // Skip platforms needing human intervention
    if (entry.notes && SKIP_NOTES_RE.test(entry.notes)) return false;
    return true;
  });

  if (closedPlatforms.length === 0) {
    return { probed: 0, recovered, skipped, failed, results };
  }

  // Probe each closed platform
  const probePromises = closedPlatforms.map(async ([platformId, entry]) => {
    const url = getProbeUrl(platformId, registry, services);
    if (!url) {
      skipped.push(platformId);
      results.push({ platform: platformId, outcome: "skipped", reason: "no URL" });
      return;
    }

    try {
      const probe = await safeFetch(url, {
        timeout: PROBE_TIMEOUT,
        bodyMode: "none",
        userAgent: "moltbook-recovery/1.0",
      });

      // Reachable = any HTTP response (even 4xx/5xx means the server is up)
      if (probe.status > 0) {
        // Recovery: clear circuit-broken state
        entry.consecutive_failures = 0;
        delete entry.status;
        entry.last_success = now;
        entry.last_probe = now;
        entry.notes = `Auto-recovered by recovery-probe at ${now} (HTTP ${probe.status}). Previous: ${entry.notes || "none"}`;
        recovered.push(platformId);
        results.push({ platform: platformId, outcome: "recovered", httpStatus: probe.status, elapsed: probe.elapsed });
      } else {
        // Still unreachable
        entry.last_probe = now;
        failed.push(platformId);
        results.push({ platform: platformId, outcome: "still_down", error: probe.error, elapsed: probe.elapsed });
      }
    } catch (err) {
      entry.last_probe = now;
      failed.push(platformId);
      results.push({ platform: platformId, outcome: "probe_error", error: err.message });
    }
  });

  await Promise.allSettled(probePromises);

  // Save updated circuits
  if (!dryRun) {
    saveJSON(CIRCUIT_PATH, circuits);
  }

  return { probed: closedPlatforms.length, recovered, skipped, failed, results };
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith("recovery-probe.mjs")) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const jsonOutput = args.includes("--json");

  probeCircuitBroken({ dryRun }).then(result => {
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[recovery-probe] Probed ${result.probed} circuit-broken platforms`);
      if (result.recovered.length) console.log(`[recovery-probe] Recovered: ${result.recovered.join(", ")}`);
      if (result.failed.length) console.log(`[recovery-probe] Still down: ${result.failed.join(", ")}`);
      if (result.skipped.length) console.log(`[recovery-probe] Skipped (no URL): ${result.skipped.join(", ")}`);
      if (result.probed === 0) console.log("[recovery-probe] No circuit-broken platforms to probe");
      if (dryRun) console.log("[recovery-probe] (dry run — no changes written)");
    }
  }).catch(err => {
    console.error("[recovery-probe] Error:", err.message);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * open-circuit-repair.mjs — Probe open circuits and auto-repair or mark defunct.
 *
 * This is the "auto-repair" workflow for open circuits:
 * 1. Probe each open circuit with HTTP health checks
 * 2. If recovered → reset circuit (transition to half-open)
 * 3. If still down AND persistently failing → mark as defunct in account-registry.json
 *
 * Defunct threshold: 10+ consecutive failures AND circuit open for 24+ hours
 *
 * Usage:
 *   node open-circuit-repair.mjs          # Probe and repair/defunct
 *   node open-circuit-repair.mjs --json   # Machine-readable output
 *   node open-circuit-repair.mjs --dry    # Don't update files
 *   node open-circuit-repair.mjs --force  # Mark defunct even below threshold
 *
 * wq-312: Open circuit auto-repair workflow
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { safeFetch } from "./lib/safe-fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_PATH = join(__dirname, "platform-circuits.json");
const REGISTRY_PATH = join(__dirname, "account-registry.json");
const STATE_DIR = join(process.env.HOME, ".config/moltbook");
const PROBE_TIMEOUT = 8000; // 8s per platform (allow for slow responses)

// Defunct thresholds
const DEFUNCT_FAILURE_THRESHOLD = 10; // 10+ consecutive failures
const DEFUNCT_HOURS_THRESHOLD = 24; // 24+ hours in open state

// Platform URL mapping (health endpoints)
const HEALTH_URLS = {
  clawhub: "https://clawhub.dev/api/health",
  colonysim: "https://colonysim.io/api/status",
  soulmarket: "https://soulmarket.ai/api/health",
  openwork: "https://openwork.ai/api/jobs",
  // General fallback patterns
  default: "/health",
};

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

function getHealthUrl(platformId, registry) {
  // Check hardcoded health URLs first
  const key = platformId.toLowerCase();
  if (HEALTH_URLS[key]) return HEALTH_URLS[key];

  // Try registry test URL
  const account = registry?.accounts?.find(
    (a) => a.id === platformId || a.platform?.toLowerCase() === key
  );
  if (account?.test?.url) return account.test.url;

  return null;
}

async function probeUrl(url) {
  const startTime = Date.now();
  try {
    const result = await safeFetch(url, {
      timeout: PROBE_TIMEOUT,
      bodyMode: "none",
      userAgent: "moltbook-circuit-repair/1.0",
    });

    return {
      reachable: result.status > 0 && result.status < 500,
      status: result.status,
      elapsed: (Date.now() - startTime) / 1000,
      error: result.error || null,
    };
  } catch (err) {
    return {
      reachable: false,
      status: 0,
      elapsed: (Date.now() - startTime) / 1000,
      error: err.message || "unknown",
    };
  }
}

function hoursAgo(isoDate) {
  if (!isoDate) return Infinity;
  const diff = Date.now() - new Date(isoDate).getTime();
  return diff / (1000 * 60 * 60);
}

function hasPriorDefunctEvidence(registry, platformId) {
  const account = registry?.accounts?.find(
    (a) => a.id === platformId || a.platform?.toLowerCase() === platformId.toLowerCase()
  );
  if (!account?.notes) return false;

  const notes = account.notes.toLowerCase();
  return (
    notes.includes("defunct") ||
    notes.includes("dead") ||
    notes.includes("does not resolve") ||
    notes.includes("connection refused") ||
    notes.includes("connection timeout")
  );
}

function shouldMarkDefunct(circuit, registry, platformId, force = false) {
  if (force) return true;

  const failures = circuit.consecutive_failures || 0;
  const hoursOpen = hoursAgo(circuit.opened_at);

  // Standard threshold: 10+ failures AND 24+ hours open
  if (failures >= DEFUNCT_FAILURE_THRESHOLD && hoursOpen >= DEFUNCT_HOURS_THRESHOLD) {
    return true;
  }

  // Accelerated threshold: 5+ failures AND prior evidence of defunct in account-registry
  if (failures >= 5 && hasPriorDefunctEvidence(registry, platformId)) {
    return true;
  }

  return false;
}

function markAccountDefunct(registry, platformId, reason) {
  const account = registry?.accounts?.find(
    (a) => a.id === platformId || a.platform?.toLowerCase() === platformId.toLowerCase()
  );

  if (account) {
    account.last_status = "defunct";
    account.last_tested = new Date().toISOString();
    const existingNotes = account.notes || "";
    const defunctNote = `Auto-defunct s${process.env.SESSION_NUM || "?"}: ${reason}`;
    account.notes = existingNotes
      ? `${existingNotes} | ${defunctNote}`
      : defunctNote;
    return true;
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const dryRun = args.includes("--dry");
  const forceDefunct = args.includes("--force");

  const circuits = loadJSON(CIRCUITS_PATH, {});
  const registry = loadJSON(REGISTRY_PATH, { accounts: [] });
  const now = new Date().toISOString();

  // Find all open circuits
  const openCircuits = Object.entries(circuits).filter(
    ([_id, circuit]) => circuit.status === "open"
  );

  if (openCircuits.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ checked: now, open_count: 0, probed: 0, recovered: 0, defunct: 0 }));
    } else {
      console.log("[circuit-repair] No open circuits to probe.");
    }
    return;
  }

  if (!jsonOutput) {
    console.log(`[circuit-repair] Found ${openCircuits.length} open circuit(s), probing...`);
  }

  const results = [];
  let recovered = 0;
  let defunct = 0;
  let stillOpen = 0;
  let registryUpdated = false;

  for (const [platformId, circuit] of openCircuits) {
    const url = getHealthUrl(platformId, registry);
    if (!url) {
      if (!jsonOutput) {
        console.log(`[?] ${platformId} — no health URL found, skipping`);
      }
      continue;
    }

    const probe = await probeUrl(url);
    const ms = Math.round((probe.elapsed || 0) * 1000);

    if (probe.reachable) {
      // Platform is back! Transition to half-open
      circuit.status = "half-open";
      circuit.half_open_at = now;
      circuit.consecutive_failures = 0;
      delete circuit.last_error;
      recovered++;

      if (!jsonOutput) {
        console.log(`[✓] ${platformId} — RECOVERED (${probe.status} ${ms}ms) → half-open`);
      }

      results.push({
        platform: platformId,
        url,
        action: "recovered",
        status: probe.status,
        elapsed: ms,
        new_state: "half-open",
      });
    } else {
      // Still down — check if we should mark defunct
      circuit.last_probe = now;
      circuit.last_error = probe.error || "unreachable";

      if (shouldMarkDefunct(circuit, registry, platformId, forceDefunct)) {
        // Mark circuit defunct
        circuit.status = "defunct";
        circuit.defunct_at = now;
        circuit.defunct_reason = `${circuit.consecutive_failures} consecutive failures over ${Math.round(hoursAgo(circuit.opened_at))}h`;

        // Update account registry
        const registryReason = `Unreachable (${circuit.consecutive_failures} failures, ${Math.round(hoursAgo(circuit.opened_at))}h)`;
        if (markAccountDefunct(registry, platformId, registryReason)) {
          registryUpdated = true;
        }

        defunct++;

        if (!jsonOutput) {
          console.log(`[☠] ${platformId} — DEFUNCT (${circuit.consecutive_failures} failures, ${Math.round(hoursAgo(circuit.opened_at))}h open)`);
        }

        results.push({
          platform: platformId,
          url,
          action: "defunct",
          failures: circuit.consecutive_failures,
          hours_open: Math.round(hoursAgo(circuit.opened_at)),
          new_state: "defunct",
        });
      } else {
        // Still below threshold
        stillOpen++;

        if (!jsonOutput) {
          const hoursOpen = Math.round(hoursAgo(circuit.opened_at));
          console.log(`[✗] ${platformId} — still down (${circuit.consecutive_failures} failures, ${hoursOpen}h open, need ${DEFUNCT_FAILURE_THRESHOLD}/${DEFUNCT_HOURS_THRESHOLD}h for defunct)`);
        }

        results.push({
          platform: platformId,
          url,
          action: "still_open",
          failures: circuit.consecutive_failures,
          hours_open: Math.round(hoursAgo(circuit.opened_at)),
          error: probe.error,
        });
      }
    }
  }

  // Save updates
  if (!dryRun) {
    if (recovered > 0 || defunct > 0) {
      saveJSON(CIRCUITS_PATH, circuits);
    }
    if (registryUpdated) {
      saveJSON(REGISTRY_PATH, registry);
    }
  }

  // Log to file
  if (!dryRun && results.length > 0) {
    const logPath = join(STATE_DIR, "logs/circuit-repair.log");
    const logEntry = `${now} probed=${results.length} recovered=${recovered} defunct=${defunct} still_open=${stillOpen}\n`;
    try {
      const existing = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      const lines = existing.trim().split("\n").filter(Boolean).slice(-99);
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
        probed: results.length,
        recovered,
        defunct,
        still_open: stillOpen,
        results,
      }, null, 2)
    );
  } else {
    console.log(`\n--- Circuit Repair Summary ---`);
    console.log(`Open circuits: ${openCircuits.length} | Probed: ${results.length}`);
    console.log(`Recovered: ${recovered} | Defunct: ${defunct} | Still open: ${stillOpen}`);
    if (registryUpdated) {
      console.log(`Registry updated: ${defunct} platform(s) marked defunct`);
    }
    if (dryRun) console.log("(dry run — files not updated)");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

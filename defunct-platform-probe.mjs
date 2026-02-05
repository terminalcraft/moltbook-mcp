#!/usr/bin/env node
/**
 * defunct-platform-probe.mjs — Periodic re-check of defunct platforms.
 *
 * Platforms marked defunct stay that way forever without intervention.
 * This script probes defunct platforms to detect if they've come back online.
 * If a defunct platform responds successfully, it's transitioned to half-open
 * for trial re-engagement.
 *
 * Usage:
 *   node defunct-platform-probe.mjs          # Probe defunct platforms
 *   node defunct-platform-probe.mjs --json   # Machine-readable output
 *   node defunct-platform-probe.mjs --dry    # Don't update files
 *
 * R#184: Defunct platform recovery workflow (addresses wq-333 brainstorming idea)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { safeFetch } from "./lib/safe-fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_PATH = join(__dirname, "platform-circuits.json");
const REGISTRY_PATH = join(__dirname, "account-registry.json");
const STATE_DIR = join(process.env.HOME, ".config/moltbook");
const PROBE_TIMEOUT = 8000;

// Health endpoints for platforms (same as open-circuit-repair.mjs)
const HEALTH_URLS = {
  clawhub: "https://clawhub.dev/api/health",
  colonysim: "https://colonysim.io/api/status",
  soulmarket: "https://soulmarket.ai/api/health",
  openwork: "https://openwork.ai/api/jobs",
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
  const key = platformId.toLowerCase();
  if (HEALTH_URLS[key]) return HEALTH_URLS[key];

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
      userAgent: "moltbook-defunct-probe/1.0",
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

function daysSince(isoDate) {
  if (!isoDate) return Infinity;
  const diff = Date.now() - new Date(isoDate).getTime();
  return diff / (1000 * 60 * 60 * 24);
}

function resurrectCircuit(circuit, now) {
  // Transition from defunct to half-open for trial
  circuit.status = "half-open";
  circuit.half_open_at = now;
  circuit.resurrected_at = now;
  circuit.consecutive_failures = 0;
  delete circuit.last_error;
  // Keep defunct_at/defunct_reason for audit trail
}

function updateAccountRecovered(registry, platformId) {
  const account = registry?.accounts?.find(
    (a) => a.id === platformId || a.platform?.toLowerCase() === platformId.toLowerCase()
  );

  if (account) {
    account.last_status = "recovered";
    account.last_tested = new Date().toISOString();
    const existingNotes = account.notes || "";
    const recoveredNote = `Auto-resurrected s${process.env.SESSION_NUM || "?"}: platform back online`;
    account.notes = existingNotes
      ? `${existingNotes} | ${recoveredNote}`
      : recoveredNote;
    return true;
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const dryRun = args.includes("--dry");

  const circuits = loadJSON(CIRCUITS_PATH, {});
  const registry = loadJSON(REGISTRY_PATH, { accounts: [] });
  const now = new Date().toISOString();

  // Find all defunct circuits
  const defunctCircuits = Object.entries(circuits).filter(
    ([_id, circuit]) => circuit.status === "defunct" || circuit.state === "defunct"
  );

  if (defunctCircuits.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ checked: now, defunct_count: 0, probed: 0, recovered: 0 }));
    } else {
      console.log("[defunct-probe] No defunct platforms to check.");
    }
    return;
  }

  if (!jsonOutput) {
    console.log(`[defunct-probe] Found ${defunctCircuits.length} defunct platform(s), probing...`);
  }

  const results = [];
  let recovered = 0;
  let stillDefunct = 0;
  let registryUpdated = false;

  for (const [platformId, circuit] of defunctCircuits) {
    const url = getHealthUrl(platformId, registry);
    if (!url) {
      if (!jsonOutput) {
        console.log(`[?] ${platformId} — no health URL found, skipping`);
      }
      continue;
    }

    const probe = await probeUrl(url);
    const ms = Math.round((probe.elapsed || 0) * 1000);
    const defunctDays = Math.round(daysSince(circuit.defunct_at || circuit.opened_at));

    if (probe.reachable) {
      // Platform is back! Resurrect it
      resurrectCircuit(circuit, now);

      if (updateAccountRecovered(registry, platformId)) {
        registryUpdated = true;
      }

      recovered++;

      if (!jsonOutput) {
        console.log(`[✓] ${platformId} — RESURRECTED after ${defunctDays}d defunct (${probe.status} ${ms}ms) → half-open`);
      }

      results.push({
        platform: platformId,
        url,
        action: "resurrected",
        status: probe.status,
        elapsed: ms,
        defunct_days: defunctDays,
        new_state: "half-open",
      });
    } else {
      // Still defunct
      circuit.last_probe = now;
      circuit.last_error = probe.error || "unreachable";
      stillDefunct++;

      if (!jsonOutput) {
        console.log(`[✗] ${platformId} — still defunct (${defunctDays}d, error: ${probe.error || 'unreachable'})`);
      }

      results.push({
        platform: platformId,
        url,
        action: "still_defunct",
        defunct_days: defunctDays,
        error: probe.error,
      });
    }
  }

  // Save updates
  if (!dryRun) {
    if (recovered > 0 || stillDefunct > 0) {
      saveJSON(CIRCUITS_PATH, circuits);
    }
    if (registryUpdated) {
      saveJSON(REGISTRY_PATH, registry);
    }
  }

  // Log to file
  if (!dryRun && results.length > 0) {
    const logPath = join(STATE_DIR, "logs/defunct-probe.log");
    const logEntry = `${now} probed=${results.length} recovered=${recovered} still_defunct=${stillDefunct}\n`;
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
        defunct_count: defunctCircuits.length,
        probed: results.length,
        recovered,
        still_defunct: stillDefunct,
        results,
      }, null, 2)
    );
  } else {
    console.log(`\n--- Defunct Platform Probe Summary ---`);
    console.log(`Defunct platforms: ${defunctCircuits.length} | Probed: ${results.length}`);
    console.log(`Recovered: ${recovered} | Still defunct: ${stillDefunct}`);
    if (registryUpdated) {
      console.log(`Registry updated: ${recovered} platform(s) marked recovered`);
    }
    if (dryRun) console.log("(dry run — files not updated)");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

#!/usr/bin/env node
// platform-health.mjs — Quick platform liveness pre-check for E sessions (wq-304)
// Shows which platforms have open circuits and recent failures
// Run: node platform-health.mjs

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_PATH = join(__dirname, "platform-circuits.json");
const REGISTRY_PATH = join(__dirname, "account-registry.json");

function loadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

function main() {
  const circuits = loadJSON(CIRCUITS_PATH) || {};
  const registry = loadJSON(REGISTRY_PATH);

  const openCircuits = [];
  const halfOpen = [];
  const degraded = [];

  for (const [platformId, entry] of Object.entries(circuits)) {
    if (entry.status === "open") {
      openCircuits.push({
        platform: platformId,
        failures: entry.consecutive_failures,
        lastError: entry.last_error || "unknown",
        lastFailure: entry.last_failure
      });
    } else if (entry.status === "half-open") {
      halfOpen.push({
        platform: platformId,
        failures: entry.consecutive_failures,
        lastError: entry.last_error || "unknown"
      });
    } else if (entry.consecutive_failures >= 2) {
      // Track platforms that are showing signs of trouble
      degraded.push({
        platform: platformId,
        failures: entry.consecutive_failures
      });
    }
  }

  // Also check registry for auth issues
  const authIssues = [];
  if (registry && registry.accounts) {
    for (const acc of registry.accounts) {
      if (["no_creds", "bad_creds", "error"].includes(acc.last_status)) {
        authIssues.push({
          platform: acc.id,
          status: acc.last_status,
          notes: acc.notes?.slice(0, 50) || ""
        });
      }
    }
  }

  // Output summary
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              PLATFORM HEALTH PRE-CHECK                       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  if (openCircuits.length === 0 && halfOpen.length === 0 && authIssues.length === 0) {
    console.log("✓ All platforms healthy. No open circuits or auth issues.");
    console.log();
    return;
  }

  if (openCircuits.length > 0) {
    console.log(`🔴 OPEN CIRCUITS (${openCircuits.length}) — Skip these platforms:`);
    for (const c of openCircuits) {
      const lastFailure = c.lastFailure ? new Date(c.lastFailure).toISOString().slice(0, 16) : "unknown";
      console.log(`   • ${c.platform}: ${c.failures} consecutive failures (${c.lastError}) [${lastFailure}]`);
    }
    console.log();
  }

  if (halfOpen.length > 0) {
    console.log(`🟡 HALF-OPEN (${halfOpen.length}) — May work, probe carefully:`);
    for (const c of halfOpen) {
      console.log(`   • ${c.platform}: ${c.failures} failures, recovering (${c.lastError})`);
    }
    console.log();
  }

  if (authIssues.length > 0) {
    console.log(`⚠️  AUTH ISSUES (${authIssues.length}) — Need credential attention:`);
    for (const a of authIssues) {
      console.log(`   • ${a.platform}: ${a.status}${a.notes ? ` — ${a.notes}` : ""}`);
    }
    console.log();
  }

  if (degraded.length > 0) {
    console.log(`📉 DEGRADED (${degraded.length}) — Showing instability:`);
    for (const d of degraded) {
      console.log(`   • ${d.platform}: ${d.failures} recent failures`);
    }
    console.log();
  }

  console.log("─────────────────────────────────────────────────────────────────");
  console.log("Recommendation: platform-picker.mjs already excludes open circuits.");
  console.log("Focus engagement on picker selections; skip manual probes to open circuits.");
}

main();

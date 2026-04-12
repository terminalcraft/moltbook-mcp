#!/usr/bin/env node
/**
 * lint-circuits.mjs — Validate platform-circuits.json for metadata drift.
 *
 * Checks:
 * 1. Entries with consecutive_failures >= threshold must have status === "closed"
 * 2. Entries with status === "closed" but consecutive_failures < threshold (stale closure)
 *
 * Exit codes: 0 = clean, 1 = violations found, 2 = file error
 *
 * Usage:
 *   node lint-circuits.mjs           # lint and report
 *   node lint-circuits.mjs --fix     # auto-fix missing status fields
 *   node lint-circuits.mjs --json    # output as JSON for programmatic use
 */

import { loadCircuits, saveCircuits, CIRCUIT_FAILURE_THRESHOLD } from "./lib/circuit-breaker.mjs";

const args = process.argv.slice(2);
const fix = args.includes("--fix");
const json = args.includes("--json");

let circuits;
try {
  circuits = loadCircuits();
} catch (e) {
  console.error("Failed to load platform-circuits.json:", e.message);
  process.exit(2);
}

const violations = [];
const warnings = [];
let fixed = 0;

for (const [platform, entry] of Object.entries(circuits)) {
  const failures = entry.consecutive_failures || 0;
  const status = entry.status;

  // Violation: high failures but not marked closed
  if (failures >= CIRCUIT_FAILURE_THRESHOLD && status !== "closed") {
    violations.push({
      platform,
      type: "missing_closure",
      consecutive_failures: failures,
      status: status || "(none)",
      message: `${platform}: ${failures} consecutive failures but status=${status || "(none)"}, expected "closed"`
    });

    if (fix) {
      entry.status = "closed";
      entry.notes = `${entry.notes ? entry.notes + " " : ""}[lint-circuits: auto-closed at ${failures} consecutive failures]`;
      fixed++;
    }
  }

  // Warning: closed but failures reset (stale closure — may need manual review)
  if (status === "closed" && failures < CIRCUIT_FAILURE_THRESHOLD) {
    warnings.push({
      platform,
      type: "stale_closure",
      consecutive_failures: failures,
      message: `${platform}: status="closed" but only ${failures} consecutive failures (below threshold ${CIRCUIT_FAILURE_THRESHOLD})`
    });
  }
}

if (fix && fixed > 0) {
  saveCircuits(circuits);
}

// Output
if (json) {
  console.log(JSON.stringify({ violations, warnings, fixed, threshold: CIRCUIT_FAILURE_THRESHOLD }, null, 2));
} else {
  if (violations.length === 0 && warnings.length === 0) {
    console.log(`lint-circuits: OK (${Object.keys(circuits).length} platforms, threshold=${CIRCUIT_FAILURE_THRESHOLD})`);
  } else {
    if (violations.length > 0) {
      console.log(`VIOLATIONS (${violations.length}): consecutive_failures >= ${CIRCUIT_FAILURE_THRESHOLD} without status="closed"`);
      for (const v of violations) console.log(`  - ${v.message}`);
      if (fix) console.log(`  Fixed ${fixed} entries.`);
    }
    if (warnings.length > 0) {
      console.log(`WARNINGS (${warnings.length}): status="closed" with low consecutive_failures`);
      for (const w of warnings) console.log(`  - ${w.message}`);
    }
  }
}

process.exit(violations.length > 0 && !fix ? 1 : 0);

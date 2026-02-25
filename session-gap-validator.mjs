#!/usr/bin/env node
/**
 * session-gap-validator.mjs — Detect session gaps and flag stale state
 *
 * After gaps >24h, platform health, circuit breakers, and engagement state
 * can all be stale. This script detects the gap and checks freshness of
 * critical state files, reporting what needs refresh.
 *
 * wq-599: Prevents silent operation on stale data after long gaps.
 *
 * Usage:
 *   node session-gap-validator.mjs              # Check and report
 *   node session-gap-validator.mjs --json       # JSON output
 *   node session-gap-validator.mjs --threshold 12  # Custom gap threshold (hours)
 *
 * Exit codes:
 *   0 = no gap or all fresh
 *   1 = gap detected with stale state (informational)
 */

import { readFileSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(process.env.HOME || "/home/moltbot", ".config/moltbook");
const HISTORY_PATH = join(STATE_DIR, "session-history.txt");

// --- Gap detection ---

/**
 * Parse session-history.txt and find the most recent gap.
 * Format: "2026-02-24 mode=B s=1486 dur=..."
 * Returns { gapHours, lastDate, currentDate, lastSession, gapDetected }
 */
function detectGap(thresholdHours = 24) {
  if (!existsSync(HISTORY_PATH)) {
    return { gapDetected: false, reason: "no_history_file" };
  }

  const lines = readFileSync(HISTORY_PATH, "utf8")
    .trim().split("\n")
    .filter(l => l.length > 0);

  if (lines.length < 2) {
    return { gapDetected: false, reason: "insufficient_history" };
  }

  // Parse dates from last two entries
  const parseLine = (line) => {
    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/);
    const sessionMatch = line.match(/s=(\d+)/);
    return {
      date: dateMatch ? dateMatch[1] : null,
      session: sessionMatch ? parseInt(sessionMatch[1]) : null,
    };
  };

  const last = parseLine(lines[lines.length - 1]);
  const secondLast = parseLine(lines[lines.length - 2]);

  if (!last.date || !secondLast.date) {
    return { gapDetected: false, reason: "unparseable_dates" };
  }

  const lastDate = new Date(last.date + "T00:00:00Z");
  const secondLastDate = new Date(secondLast.date + "T00:00:00Z");
  const now = new Date();

  // Check gap between last two entries
  const interSessionGapMs = lastDate.getTime() - secondLastDate.getTime();
  const interSessionGapHours = interSessionGapMs / (1000 * 60 * 60);

  // Also check gap since last session (current time vs last entry)
  const sinceLastMs = now.getTime() - lastDate.getTime();
  const sinceLastHours = sinceLastMs / (1000 * 60 * 60);

  // Use the larger gap
  const gapHours = Math.max(interSessionGapHours, sinceLastHours);
  const gapSource = sinceLastHours > interSessionGapHours ? "since_last" : "inter_session";

  return {
    gapDetected: gapHours >= thresholdHours,
    gapHours: Math.round(gapHours * 10) / 10,
    gapSource,
    thresholdHours,
    lastDate: last.date,
    lastSession: last.session,
    secondLastDate: secondLast.date,
    secondLastSession: secondLast.session,
  };
}

// --- Freshness checks ---

/**
 * Check file modification time against a threshold.
 * Returns { path, exists, ageHours, stale, lastModified }
 */
function checkFileFreshness(filePath, maxAgeHours) {
  if (!existsSync(filePath)) {
    return { path: filePath, exists: false, stale: true, reason: "missing" };
  }

  const stat = statSync(filePath);
  const ageMs = Date.now() - stat.mtime.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  return {
    path: filePath,
    exists: true,
    ageHours: Math.round(ageHours * 10) / 10,
    stale: ageHours > maxAgeHours,
    lastModified: stat.mtime.toISOString(),
  };
}

/**
 * Check JSON file for internal timestamps.
 * Looks for common timestamp fields and reports their age.
 */
function checkJsonTimestamps(filePath, fieldNames) {
  if (!existsSync(filePath)) return null;

  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    const results = {};

    for (const field of fieldNames) {
      // Support dotted paths like "events[0].timestamp"
      let val = data;
      for (const part of field.split(".")) {
        if (val == null) break;
        if (part.match(/^\d+$/)) val = val[parseInt(part)];
        else val = val[part];
      }

      if (typeof val === "string" && val.match(/^\d{4}-/)) {
        const ts = new Date(val);
        const ageHours = (Date.now() - ts.getTime()) / (1000 * 60 * 60);
        results[field] = { value: val, ageHours: Math.round(ageHours * 10) / 10 };
      }
    }

    return results;
  } catch {
    return null;
  }
}

/**
 * Run all freshness checks and return a structured report.
 * @param {number} gapHours - Size of gap to calibrate staleness thresholds
 */
function runFreshnessChecks(gapHours) {
  const staleItems = [];
  const freshItems = [];

  // Threshold: if gap is large, be strict; small gaps are more lenient
  const maxAge = Math.max(gapHours, 24);

  // 1. Platform circuits — last_success/last_failure timestamps
  const circuitsPath = join(__dirname, "platform-circuits.json");
  const circuitCheck = checkFileFreshness(circuitsPath, maxAge);
  (circuitCheck.stale ? staleItems : freshItems).push({
    name: "platform-circuits.json",
    ...circuitCheck,
    action: circuitCheck.stale ? "Circuit breaker states may be outdated — run circuit-reset-probe" : null,
  });

  // 2. Engagement state — seen/voted arrays
  const engStatePath = join(STATE_DIR, "engagement-state.json");
  const engCheck = checkFileFreshness(engStatePath, maxAge);
  (engCheck.stale ? staleItems : freshItems).push({
    name: "engagement-state.json",
    ...engCheck,
    action: engCheck.stale ? "Engagement seen/voted lists may miss new content — next E session should do full scan" : null,
  });

  // 3. Engagement trace — last interaction
  const tracePath = join(STATE_DIR, "engagement-trace.json");
  const traceCheck = checkFileFreshness(tracePath, maxAge);
  (traceCheck.stale ? staleItems : freshItems).push({
    name: "engagement-trace.json",
    ...traceCheck,
    action: traceCheck.stale ? "Engagement trace is old — interaction continuity may be broken" : null,
  });

  // 4. Account registry — last_tested timestamps
  const registryPath = join(__dirname, "account-registry.json");
  const regCheck = checkFileFreshness(registryPath, maxAge);
  (regCheck.stale ? staleItems : freshItems).push({
    name: "account-registry.json",
    ...regCheck,
    action: regCheck.stale ? "Platform registry probe data is stale — platforms may have changed status" : null,
  });

  // 5. Side-effect history (from wq-593)
  const sideEffectPath = join(STATE_DIR, "probe-side-effects.json");
  const seCheck = checkFileFreshness(sideEffectPath, maxAge * 2); // less critical
  (seCheck.stale ? staleItems : freshItems).push({
    name: "probe-side-effects.json",
    ...seCheck,
    action: seCheck.stale ? "Side-effect baselines are old — behavioral drift detection less reliable" : null,
  });

  // 6. Cost history — budget tracking
  const costPath = join(STATE_DIR, "cost-history.json");
  const costCheck = checkFileFreshness(costPath, maxAge);
  (costCheck.stale ? staleItems : freshItems).push({
    name: "cost-history.json",
    ...costCheck,
    action: costCheck.stale ? "Cost tracking data is stale — budget estimates may be off" : null,
  });

  // 7. Circuit recovery events — latest event timestamp
  const recoveryPath = join(STATE_DIR, "circuit-recovery-events.json");
  const recoveryTs = checkJsonTimestamps(recoveryPath, ["events.0.timestamp"]);
  if (recoveryTs?.["events.0.timestamp"]) {
    const age = recoveryTs["events.0.timestamp"].ageHours;
    const stale = age > maxAge;
    (stale ? staleItems : freshItems).push({
      name: "circuit-recovery-events (latest event)",
      ageHours: age,
      stale,
      action: stale ? "No recent circuit recovery events — probes may be stuck" : null,
    });
  }

  return { staleItems, freshItems, totalChecked: staleItems.length + freshItems.length };
}

// --- Main ---

function validate(options = {}) {
  const threshold = options.threshold || 24;
  const gap = detectGap(threshold);

  const report = {
    timestamp: new Date().toISOString(),
    session: process.env.SESSION_NUM || "?",
    gap,
    checks: null,
    summary: "",
  };

  if (!gap.gapDetected) {
    report.summary = `No gap detected (threshold: ${threshold}h). State assumed fresh.`;
    report.checks = { staleItems: [], freshItems: [], totalChecked: 0 };
    return report;
  }

  // Gap detected — run freshness checks
  report.checks = runFreshnessChecks(gap.gapHours);
  const staleCount = report.checks.staleItems.length;
  const total = report.checks.totalChecked;

  report.summary = `Gap of ${gap.gapHours}h detected (${gap.gapSource}: s${gap.lastSession || "?"} on ${gap.lastDate}). ${staleCount}/${total} state files are stale.`;

  return report;
}

// --- Exports ---
export { detectGap, checkFileFreshness, checkJsonTimestamps, runFreshnessChecks, validate };

// --- CLI (only runs when executed directly) ---
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const thresholdIdx = args.indexOf("--threshold");
  const threshold = thresholdIdx >= 0 ? parseFloat(args[thresholdIdx + 1]) || 24 : 24;

  if (args.includes("--help")) {
    console.log("Usage:");
    console.log("  node session-gap-validator.mjs              # Check and report");
    console.log("  node session-gap-validator.mjs --json       # JSON output");
    console.log("  node session-gap-validator.mjs --threshold 12  # Custom gap (hours)");
  } else {
    const report = validate({ threshold });

    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\n=== Session Gap Validator ===\n`);
      console.log(report.summary);

      if (report.gap.gapDetected && report.checks.staleItems.length > 0) {
        console.log(`\nStale state (${report.checks.staleItems.length} items):`);
        for (const item of report.checks.staleItems) {
          const age = item.ageHours ? `${item.ageHours}h old` : item.reason || "unknown";
          console.log(`  ! ${item.name}: ${age}`);
          if (item.action) console.log(`    → ${item.action}`);
        }
      }

      if (report.checks.freshItems?.length > 0) {
        console.log(`\nFresh state (${report.checks.freshItems.length} items):`);
        for (const item of report.checks.freshItems) {
          console.log(`  ✓ ${item.name}: ${item.ageHours}h old`);
        }
      }
    }

    // Exit 1 if stale items found (informational, not error)
    if (report.gap.gapDetected && report.checks.staleItems.length > 0) {
      process.exit(1);
    }
  }
}

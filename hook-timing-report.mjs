#!/usr/bin/env node
/**
 * hook-timing-report.mjs — Analyze hook execution timing from tracking results.
 *
 * Reads pre-hook-results.json and hook-results.json to report:
 * - Per-hook P50/P95/max latencies
 * - Hooks exceeding regression threshold (default 3000ms)
 * - Trend direction (improving/stable/degrading)
 *
 * Usage:
 *   node hook-timing-report.mjs                # Human-readable summary
 *   node hook-timing-report.mjs --json         # Machine-readable JSON
 *   node hook-timing-report.mjs --threshold N  # Custom regression threshold (ms)
 *   node hook-timing-report.mjs --last N       # Analyze last N sessions (default 20)
 *
 * Created: B#520 (wq-791)
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_DIR = join(homedir(), ".config", "moltbook", "logs");
const PRE_RESULTS = join(LOG_DIR, "pre-hook-results.json");
const POST_RESULTS = join(LOG_DIR, "hook-results.json");

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const thresholdIdx = args.indexOf("--threshold");
const THRESHOLD_MS = thresholdIdx !== -1 ? parseInt(args[thresholdIdx + 1]) || 3000 : 3000;
const lastIdx = args.indexOf("--last");
const LAST_N = lastIdx !== -1 ? parseInt(args[lastIdx + 1]) || 20 : 20;

function loadResults(path) {
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function analyze(entries, phase) {
  // Collect per-hook timing data
  const hookTimings = {}; // hookName -> [ms values]

  for (const entry of entries) {
    if (!entry.hooks) continue;
    for (const h of entry.hooks) {
      if (!h.hook || h.status === "budget_skip") continue;
      if (!hookTimings[h.hook]) hookTimings[h.hook] = [];
      hookTimings[h.hook].push(h.ms || 0);
    }
  }

  const results = [];
  for (const [hook, timings] of Object.entries(hookTimings)) {
    const sorted = [...timings].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const max = sorted[sorted.length - 1] || 0;
    const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);

    // Trend: compare first half vs second half
    const mid = Math.floor(timings.length / 2);
    let trend = "stable";
    if (timings.length >= 4) {
      const firstHalf = timings.slice(0, mid);
      const secondHalf = timings.slice(mid);
      const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
      const pctChange = ((avgSecond - avgFirst) / Math.max(avgFirst, 1)) * 100;
      if (pctChange > 25) trend = "degrading";
      else if (pctChange < -25) trend = "improving";
    }

    const regression = p95 > THRESHOLD_MS;

    results.push({
      hook,
      phase,
      samples: timings.length,
      avg,
      p50,
      p95,
      max,
      trend,
      regression,
    });
  }

  return results.sort((a, b) => b.p95 - a.p95);
}

/**
 * Run the full timing report and return structured results.
 * @param {object} [opts] - Options
 * @param {number} [opts.threshold] - Regression threshold in ms (default 3000)
 * @param {number} [opts.last] - Number of sessions to analyze (default 20)
 * @returns {object} Report data
 */
export function report(opts = {}) {
  const threshold = opts.threshold || THRESHOLD_MS;
  const lastN = opts.last || LAST_N;

  const preEntries = loadResults(PRE_RESULTS).slice(-lastN);
  const postEntries = loadResults(POST_RESULTS).slice(-lastN);

  const preResults = analyze(preEntries, "pre");
  const postResults = analyze(postEntries, "post");
  const allResults = [...preResults, ...postResults];

  // Re-evaluate regression with provided threshold
  for (const r of allResults) {
    r.regression = r.p95 > threshold;
  }
  const regressions = allResults.filter(r => r.regression);

  return {
    threshold_ms: threshold,
    sessions_analyzed: lastN,
    pre_sessions: preEntries.length,
    post_sessions: postEntries.length,
    total_hooks: allResults.length,
    regressions: regressions.length,
    hooks: allResults,
  };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('hook-timing-report.mjs')) {
  const result = report({ threshold: THRESHOLD_MS, last: LAST_N });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Hook Timing Report (last ${result.sessions_analyzed} sessions, threshold ${result.threshold_ms}ms)\n`);

    const regressions = result.hooks.filter(r => r.regression);
    if (regressions.length > 0) {
      console.log(`REGRESSIONS (P95 > ${result.threshold_ms}ms):`);
      for (const r of regressions) {
        console.log(`  [${r.phase}] ${r.hook}: P95=${r.p95}ms max=${r.max}ms avg=${r.avg}ms (${r.trend})`);
      }
      console.log();
    }

    for (const phase of ["pre", "post"]) {
      const phaseResults = result.hooks.filter(r => r.phase === phase);
      if (phaseResults.length === 0) continue;
      console.log(`${phase.toUpperCase()}-SESSION HOOKS (${phaseResults.length} hooks):`);
      for (const r of phaseResults.slice(0, 10)) {
        const flag = r.regression ? " !!!" : "";
        const arrow = r.trend === "improving" ? " ↓" : r.trend === "degrading" ? " ↑" : "";
        console.log(`  ${r.hook}: avg=${r.avg}ms P50=${r.p50}ms P95=${r.p95}ms max=${r.max}ms (n=${r.samples})${arrow}${flag}`);
      }
      if (phaseResults.length > 10) {
        console.log(`  ... and ${phaseResults.length - 10} more hooks`);
      }
      console.log();
    }

    if (regressions.length === 0) {
      console.log("No regressions detected.");
    }
  }
}

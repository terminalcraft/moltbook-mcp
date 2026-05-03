#!/usr/bin/env node
// timing-summary.mjs — Compute P50/P95/P99 per hook from periodic-check-timing.jsonl
// Usage: node timing-summary.mjs [--last N] [--json] [--slow THRESHOLD_MS]
// Supports d079 tracking: identifies hooks exceeding the slow threshold.

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TIMING_FILE = join(homedir(), '.config/moltbook/periodic-check-timing.jsonl');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { last: 20, json: false, slow: 500 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--last' && args[i + 1]) opts.last = parseInt(args[++i]);
    if (args[i] === '--json') opts.json = true;
    if (args[i] === '--slow' && args[i + 1]) opts.slow = parseInt(args[++i]);
  }
  return opts;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function run() {
  const opts = parseArgs();

  let raw;
  try {
    raw = readFileSync(TIMING_FILE, 'utf8');
  } catch {
    console.error(`Cannot read ${TIMING_FILE}`);
    process.exit(1);
  }

  const lines = raw.trim().split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }

  // Find the last N unique sessions
  const allSessions = [...new Set(entries.map(e => e.session))].sort((a, b) => a - b);
  const recentSessions = new Set(allSessions.slice(-opts.last));

  // Filter to recent sessions, exclude _total
  const recent = entries.filter(e => recentSessions.has(e.session) && e.check !== '_total');

  // Group by check name
  const byCheck = {};
  for (const e of recent) {
    if (!byCheck[e.check]) byCheck[e.check] = [];
    byCheck[e.check].push(e);
  }

  const results = [];
  for (const [check, samples] of Object.entries(byCheck)) {
    const times = samples.map(s => s.ms).sort((a, b) => a - b);
    const timeouts = samples.filter(s => s.timeout).length;
    const p50 = percentile(times, 50);
    const p95 = percentile(times, 95);
    const p99 = percentile(times, 99);
    const slow = p95 > opts.slow;
    results.push({
      check, count: times.length, timeouts,
      p50, p95, p99, slow,
      min: times[0], max: times[times.length - 1]
    });
  }

  // Sort: slow hooks first, then by P95 descending
  results.sort((a, b) => (b.slow - a.slow) || (b.p95 - a.p95));

  // d079 summary
  const slowCount = results.filter(r => r.slow).length;
  const totalChecks = results.length;
  const sessionRange = allSessions.length > 0
    ? `s${allSessions[Math.max(0, allSessions.length - opts.last)]}–s${allSessions[allSessions.length - 1]}`
    : 'none';

  if (opts.json) {
    console.log(JSON.stringify({
      sessions: recentSessions.size,
      sessionRange,
      slowThreshold: opts.slow,
      slowHooks: slowCount,
      target: 2,
      d079Pass: slowCount <= 2,
      checks: results
    }, null, 2));
    return;
  }

  // Table output
  console.log(`Hook Timing Summary (last ${recentSessions.size} sessions: ${sessionRange})`);
  console.log(`Slow threshold: ${opts.slow}ms | d079 target: ≤2 slow hooks | Current: ${slowCount}/${totalChecks} slow\n`);

  const header = 'Check'.padEnd(22) + 'N'.padStart(5) + 'T/O'.padStart(5)
    + 'P50'.padStart(8) + 'P95'.padStart(8) + 'P99'.padStart(8)
    + 'Min'.padStart(8) + 'Max'.padStart(8) + '  Status';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const r of results) {
    const status = r.slow ? 'SLOW' : 'ok';
    const line = r.check.padEnd(22)
      + String(r.count).padStart(5)
      + String(r.timeouts).padStart(5)
      + `${r.p50}ms`.padStart(8)
      + `${r.p95}ms`.padStart(8)
      + `${r.p99}ms`.padStart(8)
      + `${r.min}ms`.padStart(8)
      + `${r.max}ms`.padStart(8)
      + `  ${status}`;
    console.log(line);
  }

  console.log(`\nd079 status: ${slowCount <= 2 ? 'PASS' : 'FAIL'} (${slowCount} slow hooks, target ≤2)`);
}

run();

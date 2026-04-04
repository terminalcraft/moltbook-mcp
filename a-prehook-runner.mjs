#!/usr/bin/env node
/**
 * a-prehook-runner.mjs — Single-process runner for A session prehook checks.
 *
 * Replaces 5 separate `node` subprocess invocations in 35-a-session-prehook_A.sh,
 * eliminating ~500-1000ms Node startup overhead per call.
 *
 * Imports and runs:
 *   1. b-cost-trend.mjs      → analyze()
 *   2. r-cost-monitor.mjs    → analyze()
 *   3. hook-timing-report.mjs → report()
 *   4. stale-tag-remediate.mjs → remediate()
 *   5. audit-cost-escalation.mjs → run()
 *
 * Output: JSON with results from all 5 modules.
 * Usage: node a-prehook-runner.mjs [--apply-stale-tags]
 *
 * Created: wq-971 (B#624)
 */

import { analyze as bCostAnalyze } from './b-cost-trend.mjs';
import { analyze as rCostAnalyze } from './r-cost-monitor.mjs';
import { report as hookTimingReport } from './hook-timing-report.mjs';
import { remediate } from './stale-tag-remediate.mjs';
import { run as costEscalation } from './audit-cost-escalation.mjs';
import { autoRetireStuckItems } from './audit-stats.mjs';

const applyTags = process.argv.includes('--apply-stale-tags');

function safeRun(label, fn) {
  try {
    return { ok: true, result: fn() };
  } catch (e) {
    return { ok: false, error: `${label}: ${(e.message || 'unknown').slice(0, 200)}` };
  }
}

// Run all 5 checks
const bCost = safeRun('b-cost-trend', () => bCostAnalyze());
const rCost = safeRun('r-cost-monitor', () => rCostAnalyze());
const hookTiming = safeRun('hook-timing-report', () => hookTimingReport({ last: 10 }));

// stale-tag-remediate: suppress stdout, capture return value
const staleTagResult = safeRun('stale-tag-remediate', () => {
  const origLog = console.log;
  const origError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    // Build argv for remediate: --json and optionally --apply
    const argv = ['node', 'stale-tag-remediate.mjs', '--json'];
    if (applyTags) argv.push('--apply');
    return remediate(argv, { exit: () => {} });
  } finally {
    console.log = origLog;
    console.error = origError;
  }
});

const costEsc = safeRun('audit-cost-escalation', () => costEscalation());

// wq-979: Auto-retire pending queue items stuck for >50 sessions
const autoRetire = safeRun('auto-retire-stuck', () => autoRetireStuckItems());

const output = {
  b_cost_trend: bCost.ok ? bCost.result : { error: bCost.error },
  r_cost_monitor: rCost.ok ? rCost.result : { error: rCost.error },
  hook_timing: hookTiming.ok ? hookTiming.result : { error: hookTiming.error },
  stale_tag_remediate: staleTagResult.ok ? staleTagResult.result : { error: staleTagResult.error },
  cost_escalation: costEsc.ok ? costEsc.result : { error: costEsc.error },
  auto_retire: autoRetire.ok ? autoRetire.result : { error: autoRetire.error },
};

console.log(JSON.stringify(output));

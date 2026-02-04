#!/usr/bin/env node
/**
 * hook-diagnostics.mjs — Hook performance visibility tool (wq-196)
 *
 * Parses pre-hook-results.json and hook-results.json to report:
 * - Slowest hooks by average/max duration
 * - Failure rates per hook
 * - Hooks that haven't succeeded in N sessions
 * - Anomalies: sudden perf degradation, intermittent failures
 *
 * Usage: node hook-diagnostics.mjs [--json] [--threshold-ms=1000] [--failure-window=20]
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || path.join(process.env.HOME, '.config/moltbook/logs');
const PRE_HOOK_FILE = path.join(LOG_DIR, 'pre-hook-results.json');
const POST_HOOK_FILE = path.join(LOG_DIR, 'hook-results.json');

// CLI args
const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const thresholdMs = parseInt(args.find(a => a.startsWith('--threshold-ms='))?.split('=')[1]) || 1000;
const failureWindow = parseInt(args.find(a => a.startsWith('--failure-window='))?.split('=')[1]) || 20;

function loadResults(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.trim().split('\n').map(line => JSON.parse(line));
  } catch (e) {
    return [];
  }
}

function analyzeHooks(entries, phase) {
  const hookStats = new Map();

  for (const entry of entries) {
    const session = entry.session;
    for (const hook of (entry.hooks || [])) {
      const name = hook.hook;
      if (!hookStats.has(name)) {
        hookStats.set(name, {
          name,
          phase,
          runs: [],
          failures: [],
          lastSuccess: null,
          lastFailure: null
        });
      }
      const stats = hookStats.get(name);
      stats.runs.push({ session, ms: hook.ms, status: hook.status });

      if (hook.status === 'ok') {
        stats.lastSuccess = session;
      } else {
        stats.failures.push({ session, status: hook.status, ms: hook.ms });
        stats.lastFailure = session;
      }
    }
  }

  return hookStats;
}

function computeMetrics(hookStats, latestSession) {
  const results = [];

  for (const [name, stats] of hookStats) {
    const runs = stats.runs;
    if (runs.length === 0) continue;

    const durations = runs.map(r => r.ms);
    const avgMs = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    const maxMs = Math.max(...durations);
    const minMs = Math.min(...durations);

    const failureCount = stats.failures.length;
    const failureRate = (failureCount / runs.length * 100).toFixed(1);

    // Sessions since last success
    const sessionsSinceSuccess = stats.lastSuccess
      ? latestSession - stats.lastSuccess
      : runs.length; // never succeeded

    // Detect anomalies: compare recent 10 runs vs earlier runs
    const recentRuns = runs.slice(-10);
    const earlierRuns = runs.slice(0, -10);
    let perfAnomaly = null;

    if (earlierRuns.length >= 10) {
      const recentAvg = recentRuns.reduce((a, r) => a + r.ms, 0) / recentRuns.length;
      const earlierAvg = earlierRuns.reduce((a, r) => a + r.ms, 0) / earlierRuns.length;
      const pctChange = ((recentAvg - earlierAvg) / earlierAvg * 100);

      if (pctChange > 50) {
        perfAnomaly = { type: 'degradation', pctChange: Math.round(pctChange) };
      }
    }

    // Detect intermittent failures (fails sometimes but not always)
    const recentFailures = stats.failures.filter(f => f.session > latestSession - failureWindow).length;
    const recentTotal = runs.filter(r => r.session > latestSession - failureWindow).length;
    const isIntermittent = recentFailures > 0 && recentFailures < recentTotal;

    results.push({
      name: stats.name,
      phase: stats.phase,
      runs: runs.length,
      avgMs,
      maxMs,
      minMs,
      failureCount,
      failureRate: parseFloat(failureRate),
      lastSuccess: stats.lastSuccess,
      lastFailure: stats.lastFailure,
      sessionsSinceSuccess,
      perfAnomaly,
      isIntermittent,
      recentFailureRate: recentTotal > 0 ? (recentFailures / recentTotal * 100).toFixed(1) : '0.0'
    });
  }

  return results;
}

function formatDuration(ms) {
  if (ms >= 10000) return `${(ms/1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms/1000).toFixed(2)}s`;
  return `${ms}ms`;
}

function printReport(metrics, latestSession) {
  console.log(`\n=== Hook Diagnostics Report ===`);
  console.log(`Latest session: ${latestSession}`);
  console.log(`Slow threshold: ${thresholdMs}ms | Failure window: ${failureWindow} sessions\n`);

  // 1. Slowest hooks
  const slowHooks = metrics
    .filter(m => m.avgMs >= thresholdMs)
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 10);

  if (slowHooks.length > 0) {
    console.log(`## Slowest Hooks (avg >= ${thresholdMs}ms)`);
    for (const h of slowHooks) {
      console.log(`  ${h.name} [${h.phase}]: avg=${formatDuration(h.avgMs)}, max=${formatDuration(h.maxMs)}`);
    }
    console.log();
  }

  // 2. Failing hooks (any failures in recent window)
  const failingHooks = metrics
    .filter(m => parseFloat(m.recentFailureRate) > 0)
    .sort((a, b) => parseFloat(b.recentFailureRate) - parseFloat(a.recentFailureRate));

  if (failingHooks.length > 0) {
    console.log(`## Hooks with Recent Failures (last ${failureWindow} sessions)`);
    for (const h of failingHooks) {
      const status = h.isIntermittent ? 'intermittent' : 'consistent';
      console.log(`  ${h.name} [${h.phase}]: ${h.recentFailureRate}% (${status}), last fail s${h.lastFailure}`);
    }
    console.log();
  }

  // 3. Hooks not succeeding recently
  const staleHooks = metrics
    .filter(m => m.sessionsSinceSuccess >= failureWindow)
    .sort((a, b) => b.sessionsSinceSuccess - a.sessionsSinceSuccess);

  if (staleHooks.length > 0) {
    console.log(`## Hooks Not Succeeding (>= ${failureWindow} sessions)`);
    for (const h of staleHooks) {
      const lastOk = h.lastSuccess ? `s${h.lastSuccess}` : 'never';
      console.log(`  ${h.name} [${h.phase}]: last success ${lastOk} (${h.sessionsSinceSuccess} sessions ago)`);
    }
    console.log();
  }

  // 4. Performance anomalies
  const anomalies = metrics.filter(m => m.perfAnomaly);

  if (anomalies.length > 0) {
    console.log(`## Performance Anomalies`);
    for (const h of anomalies) {
      console.log(`  ${h.name} [${h.phase}]: +${h.perfAnomaly.pctChange}% slower in recent runs (avg ${formatDuration(h.avgMs)})`);
    }
    console.log();
  }

  // 5. Summary
  const totalHooks = metrics.length;
  const healthyHooks = metrics.filter(m =>
    m.avgMs < thresholdMs &&
    parseFloat(m.recentFailureRate) === 0 &&
    !m.perfAnomaly
  ).length;

  console.log(`## Summary`);
  console.log(`  Total hooks: ${totalHooks}`);
  console.log(`  Healthy: ${healthyHooks} (${(healthyHooks/totalHooks*100).toFixed(0)}%)`);
  console.log(`  Slow: ${slowHooks.length}`);
  console.log(`  Failing: ${failingHooks.length}`);
  console.log(`  Anomalies: ${anomalies.length}`);

  if (healthyHooks === totalHooks) {
    console.log(`\n[OK] All hooks healthy.`);
  } else {
    console.log(`\n[ATTENTION] ${totalHooks - healthyHooks} hooks need review.`);
  }
}

// Main
const preEntries = loadResults(PRE_HOOK_FILE);
const postEntries = loadResults(POST_HOOK_FILE);

if (preEntries.length === 0 && postEntries.length === 0) {
  console.error('No hook results found.');
  process.exit(1);
}

const preStats = analyzeHooks(preEntries, 'pre');
const postStats = analyzeHooks(postEntries, 'post');

// Find latest session
const allSessions = [
  ...preEntries.map(e => e.session),
  ...postEntries.map(e => e.session)
];
const latestSession = Math.max(...allSessions);

const preMetrics = computeMetrics(preStats, latestSession);
const postMetrics = computeMetrics(postStats, latestSession);
const allMetrics = [...preMetrics, ...postMetrics];

if (jsonOutput) {
  console.log(JSON.stringify({
    latestSession,
    thresholdMs,
    failureWindow,
    hooks: allMetrics,
    summary: {
      total: allMetrics.length,
      slow: allMetrics.filter(m => m.avgMs >= thresholdMs).length,
      failing: allMetrics.filter(m => parseFloat(m.recentFailureRate) > 0).length,
      anomalies: allMetrics.filter(m => m.perfAnomaly).length
    }
  }, null, 2));
} else {
  printReport(allMetrics, latestSession);
}

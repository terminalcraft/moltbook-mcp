#!/usr/bin/env node
/**
 * probe-timing-dashboard.mjs — Aggregate probe timing from both liveness systems
 *
 * Reads:
 *   ~/.config/moltbook/liveness-timing.json       (engagement probes)
 *   ~/.config/moltbook/service-liveness-timing.json (service probes)
 *
 * Outputs a combined report: avg wall time, p95 trends, budget violations,
 * and per-platform slow outliers.
 *
 * Usage: node probe-timing-dashboard.mjs [--json]
 *
 * Created: B#473 (wq-686)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.config/moltbook');
const BUDGET_MS = 8000; // 8s probe budget per SESSION_BUILD.md

function safeReadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { entries: [] };
  }
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function analyzeEntries(entries, label) {
  if (entries.length === 0) return { label, count: 0 };

  const wallTimes = entries.map(e => e.wallMs);
  const avgWall = Math.round(wallTimes.reduce((a, b) => a + b, 0) / wallTimes.length);
  const p95Wall = percentile(wallTimes, 95);
  const budgetViolations = entries.filter(e => e.wallMs > BUDGET_MS);

  // Per-platform aggregation
  const platformStats = {};
  for (const entry of entries) {
    const platforms = entry.platforms || [];
    for (const p of platforms) {
      const name = p.platform || p.name;
      if (!name) continue;
      if (!platformStats[name]) {
        platformStats[name] = { times: [], failures: 0, count: 0 };
      }
      platformStats[name].times.push(p.ms);
      platformStats[name].count++;
      if (!p.ok) platformStats[name].failures++;
    }
  }

  // Find slow platforms (avg > 1000ms)
  const slowPlatforms = [];
  for (const [name, stats] of Object.entries(platformStats)) {
    const avg = Math.round(stats.times.reduce((a, b) => a + b, 0) / stats.times.length);
    const max = Math.max(...stats.times);
    if (avg > 1000) {
      slowPlatforms.push({ name, avgMs: avg, maxMs: max, probes: stats.count });
    }
  }
  slowPlatforms.sort((a, b) => b.avgMs - a.avgMs);

  return {
    label,
    count: entries.length,
    sessions: entries.map(e => e.session),
    wall: { avgMs: avgWall, p95Ms: p95Wall, minMs: Math.min(...wallTimes), maxMs: Math.max(...wallTimes) },
    probed: { avg: Math.round(entries.reduce((s, e) => s + (e.probed || e.total || 0), 0) / entries.length) },
    avgLatency: { avgMs: Math.round(entries.reduce((s, e) => s + e.avgMs, 0) / entries.length) },
    p95Latency: { avgMs: Math.round(entries.reduce((s, e) => s + e.p95Ms, 0) / entries.length) },
    budgetViolations: budgetViolations.map(e => ({ session: e.session, wallMs: e.wallMs })),
    slowPlatforms: slowPlatforms.slice(0, 5)
  };
}

// Load data
const engagement = safeReadJSON(join(STATE_DIR, 'liveness-timing.json'));
const service = safeReadJSON(join(STATE_DIR, 'service-liveness-timing.json'));

const engagementStats = analyzeEntries(engagement.entries || [], 'engagement-liveness');
const serviceStats = analyzeEntries(service.entries || [], 'service-liveness');

// Combined stats
const allEntries = [...(engagement.entries || []), ...(service.entries || [])];
const combinedStats = analyzeEntries(allEntries, 'combined');

const report = {
  generated: new Date().toISOString(),
  budget_ms: BUDGET_MS,
  summary: {
    total_probes: allEntries.length,
    avg_wall_ms: combinedStats.wall?.avgMs || 0,
    p95_wall_ms: combinedStats.wall?.p95Ms || 0,
    budget_violations: combinedStats.budgetViolations?.length || 0,
    verdict: (combinedStats.budgetViolations?.length || 0) === 0 ? 'within_budget' : 'has_violations'
  },
  engagement: engagementStats,
  service: serviceStats
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  // Human-readable output
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           PROBE TIMING DASHBOARD                ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Budget: ${BUDGET_MS}ms per probe run`);
  console.log(`Total probe runs: ${allEntries.length}`);
  console.log('');

  for (const stats of [engagementStats, serviceStats]) {
    if (stats.count === 0) {
      console.log(`── ${stats.label}: no data ──`);
      continue;
    }
    console.log(`── ${stats.label} (${stats.count} runs, sessions: ${stats.sessions.join(', ')}) ──`);
    console.log(`  Wall time:  avg=${stats.wall.avgMs}ms  p95=${stats.wall.p95Ms}ms  range=[${stats.wall.minMs}-${stats.wall.maxMs}ms]`);
    console.log(`  Platforms:  avg ${stats.probed.avg} probed per run`);
    console.log(`  Latency:    avg=${stats.avgLatency.avgMs}ms  p95=${stats.p95Latency.avgMs}ms`);

    if (stats.budgetViolations.length > 0) {
      console.log(`  ⚠ Budget violations: ${stats.budgetViolations.map(v => `s${v.session}(${v.wallMs}ms)`).join(', ')}`);
    } else {
      console.log('  ✓ No budget violations');
    }

    if (stats.slowPlatforms.length > 0) {
      console.log('  Slow platforms (>1000ms avg):');
      for (const sp of stats.slowPlatforms) {
        console.log(`    ${sp.name}: avg=${sp.avgMs}ms max=${sp.maxMs}ms (${sp.probes} probes)`);
      }
    }
    console.log('');
  }

  console.log(`Verdict: ${report.summary.verdict === 'within_budget' ? '✓ All probe runs within budget' : '⚠ Some runs exceeded budget'}`);
}

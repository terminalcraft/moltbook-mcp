#!/usr/bin/env node
/**
 * B session cost trend monitor (wq-485)
 * Analyzes B session cost data and flags threshold breaches.
 *
 * Usage: node b-cost-trend.mjs [--json]
 *
 * Thresholds (from A#114 audit):
 *   - avg > $2.50 over last 10 B sessions → WARN
 *   - 3+ sessions > $3.00 in last 10 → WARN
 *   - avg > $3.00 → CRITICAL
 *   - trend rising >15% vs prior window → WATCH
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const COST_HISTORY = join(homedir(), '.config/moltbook/cost-history.json');
const WINDOW = 10; // recent window size
const THRESHOLDS = {
  avgWarn: 2.50,
  avgCritical: 3.00,
  singleHigh: 3.00,
  singleHighCount: 3,
  trendRisePct: 15,
};

function analyze() {
  let data;
  try {
    data = JSON.parse(readFileSync(COST_HISTORY, 'utf8'));
  } catch (e) {
    return { status: 'error', message: `Cannot read cost history: ${e.message}` };
  }

  const bSessions = data
    .filter(e => e.mode === 'B' && e.cost > 0)
    .sort((a, b) => a.session - b.session);

  if (bSessions.length < 5) {
    return { status: 'ok', message: 'Insufficient data (<5 B sessions)', alerts: [] };
  }

  const recent = bSessions.slice(-WINDOW);
  const prior = bSessions.slice(-WINDOW * 2, -WINDOW);
  const recentCosts = recent.map(e => e.cost);
  const priorCosts = prior.map(e => e.cost);

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const recentAvg = avg(recentCosts);
  const priorAvg = priorCosts.length > 0 ? avg(priorCosts) : recentAvg;
  const highCount = recentCosts.filter(c => c > THRESHOLDS.singleHigh).length;
  const trendPct = priorAvg > 0 ? ((recentAvg - priorAvg) / priorAvg) * 100 : 0;
  const maxRecent = Math.max(...recentCosts);
  const minRecent = Math.min(...recentCosts);

  const alerts = [];

  if (recentAvg > THRESHOLDS.avgCritical) {
    alerts.push({ level: 'CRITICAL', msg: `B avg $${recentAvg.toFixed(2)} > $${THRESHOLDS.avgCritical} threshold` });
  } else if (recentAvg > THRESHOLDS.avgWarn) {
    alerts.push({ level: 'WARN', msg: `B avg $${recentAvg.toFixed(2)} > $${THRESHOLDS.avgWarn} threshold` });
  }

  if (highCount >= THRESHOLDS.singleHighCount) {
    alerts.push({ level: 'WARN', msg: `${highCount} of ${WINDOW} B sessions > $${THRESHOLDS.singleHigh}` });
  }

  if (trendPct > THRESHOLDS.trendRisePct) {
    alerts.push({ level: 'WATCH', msg: `Cost trending up ${trendPct.toFixed(0)}% vs prior window ($${priorAvg.toFixed(2)} → $${recentAvg.toFixed(2)})` });
  } else if (trendPct < -THRESHOLDS.trendRisePct) {
    alerts.push({ level: 'INFO', msg: `Cost trending down ${Math.abs(trendPct).toFixed(0)}% vs prior window` });
  }

  const status = alerts.some(a => a.level === 'CRITICAL') ? 'critical'
    : alerts.some(a => a.level === 'WARN') ? 'warn'
    : alerts.length > 0 ? 'watch'
    : 'ok';

  return {
    status,
    window: WINDOW,
    recentAvg: +recentAvg.toFixed(2),
    priorAvg: +priorAvg.toFixed(2),
    trendPct: +trendPct.toFixed(1),
    highCount,
    range: { min: +minRecent.toFixed(2), max: +maxRecent.toFixed(2) },
    sessions: recent.map(e => ({ s: e.session, cost: +e.cost.toFixed(2) })),
    alerts,
  };
}

const result = analyze();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const icon = { critical: '🚨', warn: '⚠️', watch: '👀', ok: '✅', error: '❌' };
  console.log(`[b-cost-trend] ${icon[result.status] || '?'} Status: ${result.status}`);
  if (result.recentAvg !== undefined) {
    console.log(`  Last ${result.window} B sessions: avg=$${result.recentAvg}, range=$${result.range.min}-$${result.range.max}`);
    console.log(`  Trend: ${result.trendPct > 0 ? '+' : ''}${result.trendPct}% vs prior window (avg=$${result.priorAvg})`);
    console.log(`  High-cost sessions (>$3.00): ${result.highCount}/${result.window}`);
  }
  if (result.alerts.length > 0) {
    for (const a of result.alerts) {
      console.log(`  [${a.level}] ${a.msg}`);
    }
  } else if (result.status === 'ok') {
    console.log('  All metrics within acceptable range.');
  }
  if (result.message) console.log(`  ${result.message}`);
}

#!/usr/bin/env node
// lib/r-impact-tracker.mjs — R session structural change impact tracker.
// Extracted from hooks/post-session/18-r-impact-track.sh (R#263).
//
// Records what file/category was modified in this R session, then after 10+
// sessions analyzes whether the change improved cost/success metrics.
// Writes r-session-impact.json and generates a digest file.
//
// Usage: node lib/r-impact-tracker.mjs <session_num> <change_file> <change_category> [change_intent]

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const IMPACT_FILE = join(process.env.HOME, '.config/moltbook/r-session-impact.json');
const OUTCOMES_FILE = join(process.env.HOME, '.config/moltbook/session-outcomes.json');

function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function avgCost(entries) {
  const costs = entries.map(e => e.cost_usd).filter(Boolean);
  return costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0;
}

function successRate(entries) {
  if (!entries.length) return 0;
  return entries.filter(e => e.outcome === 'success').length / entries.length;
}

function assessImpact(costDeltaPct, successDelta, intent) {
  if (intent === 'cost_increase') {
    // Budget enforcement: cost going UP is success
    if (costDeltaPct > 10 || successDelta > 0.1) return 'positive';
    if (costDeltaPct < -20 || successDelta < -0.2) return 'negative';
  } else if (intent === 'cost_decrease') {
    // Explicit cost reduction: stricter thresholds
    if (costDeltaPct < -15 || successDelta > 0.1) return 'positive';
    if (costDeltaPct > 10 || successDelta < -0.2) return 'negative';
  } else {
    // Default: lower cost = positive
    if (costDeltaPct < -10 || successDelta > 0.1) return 'positive';
    if (costDeltaPct > 20 || successDelta < -0.2) return 'negative';
  }
  return 'neutral';
}

function determineTargetType(fileChanged, category) {
  if (fileChanged?.includes('SESSION_BUILD')) return 'B';
  if (fileChanged?.includes('SESSION_ENGAGE')) return 'E';
  if (fileChanged?.includes('SESSION_REFLECT')) return 'R';
  if (fileChanged?.includes('SESSION_AUDIT')) return 'A';
  return 'ALL';
}

export function trackImpact(sessionNum, changeFile, changeCategory, changeIntent) {
  const data = loadJSON(IMPACT_FILE) || { version: 1, changes: [], analysis: [] };
  const outcomes = loadJSON(OUTCOMES_FILE) || [];

  // Record this session's change
  if (changeCategory) {
    const record = {
      session: sessionNum,
      timestamp: new Date().toISOString(),
      file: changeFile || null,
      category: changeCategory,
      analyzed: false,
    };
    if (changeIntent) record.intent = changeIntent;
    data.changes.push(record);
    data.changes = data.changes.slice(-50);  // keep last 50
  }

  // Analyze old changes with 10+ sessions of post-change data
  for (const change of data.changes) {
    if (change.analyzed) continue;
    const sessionsSince = sessionNum - (change.session || 0);
    if (sessionsSince < 10) continue;

    const targetType = determineTargetType(change.file, change.category);

    let before = outcomes.filter(o =>
      o.session >= change.session - 10 && o.session < change.session
    );
    let after = outcomes.filter(o =>
      o.session > change.session && o.session <= change.session + 10
    );

    if (targetType !== 'ALL') {
      before = before.filter(o => o.mode === targetType);
      after = after.filter(o => o.mode === targetType);
    }

    if (before.length < 2 || after.length < 2) continue;

    const beforeCost = avgCost(before);
    const afterCost = avgCost(after);
    const costDeltaPct = beforeCost > 0
      ? ((afterCost - beforeCost) / beforeCost) * 100
      : 0;
    const successDelta = successRate(after) - successRate(before);
    const impact = assessImpact(costDeltaPct, successDelta, change.intent || '');

    change.analyzed = true;
    change.impact = impact;
    change.metrics = {
      target_type: targetType,
      before_cost: +beforeCost.toFixed(2),
      after_cost: +afterCost.toFixed(2),
      cost_delta_pct: +costDeltaPct.toFixed(1),
      before_success: +successRate(before).toFixed(2),
      after_success: +successRate(after).toFixed(2),
      sample_before: before.length,
      sample_after: after.length,
    };

    data.analysis.push({
      session: change.session,
      file: change.file,
      category: change.category,
      impact,
      cost_delta_pct: +costDeltaPct.toFixed(1),
      success_delta: +successDelta.toFixed(2),
      analyzed_at: sessionNum,
    });
    data.analysis = data.analysis.slice(-30);
  }

  writeFileSync(IMPACT_FILE, JSON.stringify(data, null, 2));

  // Generate human-readable digest
  generateDigest(data, sessionNum);

  return { category: changeCategory || 'none', analysisCount: data.analysis.length };
}

function generateDigest(data, sessionNum) {
  const analysis = data.analysis || [];
  if (!analysis.length) return;

  const catStats = {};
  for (const a of analysis) {
    const cat = a.category || 'unknown';
    if (!catStats[cat]) catStats[cat] = { positive: 0, negative: 0, neutral: 0, costDeltas: [], successDeltas: [] };
    catStats[cat][a.impact || 'neutral']++;
    if (a.cost_delta_pct != null) catStats[cat].costDeltas.push(a.cost_delta_pct);
    if (a.success_delta != null) catStats[cat].successDeltas.push(a.success_delta);
  }

  const lines = [
    '# R Session Impact Digest',
    `# Generated: session ${sessionNum}`,
    `# Total analyzed changes: ${analysis.length}`,
    '',
    '## Category Performance',
    '',
  ];

  for (const [cat, stats] of Object.entries(catStats).sort()) {
    const total = stats.positive + stats.negative + stats.neutral;
    if (!total) continue;
    const posPct = (stats.positive / total) * 100;
    const negPct = (stats.negative / total) * 100;
    const avgCostDelta = stats.costDeltas.length
      ? stats.costDeltas.reduce((a, b) => a + b, 0) / stats.costDeltas.length
      : 0;
    const avgSuccessDelta = stats.successDeltas.length
      ? stats.successDeltas.reduce((a, b) => a + b, 0) / stats.successDeltas.length
      : 0;

    const rec = negPct > 50 ? 'AVOID' : posPct > 50 ? 'PREFER' : 'NEUTRAL';

    lines.push(`### ${cat} (${rec})`);
    lines.push(`- Changes: ${total} (${stats.positive} positive, ${stats.negative} negative, ${stats.neutral} neutral)`);
    lines.push(`- Avg cost delta: ${avgCostDelta >= 0 ? '+' : ''}${avgCostDelta.toFixed(1)}%`);
    lines.push(`- Avg success delta: ${avgSuccessDelta >= 0 ? '+' : ''}${avgSuccessDelta.toFixed(2)}`);
    lines.push('');
  }

  lines.push('## Recent Changes (last 5)', '');
  for (const a of analysis.slice(-5)) {
    lines.push(`- s${a.session ?? '?'}: ${a.file ?? '?'} (${a.category ?? '?'}) → ${a.impact ?? '?'}`);
  }

  const pending = (data.changes || []).filter(c => !c.analyzed);
  if (pending.length) {
    lines.push('', `## Pending Analysis (${pending.length} changes)`,
      'Awaiting 10+ sessions of post-change data before analysis.');
    for (const c of pending.slice(-3)) {
      const sessionsUntil = 10 - (sessionNum - (c.session || 0));
      lines.push(`- s${c.session ?? '?'}: ${c.file ?? '?'} (${c.category ?? '?'}) — ${sessionsUntil} sessions until analysis`);
    }
  }

  const digestFile = IMPACT_FILE.replace('.json', '-digest.txt');
  writeFileSync(digestFile, lines.join('\n'));
}

// CLI entry point
if (process.argv[1]?.endsWith('r-impact-tracker.mjs')) {
  const sessionNum = parseInt(process.argv[2]) || 0;
  const changeFile = process.argv[3] || '';
  const changeCategory = process.argv[4] || '';
  const changeIntent = process.argv[5] || '';
  const result = trackImpact(sessionNum, changeFile || null, changeCategory || null, changeIntent || null);
  console.log(`impact tracking: recorded (category=${result.category}), ${result.analysisCount} analyses`);
}

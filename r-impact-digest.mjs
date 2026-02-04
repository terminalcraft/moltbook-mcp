#!/usr/bin/env node
// r-impact-digest.mjs — Generate R session impact digest on demand
// Usage: node r-impact-digest.mjs [--json]
//
// Reads ~/.config/moltbook/r-session-impact.json and generates:
// - Human-readable digest (default)
// - JSON output (with --json flag)
//
// B#201: Created to allow R sessions to consult impact data during diagnosis phase

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const IMPACT_FILE = join(homedir(), '.config/moltbook/r-session-impact.json');
const DIGEST_FILE = join(homedir(), '.config/moltbook/r-session-impact-digest.txt');

function loadImpactData() {
  if (!existsSync(IMPACT_FILE)) {
    return { version: 1, changes: [], analysis: [] };
  }
  try {
    return JSON.parse(readFileSync(IMPACT_FILE, 'utf8'));
  } catch (e) {
    return { version: 1, changes: [], analysis: [] };
  }
}

function generateDigest(data, sessionNum = 0) {
  const analysis = data.analysis || [];

  if (analysis.length === 0) {
    return {
      text: '# R Session Impact Digest\n\nNo analyzed changes yet. Need 10+ sessions after each R session change for analysis.',
      stats: { total: 0, categories: {} }
    };
  }

  // Aggregate by category
  const categoryStats = {};
  for (const a of analysis) {
    const cat = a.category || 'unknown';
    if (!categoryStats[cat]) {
      categoryStats[cat] = { positive: 0, negative: 0, neutral: 0, costDeltas: [], successDeltas: [] };
    }
    const impact = a.impact || 'neutral';
    categoryStats[cat][impact]++;
    if (a.cost_delta_pct != null) categoryStats[cat].costDeltas.push(a.cost_delta_pct);
    if (a.success_delta != null) categoryStats[cat].successDeltas.push(a.success_delta);
  }

  // Build text digest
  const lines = [
    '# R Session Impact Digest',
    `# Total analyzed changes: ${analysis.length}`,
    '',
    '## Category Performance',
    ''
  ];

  const recommendations = {};

  for (const [cat, stats] of Object.entries(categoryStats).sort()) {
    const total = stats.positive + stats.negative + stats.neutral;
    if (total === 0) continue;

    const posPct = (stats.positive / total) * 100;
    const negPct = (stats.negative / total) * 100;
    const avgCost = stats.costDeltas.length ? stats.costDeltas.reduce((a, b) => a + b, 0) / stats.costDeltas.length : 0;
    const avgSuccess = stats.successDeltas.length ? stats.successDeltas.reduce((a, b) => a + b, 0) / stats.successDeltas.length : 0;

    let rec;
    if (negPct > 50) rec = 'AVOID';
    else if (posPct > 50) rec = 'PREFER';
    else rec = 'NEUTRAL';

    recommendations[cat] = rec;

    lines.push(`### ${cat} (${rec})`);
    lines.push(`- Changes: ${total} (${stats.positive} positive, ${stats.negative} negative, ${stats.neutral} neutral)`);
    lines.push(`- Avg cost delta: ${avgCost >= 0 ? '+' : ''}${avgCost.toFixed(1)}%`);
    lines.push(`- Avg success delta: ${avgSuccess >= 0 ? '+' : ''}${avgSuccess.toFixed(2)}`);
    lines.push('');
  }

  // wq-206: Intent-tagged changes section
  // Show changes that had explicit cost_increase or cost_decrease intent
  const allChanges = data.changes || [];
  const intentTagged = allChanges.filter(c => c.intent);
  if (intentTagged.length > 0) {
    lines.push('## Intent-Tagged Changes');
    lines.push('Changes with explicit cost intent (analyzed with inverted thresholds):');
    lines.push('');

    // Group by intent type
    const byIntent = { cost_increase: [], cost_decrease: [] };
    for (const c of intentTagged) {
      if (byIntent[c.intent]) byIntent[c.intent].push(c);
    }

    if (byIntent.cost_increase.length > 0) {
      lines.push('### Cost Increase Intent');
      lines.push('Goal: spend more budget (e.g., budget enforcement). Cost going UP = positive.');
      for (const c of byIntent.cost_increase.slice(-5)) {
        const result = c.analyzed ? (analysis.find(a => a.session === c.session)?.impact || 'pending') : 'pending';
        lines.push(`- s${c.session || '?'}: ${c.file || '?'} → ${result}`);
      }
      lines.push('');
    }

    if (byIntent.cost_decrease.length > 0) {
      lines.push('### Cost Decrease Intent');
      lines.push('Goal: reduce budget (e.g., efficiency optimization). Cost going DOWN = positive.');
      for (const c of byIntent.cost_decrease.slice(-5)) {
        const result = c.analyzed ? (analysis.find(a => a.session === c.session)?.impact || 'pending') : 'pending';
        lines.push(`- s${c.session || '?'}: ${c.file || '?'} → ${result}`);
      }
      lines.push('');
    }
  }

  // Recent changes
  lines.push('## Recent Changes (last 5)');
  lines.push('');
  for (const a of analysis.slice(-5)) {
    const intentMarker = a.intent ? ` [${a.intent}]` : '';
    lines.push(`- s${a.session || '?'}: ${a.file || '?'} (${a.category || '?'}) → ${a.impact || '?'}${intentMarker}`);
  }

  // Pending analysis
  const pending = (data.changes || []).filter(c => !c.analyzed);
  if (pending.length > 0) {
    lines.push('');
    lines.push(`## Pending Analysis (${pending.length} changes)`);
    lines.push('Awaiting 10+ sessions of post-change data.');
    for (const c of pending.slice(-3)) {
      const sessionsUntil = sessionNum ? 10 - (sessionNum - (c.session || 0)) : '?';
      lines.push(`- s${c.session || '?'}: ${c.file || '?'} (${c.category || '?'}) — ${sessionsUntil} sessions until analysis`);
    }
  }

  // wq-206: Intent statistics for JSON output
  const intentStats = {
    cost_increase: intentTagged.filter(c => c.intent === 'cost_increase').length,
    cost_decrease: intentTagged.filter(c => c.intent === 'cost_decrease').length,
    total_intent_tagged: intentTagged.length
  };

  return {
    text: lines.join('\n'),
    stats: {
      total: analysis.length,
      categories: categoryStats,
      recommendations,
      intent: intentStats
    }
  };
}

// Main
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const sessionNum = parseInt(process.env.SESSION_NUM || '0', 10);

const data = loadImpactData();
const digest = generateDigest(data, sessionNum);

if (jsonMode) {
  console.log(JSON.stringify(digest.stats, null, 2));
} else {
  // Write to file and print
  writeFileSync(DIGEST_FILE, digest.text);
  console.log(digest.text);
  console.log(`\n(Digest written to ${DIGEST_FILE})`);
}

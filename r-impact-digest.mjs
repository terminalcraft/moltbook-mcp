#!/usr/bin/env node
// r-impact-digest.mjs — Generate R session impact digest on demand
// Usage: node r-impact-digest.mjs [--json]
//
// Reads ~/.config/moltbook/r-session-impact.json and generates:
// - Human-readable digest (default)
// - JSON output (with --json flag)
//
// B#201: Created to allow R sessions to consult impact data during diagnosis phase
// B#311 (wq-335): Enhanced with specific change impact analysis, correlation detection,
//                 and actionable recommendations for next R session

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

// wq-335: Analyze specific changes that improved or worsened metrics
function analyzeSpecificChanges(analysis, changes) {
  const results = {
    topImprovements: [],    // Biggest cost reductions
    topRegressions: [],     // Biggest cost increases
    byFile: {},             // Impact per file
    byDescription: {},      // Impact by change description (when available)
    volatileFiles: []       // Files with high variance (unreliable changes)
  };

  // Sort by cost delta to find best/worst
  const sorted = [...analysis].sort((a, b) => (a.cost_delta_pct || 0) - (b.cost_delta_pct || 0));

  // Top 3 improvements (biggest negative delta = cost reduction)
  results.topImprovements = sorted
    .filter(a => (a.cost_delta_pct || 0) < -10)
    .slice(0, 3)
    .map(a => ({
      session: a.session,
      file: a.file,
      costDelta: a.cost_delta_pct,
      description: changes.find(c => c.session === a.session && c.file === a.file)?.description || null
    }));

  // Top 3 regressions (biggest positive delta = cost increase)
  results.topRegressions = sorted
    .filter(a => (a.cost_delta_pct || 0) > 15)
    .slice(-3)
    .reverse()
    .map(a => ({
      session: a.session,
      file: a.file,
      costDelta: a.cost_delta_pct,
      description: changes.find(c => c.session === a.session && c.file === a.file)?.description || null
    }));

  // Aggregate by file
  for (const a of analysis) {
    const file = a.file || 'unknown';
    if (!results.byFile[file]) {
      results.byFile[file] = {
        deltas: [],
        impacts: { positive: 0, negative: 0, neutral: 0 }
      };
    }
    results.byFile[file].deltas.push(a.cost_delta_pct || 0);
    results.byFile[file].impacts[a.impact || 'neutral']++;
  }

  // Calculate per-file stats and identify volatile files
  for (const [file, stats] of Object.entries(results.byFile)) {
    const deltas = stats.deltas;
    if (deltas.length >= 2) {
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const variance = deltas.reduce((sum, d) => sum + Math.pow(d - avg, 2), 0) / deltas.length;
      const stdDev = Math.sqrt(variance);
      stats.avgDelta = avg;
      stats.stdDev = stdDev;
      stats.count = deltas.length;

      // High variance = unreliable (changes to this file have unpredictable effects)
      if (stdDev > 20 && deltas.length >= 3) {
        results.volatileFiles.push({ file, stdDev: stdDev.toFixed(1), count: deltas.length });
      }
    }
  }

  return results;
}

// wq-335: Detect correlations between change types and outcomes
function detectCorrelations(analysis, changes) {
  const correlations = {
    sessionFileChanges: { positive: 0, negative: 0, neutral: 0, total: 0 },
    stateFileChanges: { positive: 0, negative: 0, neutral: 0, total: 0 },
    orchestrationChanges: { positive: 0, negative: 0, neutral: 0, total: 0 },
    // Track session-type-specific changes (E changes to SESSION_ENGAGE, R to SESSION_REFLECT, etc.)
    targetedVsGeneral: { targeted: { positive: 0, negative: 0 }, general: { positive: 0, negative: 0 } }
  };

  for (const a of analysis) {
    const cat = a.category || 'other';
    const impact = a.impact || 'neutral';

    // Categorize
    if (cat === 'session-file') {
      correlations.sessionFileChanges[impact]++;
      correlations.sessionFileChanges.total++;

      // Check if it was a targeted change (SESSION_ENGAGE for E sessions, etc.)
      const change = changes.find(c => c.session === a.session && c.file === a.file);
      const targetType = change?.metrics?.target_type;
      const isTargeted = (
        (a.file === 'SESSION_ENGAGE.md' && targetType === 'E') ||
        (a.file === 'SESSION_REFLECT.md' && targetType === 'R') ||
        (a.file === 'SESSION_AUDIT.md' && targetType === 'A') ||
        (a.file === 'SESSION_BUILD.md' && targetType === 'B')
      );

      if (impact === 'positive' || impact === 'negative') {
        if (isTargeted) {
          correlations.targetedVsGeneral.targeted[impact]++;
        } else {
          correlations.targetedVsGeneral.general[impact]++;
        }
      }
    } else if (cat === 'state-files') {
      correlations.stateFileChanges[impact]++;
      correlations.stateFileChanges.total++;
    } else if (cat === 'orchestration') {
      correlations.orchestrationChanges[impact]++;
      correlations.orchestrationChanges.total++;
    }
  }

  // Calculate success rates
  const calcSuccessRate = (bucket) => {
    const total = bucket.positive + bucket.negative;
    return total > 0 ? (bucket.positive / total * 100).toFixed(0) : null;
  };

  correlations.sessionFileSuccessRate = calcSuccessRate(correlations.sessionFileChanges);
  correlations.stateFileSuccessRate = calcSuccessRate(correlations.stateFileChanges);
  correlations.targetedSuccessRate = calcSuccessRate(correlations.targetedVsGeneral.targeted);
  correlations.generalSuccessRate = calcSuccessRate(correlations.targetedVsGeneral.general);

  return correlations;
}

// wq-335: Generate actionable recommendations for next R session
function generateRecommendations(specific, correlations, data) {
  const recs = [];
  const analysis = data.analysis || [];
  const changes = data.changes || [];

  // Recommendation 1: Prefer files that consistently improve metrics
  const reliableImprovements = Object.entries(specific.byFile)
    .filter(([_, stats]) =>
      stats.avgDelta !== undefined &&
      stats.avgDelta < -5 &&
      stats.stdDev < 15 &&
      stats.count >= 2
    )
    .map(([file, stats]) => ({ file, avgDelta: stats.avgDelta.toFixed(1), count: stats.count }));

  if (reliableImprovements.length > 0) {
    recs.push({
      type: 'PREFER',
      title: 'Reliable improvement targets',
      detail: reliableImprovements.map(r => `${r.file} (avg ${r.avgDelta}% across ${r.count} changes)`).join(', '),
      confidence: 'high'
    });
  }

  // Recommendation 2: Avoid volatile files
  if (specific.volatileFiles.length > 0) {
    recs.push({
      type: 'CAUTION',
      title: 'Volatile files (unpredictable outcomes)',
      detail: specific.volatileFiles.map(v => `${v.file} (σ=${v.stdDev}%)`).join(', '),
      confidence: 'medium'
    });
  }

  // Recommendation 3: Targeted vs general changes
  if (correlations.targetedSuccessRate !== null && correlations.generalSuccessRate !== null) {
    const targeted = parseInt(correlations.targetedSuccessRate);
    const general = parseInt(correlations.generalSuccessRate);
    if (targeted > general + 20) {
      recs.push({
        type: 'INSIGHT',
        title: 'Targeted session changes outperform general',
        detail: `Session-type-specific changes succeed ${targeted}% vs ${general}% for general changes`,
        confidence: 'medium'
      });
    }
  }

  // Recommendation 4: Based on top regressions - what to avoid
  if (specific.topRegressions.length > 0) {
    const worstFile = specific.topRegressions[0];
    const fileStats = specific.byFile[worstFile.file];
    if (fileStats && fileStats.impacts.negative >= fileStats.impacts.positive) {
      recs.push({
        type: 'AVOID',
        title: `${worstFile.file} changes trending negative`,
        detail: `${fileStats.impacts.negative} negative vs ${fileStats.impacts.positive} positive outcomes`,
        confidence: 'medium'
      });
    }
  }

  // Recommendation 5: If state-files (BRAINSTORMING.md) show low success rate
  if (correlations.stateFileSuccessRate !== null && parseInt(correlations.stateFileSuccessRate) < 50) {
    const stateStats = correlations.stateFileChanges;
    recs.push({
      type: 'INSIGHT',
      title: 'State file changes have low impact predictability',
      detail: `Only ${correlations.stateFileSuccessRate}% positive outcomes (${stateStats.positive}/${stateStats.positive + stateStats.negative})`,
      confidence: 'low'
    });
  }

  // Recommendation 6: Learn from top improvements
  if (specific.topImprovements.length > 0 && specific.topImprovements[0].description) {
    recs.push({
      type: 'REPLICATE',
      title: 'Most effective change type',
      detail: `s${specific.topImprovements[0].session}: "${specific.topImprovements[0].description}" achieved ${specific.topImprovements[0].costDelta.toFixed(1)}% cost reduction`,
      confidence: 'high'
    });
  }

  return recs;
}

function generateDigest(data, sessionNum = 0) {
  const analysis = data.analysis || [];
  const changes = data.changes || [];

  if (analysis.length === 0) {
    return {
      text: '# R Session Impact Digest\n\nNo analyzed changes yet. Need 10+ sessions after each R session change for analysis.',
      stats: { total: 0, categories: {} }
    };
  }

  // wq-335: Run enhanced analysis
  const specific = analyzeSpecificChanges(analysis, changes);
  const correlations = detectCorrelations(analysis, changes);
  const recs = generateRecommendations(specific, correlations, data);

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
    ''
  ];

  // wq-335: Recommendations section at top (actionable first)
  if (recs.length > 0) {
    lines.push('## Recommendations for Next R Session');
    lines.push('');
    for (const r of recs) {
      const confIcon = r.confidence === 'high' ? '✓' : r.confidence === 'medium' ? '~' : '?';
      lines.push(`### ${r.type}: ${r.title} [${confIcon}]`);
      lines.push(r.detail);
      lines.push('');
    }
  }

  // wq-335: Specific change impact section
  lines.push('## Specific Change Impact');
  lines.push('');

  if (specific.topImprovements.length > 0) {
    lines.push('### Top Improvements (cost reduction)');
    for (const imp of specific.topImprovements) {
      const desc = imp.description ? ` "${imp.description}"` : '';
      lines.push(`- s${imp.session}: ${imp.file}${desc} → ${imp.costDelta.toFixed(1)}%`);
    }
    lines.push('');
  }

  if (specific.topRegressions.length > 0) {
    lines.push('### Top Regressions (cost increase)');
    for (const reg of specific.topRegressions) {
      const desc = reg.description ? ` "${reg.description}"` : '';
      lines.push(`- s${reg.session}: ${reg.file}${desc} → +${reg.costDelta.toFixed(1)}%`);
    }
    lines.push('');
  }

  // wq-335: Per-file statistics
  lines.push('### Per-File Statistics');
  const fileEntries = Object.entries(specific.byFile)
    .filter(([_, stats]) => stats.avgDelta !== undefined)
    .sort((a, b) => (a[1].avgDelta || 0) - (b[1].avgDelta || 0));

  for (const [file, stats] of fileEntries) {
    const trend = stats.avgDelta < -5 ? '↓' : stats.avgDelta > 5 ? '↑' : '→';
    const reliability = stats.stdDev < 15 ? 'reliable' : stats.stdDev < 25 ? 'moderate' : 'volatile';
    lines.push(`- ${file}: avg ${stats.avgDelta >= 0 ? '+' : ''}${stats.avgDelta.toFixed(1)}% (${trend}, ${reliability}, n=${stats.count})`);
  }
  lines.push('');

  lines.push('## Category Performance');
  lines.push('');

  const recommendations = {};

  for (const [cat, stats] of Object.entries(categoryStats).sort()) {
    const total = stats.positive + stats.negative + stats.neutral;
    if (total === 0) continue;

    const posPct = (stats.positive / total) * 100;
    const negPct = (stats.negative / total) * 100;
    const avgCost = stats.costDeltas.length ? stats.costDeltas.reduce((a, b) => a + b, 0) / stats.costDeltas.length : 0;
    const avgSuccess = stats.successDeltas.length ? stats.successDeltas.reduce((a, b) => a + b, 0) / stats.successDeltas.length : 0;

    // wq-335: Improved recommendation logic - use success rate instead of just percentage
    const successRate = (stats.positive + stats.negative) > 0
      ? (stats.positive / (stats.positive + stats.negative)) * 100
      : 50;

    let rec;
    if (successRate < 40 && stats.negative > 0) rec = 'AVOID';
    else if (successRate > 60 && stats.positive > 0) rec = 'PREFER';
    else rec = 'NEUTRAL';

    recommendations[cat] = rec;

    lines.push(`### ${cat} (${rec})`);
    lines.push(`- Changes: ${total} (${stats.positive} positive, ${stats.negative} negative, ${stats.neutral} neutral)`);
    lines.push(`- Success rate: ${successRate.toFixed(0)}% (of non-neutral outcomes)`);
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
      intent: intentStats,
      // wq-335: Enhanced analysis data
      specificChanges: {
        topImprovements: specific.topImprovements,
        topRegressions: specific.topRegressions,
        volatileFiles: specific.volatileFiles,
        byFile: Object.fromEntries(
          Object.entries(specific.byFile)
            .filter(([_, s]) => s.avgDelta !== undefined)
            .map(([f, s]) => [f, { avgDelta: s.avgDelta, stdDev: s.stdDev, count: s.count, impacts: s.impacts }])
        )
      },
      correlations,
      actionableRecommendations: recs
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

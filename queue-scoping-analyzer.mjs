#!/usr/bin/env node
// queue-scoping-analyzer.mjs — Analyze work-queue outcome history for scoping patterns
//
// Reports completion rate and quality distribution per source (audit, directive,
// intel-auto, brainstorming, manual). Flags patterns when new items match profiles
// of historically over-scoped or under-specified items.
//
// Usage:
//   node queue-scoping-analyzer.mjs              # Human-readable report
//   node queue-scoping-analyzer.mjs --json       # JSON output
//   node queue-scoping-analyzer.mjs --check ID   # Check a specific item against patterns
//
// Created: B#402 s1410 (wq-533)

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const HOME = process.env.HOME || '/home/moltbot';
const MCP_DIR = join(HOME, 'moltbook-mcp');
const QUEUE_PATH = join(MCP_DIR, 'work-queue.json');
const ARCHIVE_PATH = join(MCP_DIR, 'work-queue-archive.json');

function loadAllItems() {
  const items = [];

  // Current queue
  if (existsSync(QUEUE_PATH)) {
    try {
      const data = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
      items.push(...(data.queue || []));
    } catch { /* skip */ }
  }

  // Archive
  if (existsSync(ARCHIVE_PATH)) {
    try {
      const archive = JSON.parse(readFileSync(ARCHIVE_PATH, 'utf8'));
      if (Array.isArray(archive)) {
        items.push(...archive);
      }
    } catch { /* skip */ }
  }

  return items;
}

function inferOutcome(item) {
  // If structured outcome exists, use it
  if (item.outcome) {
    return {
      result: item.outcome.result,
      effort: item.outcome.effort || 'unknown',
      quality: item.outcome.quality || 'unknown',
      source: 'structured'
    };
  }

  // Infer from status
  if (item.status === 'done') {
    return { result: 'completed', effort: 'unknown', quality: 'unknown', source: 'inferred' };
  }
  if (item.status === 'retired') {
    const note = (item.retirement_note || item.note || '').toLowerCase();
    let quality = 'non-actionable';
    if (note.includes('duplicate')) quality = 'duplicate';
    else if (note.includes('blocked')) quality = 'blocked';
    else if (note.includes('over-scoped') || note.includes('too large')) quality = 'over-scoped';
    return { result: 'retired', effort: 'unknown', quality, source: 'inferred' };
  }
  if (item.status === 'blocked') {
    return { result: 'blocked', effort: 'unknown', quality: 'unknown', source: 'inferred' };
  }

  return null; // pending or in-progress — no outcome yet
}

function normalizeSource(item) {
  const src = (item.source || 'unknown').toLowerCase();
  if (src.includes('audit')) return 'audit';
  if (src.includes('directive')) return 'directive';
  if (src.includes('intel')) return 'intel-auto';
  if (src.includes('brainstorm')) return 'brainstorming';
  if (src.includes('manual') || src === 'human') return 'manual';
  return src;
}

function analyze() {
  const items = loadAllItems();
  const resolved = [];
  const pending = [];

  for (const item of items) {
    const outcome = inferOutcome(item);
    if (outcome) {
      resolved.push({ ...item, _outcome: outcome, _source: normalizeSource(item) });
    } else if (item.status === 'pending' || item.status === 'in-progress') {
      pending.push({ ...item, _source: normalizeSource(item) });
    }
  }

  // Group by source
  const bySource = {};
  for (const item of resolved) {
    const src = item._source;
    if (!bySource[src]) bySource[src] = { total: 0, completed: 0, retired: 0, blocked: 0, quality: {} };
    bySource[src].total++;

    const result = item._outcome.result;
    if (result === 'completed') bySource[src].completed++;
    else if (result === 'retired') bySource[src].retired++;
    else if (result === 'blocked') bySource[src].blocked++;

    const q = item._outcome.quality;
    bySource[src].quality[q] = (bySource[src].quality[q] || 0) + 1;
  }

  // Compute per-source metrics
  const sourceReports = {};
  for (const [src, data] of Object.entries(bySource)) {
    const completionRate = data.total > 0 ? data.completed / data.total : 0;
    const retirementRate = data.total > 0 ? data.retired / data.total : 0;
    sourceReports[src] = {
      total: data.total,
      completed: data.completed,
      retired: data.retired,
      blocked: data.blocked,
      completionRate: parseFloat((completionRate * 100).toFixed(1)),
      retirementRate: parseFloat((retirementRate * 100).toFixed(1)),
      qualityDistribution: data.quality,
      // Flag problematic sources
      warning: retirementRate > 0.4 ? 'high-retirement' :
               (data.quality['over-scoped'] || 0) > data.total * 0.3 ? 'frequently-over-scoped' :
               (data.quality['non-actionable'] || 0) > data.total * 0.3 ? 'frequently-non-actionable' :
               null
    };
  }

  // Effort distribution for completed items
  const effortDist = {};
  for (const item of resolved) {
    if (item._outcome.result === 'completed' && item._outcome.effort !== 'unknown') {
      const e = item._outcome.effort;
      effortDist[e] = (effortDist[e] || 0) + 1;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    summary: {
      totalResolved: resolved.length,
      totalPending: pending.length,
      overallCompletionRate: resolved.length > 0
        ? parseFloat((resolved.filter(i => i._outcome.result === 'completed').length / resolved.length * 100).toFixed(1))
        : 0
    },
    bySource: sourceReports,
    effortDistribution: effortDist,
    warnings: Object.entries(sourceReports)
      .filter(([, v]) => v.warning)
      .map(([src, v]) => `${src}: ${v.warning} (${v.retirementRate}% retired)`),
    dataQuality: {
      structuredOutcomes: resolved.filter(i => i._outcome.source === 'structured').length,
      inferredOutcomes: resolved.filter(i => i._outcome.source === 'inferred').length,
      note: resolved.length < 10 ? 'Low sample size — patterns may not be reliable yet' : null
    }
  };
}

function checkItem(itemId) {
  const items = loadAllItems();
  const target = items.find(i => i.id === itemId);
  if (!target) return { error: `Item ${itemId} not found` };

  const report = analyze();
  const src = normalizeSource(target);
  const srcData = report.bySource[src];

  const warnings = [];
  if (srcData) {
    if (srcData.retirementRate > 30) {
      warnings.push(`Source "${src}" has ${srcData.retirementRate}% retirement rate — consider tighter scoping`);
    }
    if (srcData.qualityDistribution['over-scoped'] > 0) {
      warnings.push(`Source "${src}" has produced over-scoped items before`);
    }
    if (srcData.qualityDistribution['non-actionable'] > 0) {
      warnings.push(`Source "${src}" has produced non-actionable items before`);
    }
  }

  // Check description length as proxy for scope
  const descLen = (target.description || '').length;
  if (descLen > 300) {
    warnings.push(`Description is ${descLen} chars — long descriptions correlate with over-scoping`);
  }
  if (descLen < 30) {
    warnings.push(`Description is only ${descLen} chars — may be under-specified`);
  }

  return {
    item: { id: target.id, title: target.title, source: src },
    sourceProfile: srcData || null,
    warnings,
    recommendation: warnings.length === 0 ? 'Item looks well-scoped' :
                    warnings.length <= 1 ? 'Minor concern — proceed with awareness' :
                    'Consider splitting or clarifying before building'
  };
}

// CLI
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const checkIdx = args.indexOf('--check');
const checkId = checkIdx >= 0 ? args[checkIdx + 1] : null;

if (checkId) {
  const result = checkItem(checkId);
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.error) {
      console.log(result.error);
    } else {
      console.log(`\nScoping check: ${result.item.id} (${result.item.title})`);
      console.log(`Source: ${result.item.source}`);
      if (result.sourceProfile) {
        console.log(`Source profile: ${result.sourceProfile.total} items, ${result.sourceProfile.completionRate}% completed`);
      }
      if (result.warnings.length > 0) {
        console.log('\nWarnings:');
        result.warnings.forEach(w => console.log(`  - ${w}`));
      }
      console.log(`\nRecommendation: ${result.recommendation}`);
    }
  }
} else {
  const report = analyze();
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('=== Queue Scoping Analysis ===\n');
    console.log(`Resolved: ${report.summary.totalResolved} | Pending: ${report.summary.totalPending} | Completion rate: ${report.summary.overallCompletionRate}%`);

    console.log('\nBy Source:');
    for (const [src, data] of Object.entries(report.bySource)) {
      const warn = data.warning ? ` [${data.warning}]` : '';
      console.log(`  ${src}: ${data.total} items, ${data.completionRate}% completed, ${data.retirementRate}% retired${warn}`);
      if (Object.keys(data.qualityDistribution).length > 0) {
        const qd = Object.entries(data.qualityDistribution).map(([k, v]) => `${k}:${v}`).join(', ');
        console.log(`    Quality: ${qd}`);
      }
    }

    if (Object.keys(report.effortDistribution).length > 0) {
      console.log('\nEffort distribution (completed items):');
      for (const [effort, count] of Object.entries(report.effortDistribution)) {
        console.log(`  ${effort}: ${count}`);
      }
    }

    if (report.warnings.length > 0) {
      console.log('\nWarnings:');
      report.warnings.forEach(w => console.log(`  - ${w}`));
    }

    if (report.dataQuality.note) {
      console.log(`\nNote: ${report.dataQuality.note}`);
    }
    console.log(`\nData: ${report.dataQuality.structuredOutcomes} structured, ${report.dataQuality.inferredOutcomes} inferred outcomes`);
  }
}

export { analyze, checkItem, normalizeSource };

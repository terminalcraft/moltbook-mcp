#!/usr/bin/env node
// cost-forecast.mjs — Predict session costs from queue composition and history
// Usage: node cost-forecast.mjs [--json] [--type B|E|R|A]

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const HOME = process.env.HOME || '/home/moltbot';
const HISTORY_PATH = join(HOME, '.config/moltbook/session-history.txt');
const QUEUE_PATH = join(HOME, 'moltbook-mcp/work-queue.json');

// Effort classification heuristics
const HEAVY_KEYWORDS = ['refactor', 'rewrite', 'migrate', 'integration', 'build', 'implement', 'new feature', 'architect'];
const TRIVIAL_KEYWORDS = ['fix typo', 'update config', 'bump version', 'rename', 'cleanup', 'replenish', 'mark'];
const MODERATE_KEYWORDS = ['add test', 'fix bug', 'investigate', 'improve', 'update', 'extend'];

function classifyEffort(item) {
  const text = `${item.title} ${item.description || ''}`.toLowerCase();
  const tags = (item.tags || []).map(t => t.toLowerCase());

  // Items with testing tag tend to be moderate
  if (tags.includes('testing')) return 'moderate';
  // Security items tend to be heavy
  if (tags.includes('security')) return 'heavy';
  // Audit items tend to be trivial-moderate
  if (tags.includes('audit')) return 'moderate';
  // Tooling items tend to be moderate-heavy
  if (tags.includes('tooling')) return 'moderate';

  // Keyword matching
  if (TRIVIAL_KEYWORDS.some(k => text.includes(k))) return 'trivial';
  if (HEAVY_KEYWORDS.some(k => text.includes(k))) return 'heavy';
  if (MODERATE_KEYWORDS.some(k => text.includes(k))) return 'moderate';

  // Default based on description length (longer = more complex)
  const descLen = (item.description || '').length;
  if (descLen > 200) return 'heavy';
  if (descLen > 80) return 'moderate';
  return 'moderate'; // default to moderate
}

function parseHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  const lines = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map(line => {
    const modeMatch = line.match(/mode=(\w)/);
    const costMatch = line.match(/cost=\$([0-9.]+)/);
    const durMatch = line.match(/dur=(\d+)m(\d+)s/);
    const sessionMatch = line.match(/s=(\d+)/);
    const buildMatch = line.match(/build=(\d+)/);
    const noteMatch = line.match(/note:\s*(.+)/);
    if (!modeMatch || !costMatch) return null;
    return {
      mode: modeMatch[1],
      cost: parseFloat(costMatch[1]),
      duration: durMatch ? parseInt(durMatch[1]) * 60 + parseInt(durMatch[2]) : null,
      session: sessionMatch ? parseInt(sessionMatch[1]) : null,
      commits: buildMatch ? parseInt(buildMatch[1]) : 0,
      note: noteMatch ? noteMatch[1] : ''
    };
  }).filter(Boolean);
}

function computeStats(entries) {
  if (entries.length === 0) return { avg: 0, min: 0, max: 0, median: 0, count: 0 };
  const costs = entries.map(e => e.cost).sort((a, b) => a - b);
  const sum = costs.reduce((a, b) => a + b, 0);
  return {
    avg: sum / costs.length,
    min: costs[0],
    max: costs[costs.length - 1],
    median: costs[Math.floor(costs.length / 2)],
    count: costs.length
  };
}

// Estimate cost for an effort level using historical data
function effortCostMultiplier(effort, baseAvg) {
  // These multipliers are derived from observation:
  // trivial tasks ~60% of average, moderate ~100%, heavy ~140%
  const multipliers = { trivial: 0.6, moderate: 1.0, heavy: 1.4 };
  return (multipliers[effort] || 1.0) * baseAvg;
}

function loadQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  const data = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
  return data.queue || [];
}

function forecast(targetType) {
  const history = parseHistory();
  const queue = loadQueue();

  // Compute stats by session type
  const byType = {};
  for (const entry of history) {
    if (!byType[entry.mode]) byType[entry.mode] = [];
    byType[entry.mode].push(entry);
  }

  const typeStats = {};
  for (const [mode, entries] of Object.entries(byType)) {
    typeStats[mode] = computeStats(entries);
  }

  // Classify pending items
  const pending = queue.filter(i => i.status === 'pending');
  const classified = pending.map(item => ({
    id: item.id,
    title: item.title.slice(0, 60),
    effort: classifyEffort(item),
    tags: item.tags || []
  }));

  // Predict next session cost using target type's historical average
  const effectiveType = targetType || 'B';
  const targetStats = typeStats[effectiveType] || typeStats['B'] || { avg: 2.5, count: 0 };
  const topItem = classified[0];
  const predictedCost = topItem
    ? effortCostMultiplier(topItem.effort, targetStats.avg)
    : targetStats.avg;

  // Queue cost projection: total estimated cost to drain pending items
  // Queue items are consumed by B sessions, so always use B stats here
  const bStats = typeStats['B'] || { avg: 2.5, count: 0 };
  const totalQueueCost = classified.reduce((sum, item) => {
    return sum + effortCostMultiplier(item.effort, bStats.avg);
  }, 0);

  return {
    timestamp: new Date().toISOString(),
    sessionHistory: {
      total: history.length,
      byType: Object.fromEntries(
        Object.entries(typeStats).map(([k, v]) => [k, {
          count: v.count,
          avgCost: parseFloat(v.avg.toFixed(4)),
          medianCost: parseFloat(v.median.toFixed(4)),
          minCost: parseFloat(v.min.toFixed(4)),
          maxCost: parseFloat(v.max.toFixed(4))
        }])
      )
    },
    pendingQueue: {
      count: pending.length,
      items: classified,
      totalEstimatedCost: parseFloat(totalQueueCost.toFixed(2)),
      estimatedSessions: pending.length // 1 item per session on average
    },
    nextSession: {
      type: targetType || 'B',
      predictedCost: parseFloat(predictedCost.toFixed(2)),
      topItem: topItem || null,
      confidence: targetStats.count >= 10 ? 'high' : targetStats.count >= 5 ? 'medium' : 'low'
    }
  };
}

// CLI interface
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const typeArg = args.find(a => a.startsWith('--type='))?.split('=')[1]
  || (args.includes('--type') ? args[args.indexOf('--type') + 1] : null);

const result = forecast(typeArg);

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
} else {
  // Human-readable output
  console.log('=== Cost Forecast ===\n');

  console.log('Session History:');
  for (const [type, stats] of Object.entries(result.sessionHistory.byType)) {
    console.log(`  ${type}: ${stats.count} sessions, avg $${stats.avgCost}, median $${stats.medianCost} (range $${stats.minCost}-$${stats.maxCost})`);
  }

  console.log(`\nPending Queue: ${result.pendingQueue.count} items`);
  for (const item of result.pendingQueue.items) {
    const tags = item.tags.length ? ` [${item.tags.join(', ')}]` : '';
    console.log(`  ${item.id}: ${item.effort.padEnd(8)} ${item.title}${tags}`);
  }

  console.log(`\nQueue drain estimate: $${result.pendingQueue.totalEstimatedCost} across ~${result.pendingQueue.estimatedSessions} sessions`);
  console.log(`\nNext ${result.nextSession.type} session prediction: $${result.nextSession.predictedCost} (confidence: ${result.nextSession.confidence})`);
  if (result.nextSession.topItem) {
    console.log(`  Task: ${result.nextSession.topItem.id} (${result.nextSession.topItem.effort})`);
  }
}

// Export for programmatic use
export { forecast, classifyEffort, parseHistory, computeStats };

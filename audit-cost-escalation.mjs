#!/usr/bin/env node
/**
 * audit-cost-escalation.mjs — Auto-escalation for session cost trends
 *
 * Consumes e_cost_trend, r_cost_trend, b_cost_trend from audit-stats.mjs.
 * When threshold_crossed is true, auto-creates work-queue items with
 * ["audit", "cost"] tags — unless one already exists in pending state.
 *
 * Usage: node audit-cost-escalation.mjs [--dry-run]
 * Output: JSON summary of actions taken
 *
 * Created: B#560 (wq-884)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = join(__dirname, 'work-queue.json');
const dryRun = process.argv.includes('--dry-run');

// Cost trend configs: session type → { stats_key, tracker_key, threshold, label }
const COST_CONFIGS = [
  { type: 'B', statsKey: 'b_cost_trend', trackerKey: 'b_session_cost', threshold: 2.00, label: 'B session' },
  { type: 'E', statsKey: 'e_cost_trend', trackerKey: 'e_session_cost', threshold: 1.50, label: 'E session' },  // wq-890: threshold at $1.50, soft cap lowered to $1.80
  { type: 'R', statsKey: 'r_cost_trend', trackerKey: 'r_session_cost', threshold: 2.00, label: 'R session' },
];

function getStats() {
  try {
    const raw = execSync(`node ${join(__dirname, 'audit-stats.mjs')}`, {
      timeout: 15000,
      encoding: 'utf8',
    });
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function hasPendingCostItem(queue) {
  return queue.some(item =>
    item.status === 'pending' &&
    item.tags?.includes('audit') &&
    item.tags?.includes('cost')
  );
}

function getNextWqId(queue) {
  let maxId = 0;
  for (const item of queue) {
    const match = item.id?.match(/^wq-(\d+)$/);
    if (match) maxId = Math.max(maxId, parseInt(match[1]));
  }
  return `wq-${maxId + 1}`;
}

function run() {
  const stats = getStats();
  if (!stats) {
    console.log(JSON.stringify({ error: 'Failed to run audit-stats.mjs' }));
    process.exit(1);
  }

  const queueData = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
  const queue = queueData.queue || [];
  const existingCostItem = hasPendingCostItem(queue);

  const results = [];
  const created = [];

  for (const config of COST_CONFIGS) {
    const trend = stats[config.statsKey];
    if (!trend) {
      results.push({ type: config.type, action: 'skip', reason: 'no trend data' });
      continue;
    }

    const entry = {
      type: config.type,
      last5_avg: trend.last5_avg,
      threshold: config.threshold,
      threshold_crossed: trend.threshold_crossed,
      verdict: trend.verdict,
    };

    if (!trend.threshold_crossed) {
      entry.action = 'none';
      entry.reason = `last-5 avg $${trend.last5_avg} under $${config.threshold} threshold`;
      results.push(entry);
      continue;
    }

    // Threshold breached
    if (existingCostItem) {
      entry.action = 'skip';
      entry.reason = 'pending ["audit", "cost"] item already exists';
      results.push(entry);
      continue;
    }

    // Create wq item
    const newId = getNextWqId(queue);
    const sessionNum = stats.session || 0;
    const newItem = {
      id: newId,
      title: `Monitor ${config.label} cost trend — last-5 avg $${trend.last5_avg}`,
      description: `Auto-escalation: ${config.label} cost trend breached $${config.threshold} threshold. Last-5 avg $${trend.last5_avg} vs last-10 avg $${trend.last10_avg} (${trend.trend} ${trend.verdict}). Review session efficiency and enforce cost controls.`,
      priority: parseInt(newId.replace('wq-', '')),
      status: 'pending',
      added: new Date().toISOString().split('T')[0],
      created_session: sessionNum,
      source: `audit-cost-escalation-s${sessionNum}`,
      tags: ['audit', 'cost'],
      commits: [],
    };

    if (!dryRun) {
      queue.push(newItem);
    }

    entry.action = dryRun ? 'would_create' : 'created';
    entry.wq_id = newId;
    entry.reason = `last-5 avg $${trend.last5_avg} >= $${config.threshold}`;
    results.push(entry);
    created.push(newId);
  }

  // Write updated queue if items were created
  if (created.length > 0 && !dryRun) {
    writeFileSync(QUEUE_PATH, JSON.stringify(queueData, null, 2) + '\n');
  }

  const output = {
    dry_run: dryRun,
    session: stats.session,
    existing_cost_item: existingCostItem,
    checks: results,
    items_created: created,
  };

  console.log(JSON.stringify(output, null, 2));
}

run();

#!/usr/bin/env node
/**
 * audit-stats.mjs - Pre-computed statistics for A sessions
 *
 * Replaces manual file reading with a single stats summary.
 * Prevents context exhaustion from reading large archive files.
 *
 * Usage: node audit-stats.mjs
 * Output: JSON with all pipeline and session stats
 *
 * Created: R#130 (structural change to fix A session truncation)
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.config/moltbook');
const PROJECT_DIR = process.cwd();

function safeRead(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function computeIntelStats() {
  const current = safeRead(join(STATE_DIR, 'engagement-intel.json'), []);
  const archive = safeRead(join(STATE_DIR, 'engagement-intel-archive.json'), []);

  const consumed = archive.filter(e => e.consumed_session).length;
  const unconsumed = archive.filter(e => !e.consumed_session).length;
  const consumptionRate = archive.length > 0
    ? Math.round((consumed / archive.length) * 100)
    : 0;

  const byType = {};
  for (const e of archive) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }

  return {
    current: current.length,
    archived: archive.length,
    consumed,
    unconsumed,
    consumption_rate: `${consumptionRate}%`,
    verdict: consumptionRate >= 50 ? 'healthy' : 'failing',
    by_type: byType,
    oldest_current: current.length > 0
      ? current.reduce((min, e) => Math.min(min, e.session || Infinity), Infinity)
      : null
  };
}

function computeBrainstormingStats() {
  const path = join(PROJECT_DIR, 'BRAINSTORMING.md');
  if (!existsSync(path)) return { active: 0, avg_age: 0, ideas: [] };

  const content = readFileSync(path, 'utf8');
  const sessionMatch = content.match(/\(added ~s(\d+)\)/g) || [];
  const sessions = sessionMatch.map(m => parseInt(m.match(/s(\d+)/)[1]));

  // Get current session from env or estimate
  const currentSession = parseInt(process.env.SESSION_NUM || '825');
  const ages = sessions.map(s => currentSession - s);

  const stale = ages.filter(a => a > 30).length;
  const avgAge = ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;

  return {
    active: sessions.length,
    avg_age_sessions: avgAge,
    stale_count: stale,
    sessions: sessions.slice(0, 10),
    verdict: stale > 0 ? 'needs_cleanup' : (sessions.length < 3 ? 'needs_replenish' : 'healthy')
  };
}

function computeQueueStats() {
  const queue = safeRead(join(PROJECT_DIR, 'work-queue.json'), { queue: [] });
  const items = queue.queue || [];

  const statusCounts = {};
  const auditTagged = [];
  const stuck = [];
  const currentSession = parseInt(process.env.SESSION_NUM || '825');

  for (const item of items) {
    statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;

    if (item.tags?.includes('audit')) {
      auditTagged.push(item.id);
    }

    if (item.status === 'pending') {
      const createdSession = item.created_session || parseInt(item.added?.replace(/\D/g, '') || '0');
      if (currentSession - createdSession > 20) {
        stuck.push({ id: item.id, age: currentSession - createdSession });
      }
    }
  }

  return {
    total: items.length,
    by_status: statusCounts,
    audit_tagged: auditTagged,
    stuck_items: stuck,
    verdict: stuck.length > 0 ? 'has_stuck_items' : 'healthy'
  };
}

function computeDirectiveStats() {
  const directives = safeRead(join(PROJECT_DIR, 'directives.json'), { directives: [] });
  const items = directives.directives || [];
  const currentSession = parseInt(process.env.SESSION_NUM || '825');

  const active = items.filter(d => d.status === 'active');
  const pending = items.filter(d => d.status === 'pending');
  const completed = items.filter(d => d.status === 'completed');

  const unacted = active.filter(d => {
    const acked = d.acked_session || 0;
    return currentSession - acked > 20 && !d.queue_item;
  });

  return {
    total: items.length,
    active: active.length,
    pending: pending.length,
    completed: completed.length,
    unacted_active: unacted.map(d => d.id),
    verdict: unacted.length > 0 ? 'has_unacted' : 'healthy'
  };
}

function computeSessionStats() {
  // Read from session-history.txt instead of individual .summary files
  const historyPath = join(STATE_DIR, 'session-history.txt');

  if (!existsSync(historyPath)) return { summary: {} };

  try {
    const content = readFileSync(historyPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const summaries = [];
    for (const line of lines) {
      // Format: 2026-02-03 mode=B s=814 dur=4m10s cost=$1.1756 ...
      const modeMatch = line.match(/mode=([BERA])/);
      const costMatch = line.match(/cost=\$?([\d.]+)/);
      const sessionMatch = line.match(/s=(\d+)/);

      if (modeMatch && costMatch && sessionMatch) {
        summaries.push({
          type: modeMatch[1],
          session: parseInt(sessionMatch[1]),
          cost: parseFloat(costMatch[1])
        });
      }
    }

    // Group by type and compute averages
    const byType = {};
    for (const s of summaries) {
      if (!byType[s.type]) byType[s.type] = [];
      byType[s.type].push(s);
    }

    const summary = {};
    for (const type of ['B', 'E', 'R', 'A']) {
      const entries = byType[type] || [];
      const last10 = entries.slice(-10);
      const costs = last10.map(e => e.cost);
      const avg = costs.length > 0
        ? Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 100) / 100
        : 0;

      summary[type] = {
        count_in_history: entries.length,
        avg_cost_last_10: avg,
        verdict: avg > 2.0 ? 'high_cost' : (avg < 0.3 ? 'low_cost' : 'normal')
      };
    }

    return { summary };
  } catch {
    return { summary: {} };
  }
}

// Main output
const stats = {
  computed_at: new Date().toISOString(),
  session: parseInt(process.env.SESSION_NUM || '825'),
  pipelines: {
    intel: computeIntelStats(),
    brainstorming: computeBrainstormingStats(),
    queue: computeQueueStats(),
    directives: computeDirectiveStats()
  },
  sessions: computeSessionStats()
};

console.log(JSON.stringify(stats, null, 2));

// hook-health.mjs — Hook health analysis extracted from session-context.mjs (R#349).
// Reads structured hook results, computes per-hook moving averages,
// and surfaces actionable warnings for slow or failing hooks.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SLOW_THRESHOLD_MS = 5000;
const FAIL_THRESHOLD = 3; // 3+ failures in last 10 = consistently failing
const HISTORY_DEPTH = 10; // Analyze last N sessions

/**
 * Analyze hook execution results and return health data.
 * @param {string} stateDir - Path to ~/.config/moltbook
 * @returns {{ slow: Array, failing: Array, warning: string|null }}
 */
export function analyzeHookHealth(stateDir) {
  const hookResultFiles = [
    join(stateDir, 'logs/pre-hook-results.json'),
    join(stateDir, 'logs/post-hook-results.json'),
  ];

  const hookStats = {}; // key -> { totalMs, count, failures, phase, hook }

  for (const filePath of hookResultFiles) {
    if (!existsSync(filePath)) continue;
    const phase = filePath.includes('pre-') ? 'pre' : 'post';
    try {
      const raw = readFileSync(filePath, 'utf8').trim();
      const lines = raw.split('\n').slice(-HISTORY_DEPTH);
      for (const line of lines) {
        const entry = JSON.parse(line);
        if (!entry.hooks) continue;
        for (const h of entry.hooks) {
          const key = `${phase}:${h.hook}`;
          if (!hookStats[key]) hookStats[key] = { totalMs: 0, count: 0, failures: 0, phase, hook: h.hook };
          hookStats[key].totalMs += h.ms;
          hookStats[key].count += 1;
          if (h.status && h.status.startsWith('fail')) hookStats[key].failures += 1;
        }
      }
    } catch { /* skip malformed files */ }
  }

  const slow = [];
  const failing = [];

  for (const [, stats] of Object.entries(hookStats)) {
    if (stats.count === 0) continue;
    const avgMs = Math.round(stats.totalMs / stats.count);
    if (avgMs >= SLOW_THRESHOLD_MS) {
      slow.push({ hook: stats.hook, phase: stats.phase, avg_ms: avgMs, samples: stats.count });
    }
    if (stats.failures >= FAIL_THRESHOLD) {
      failing.push({ hook: stats.hook, phase: stats.phase, fail_count: stats.failures, samples: stats.count });
    }
  }

  slow.sort((a, b) => b.avg_ms - a.avg_ms);
  failing.sort((a, b) => b.fail_count - a.fail_count);

  let warning = null;
  if (slow.length > 0 || failing.length > 0) {
    const parts = [];
    if (slow.length > 0) {
      parts.push(`${slow.length} slow hook(s): ${slow.map(h => `${h.phase}/${h.hook} avg ${h.avg_ms}ms`).join(', ')}`);
    }
    if (failing.length > 0) {
      parts.push(`${failing.length} failing hook(s): ${failing.map(h => `${h.phase}/${h.hook} ${h.fail_count}/${h.samples} failures`).join(', ')}`);
    }
    warning = parts.join(' | ');
  }

  return { slow, failing, warning };
}

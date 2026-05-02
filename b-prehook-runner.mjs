#!/usr/bin/env node
/**
 * b-prehook-runner.mjs — Single-process runner for B session prehook checks.
 *
 * Replaces 2 node subprocess invocations + multiple jq calls in
 * 45-b-session-prehook_B.sh:
 *   1. queue-title-lint.mjs    → lintTitles()
 *   2. pipeline-nudge-stats.mjs → getPipelineGateStats()
 *   3. Stuck items detection    (replaces jq loop in bash)
 *
 * Truncation detection remains in bash (filesystem/date operations
 * that are natural in shell).
 *
 * Eliminates ~200-400ms combined subprocess startup overhead.
 *
 * Usage: node b-prehook-runner.mjs <session_num> <mcp_dir> <queue_path> <history_path>
 *
 * Output: JSON with results from all checks.
 *
 * Created: wq-1006 (d079 deliverable 2)
 */

import { readFileSync } from 'fs';
import { safeRun } from './lib/runner-utils.mjs';
import { lintTitles } from './queue-title-lint.mjs';
import { getPipelineGateStats } from './hooks/lib/pipeline-nudge-stats.mjs';

const sessionNum = parseInt(process.argv[2], 10) || 0;
const mcpDir = process.argv[3] || '.';
const queuePath = process.argv[4] || 'work-queue.json';
const historyPath = process.argv[5] || '';

// ---- Check 1: Queue title lint ----

const titleLint = safeRun('queue-title-lint', () => lintTitles(queuePath));

// ---- Check 2: Stuck items detection (replaces jq loop in bash) ----

const stuckItems = safeRun('stuck-items', () => {
  const data = JSON.parse(readFileSync(queuePath, 'utf8'));
  const inProgress = data.queue.filter(i => i.status === 'in-progress');

  if (inProgress.length === 0 || !historyPath) {
    return { items: [], count: 0 };
  }

  let currentSession = 0;
  try {
    const histLines = readFileSync(historyPath, 'utf8').trim().split('\n');
    const lastLine = histLines[histLines.length - 1] || '';
    const match = lastLine.match(/s=(\d+)/);
    if (match) currentSession = parseInt(match[1], 10);
  } catch {
    return { items: [], count: 0 };
  }

  if (currentSession === 0) return { items: [], count: 0 };

  const stuck = [];
  for (const item of inProgress) {
    let startSession = item.created_session || 0;

    if (startSession === 0 && item.notes) {
      const sRef = item.notes.match(/\bs(\d{3,})/);
      if (sRef) startSession = parseInt(sRef[1], 10);
    }

    if (startSession === 0) continue;

    const elapsed = currentSession - startSession;
    const bSessionsApprox = Math.floor(elapsed * 60 / 100);

    if (bSessionsApprox >= 5) {
      stuck.push({
        id: item.id,
        title: item.title,
        startSession,
        bSessionsApprox,
      });
    }
  }

  return { items: stuck, count: stuck.length };
});

// ---- Check 3: Pipeline nudge stats ----

const pipelineNudge = safeRun('pipeline-nudge', () => {
  return getPipelineGateStats(sessionNum, mcpDir);
});

// ---- Output ----

const output = {
  title_lint: titleLint.ok ? titleLint.result : { error: titleLint.error },
  stuck_items: stuckItems.ok ? stuckItems.result : { error: stuckItems.error },
  pipeline_nudge: pipelineNudge.ok ? pipelineNudge.result : { error: pipelineNudge.error },
};

console.log(JSON.stringify(output));

#!/usr/bin/env node
// session-file-sizes.mjs — History tracking + token budget auto-queue for session files
// Extracted from hooks/pre-session/27-session-file-sizes.sh (R#328, d074)
//
// Usage (CLI): node session-file-sizes.mjs <command> [args...]
//   history <history-path> <snapshot-json> [limit]  — append snapshot to history
//   token-warnings <token-result-json>              — extract over-budget file warnings
//   auto-queue <token-result-json> <wq-path> <session>  — create wq items for over-budget files
//
// Usage (import):
//   import { appendHistory, extractTokenWarnings, autoQueueOverBudget } from './session-file-sizes.mjs';

import { readFileSync, writeFileSync, existsSync } from 'fs';

function loadJSON(filepath) {
  try { return JSON.parse(readFileSync(filepath, 'utf-8')); } catch { return null; }
}

/**
 * Append a snapshot to the history file, keeping the last `limit` entries.
 * Creates the history file if it doesn't exist.
 */
export function appendHistory(historyPath, snapshot, limit = 50) {
  let history;
  if (existsSync(historyPath)) {
    history = loadJSON(historyPath);
    if (!history || !Array.isArray(history.snapshots)) {
      history = { version: 1, snapshots: [] };
    }
  } else {
    history = { version: 1, snapshots: [] };
  }
  history.snapshots.push(snapshot);
  if (history.snapshots.length > limit) {
    history.snapshots = history.snapshots.slice(-limit);
  }
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

/**
 * Extract warning lines for over-budget files from token-budget-estimator output.
 * Returns array of "filename: N tokens" strings.
 */
export function extractTokenWarnings(tokenResult) {
  if (!tokenResult || !tokenResult.files) return [];
  return tokenResult.files
    .filter(f => f.overBudget)
    .map(f => `${f.file}: ${f.tokens} tokens`);
}

/**
 * Auto-generate work-queue items for over-budget files.
 * Returns number of items added.
 */
export function autoQueueOverBudget(tokenResult, wqPath, session) {
  if (!tokenResult || !tokenResult.files) return 0;

  const wq = loadJSON(wqPath);
  if (!wq || !Array.isArray(wq.queue)) return 0;

  const existing = wq.queue.map(i =>
    (i.title + ' ' + (i.description || '')).toLowerCase()
  );
  const overBudget = tokenResult.files.filter(f => f.overBudget);

  let added = 0;
  for (const f of overBudget) {
    const fname = f.file.toLowerCase();
    const hasItem = existing.some(t =>
      t.includes(fname) && (t.includes('slim') || t.includes('token') || t.includes('prompt-budget'))
    );
    if (hasItem) continue;

    const ids = wq.queue
      .map(i => parseInt(i.id.replace('wq-', ''), 10))
      .filter(n => !isNaN(n));
    const nextId = 'wq-' + (Math.max(...ids) + 1 + added);

    wq.queue.push({
      id: nextId,
      title: `Slim ${f.file} — ${f.tokens} tokens (over ${tokenResult.threshold} budget)`,
      description: `Auto-generated: ${f.file} is ${f.tokens} tokens, exceeding the ${tokenResult.threshold}-token prompt budget. Extract sections, compress, or split to reduce cognitive load.`,
      priority: parseInt(nextId.replace('wq-', ''), 10),
      status: 'pending',
      added: new Date().toISOString().split('T')[0],
      created_session: session,
      source: 'hook:27-session-file-sizes',
      tags: ['auto-seeded', 'prompt-budget'],
      commits: []
    });
    added++;
  }

  if (added > 0) {
    writeFileSync(wqPath, JSON.stringify(wq, null, 2) + '\n');
  }
  return added;
}

// CLI dispatch
if (process.argv[1] && process.argv[1].endsWith('session-file-sizes.mjs')) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'history') {
      const historyPath = process.argv[3];
      const snapshot = JSON.parse(process.argv[4]);
      const limit = parseInt(process.argv[5]) || 50;
      appendHistory(historyPath, snapshot, limit);
    } else if (cmd === 'token-warnings') {
      const tokenResult = JSON.parse(process.argv[3]);
      const warnings = extractTokenWarnings(tokenResult);
      warnings.forEach(w => console.log(w));
    } else if (cmd === 'auto-queue') {
      const tokenResult = JSON.parse(process.argv[3]);
      const wqPath = process.argv[4];
      const session = parseInt(process.argv[5]) || 0;
      const added = autoQueueOverBudget(tokenResult, wqPath, session);
      if (added > 0) {
        process.stderr.write(`TOKEN_BUDGET_AUTO_QUEUE: Added ${added} work-queue item(s) for over-budget files\n`);
      }
    } else {
      console.error('Usage: session-file-sizes.mjs <history|token-warnings|auto-queue> [args...]');
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

#!/usr/bin/env node
// truncation-recovery.mjs — Detect truncated B sessions and re-queue assigned items.
//
// Extracted from 47-b-session-posthook_B.sh Check 2 (R#313).
// Replaces 3 inline `node -e` calls with a single testable module.
//
// Usage (CLI):  node truncation-recovery.mjs <session_num> <log_file> <wq_path> <audit_path>
// Usage (lib):  import { computeDuration, recoverTruncated } from './truncation-recovery.mjs'

import { readFileSync, writeFileSync, appendFileSync } from 'fs';

/**
 * Compute session duration in seconds from a session log file.
 * Parses first and last ISO timestamps from JSONL entries.
 * Returns 999 if timestamps cannot be extracted (safe fallback = "not truncated").
 */
export function computeDuration(logContent) {
  if (!logContent) return 999;
  const lines = logContent.split('\n');
  const pat = /"timestamp":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;
  let first = null, last = null;

  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const m = pat.exec(lines[i]);
    if (m) { first = m[1]; break; }
  }
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
    const m = pat.exec(lines[i]);
    if (m) { last = m[1]; break; }
  }

  if (first && last) {
    return Math.floor((new Date(last) - new Date(first)) / 1000);
  }
  return 999;
}

/**
 * Find the first wq-NNN reference in log content.
 */
export function findAssignedItem(logContent) {
  if (!logContent) return null;
  const m = logContent.match(/wq-\d+/);
  return m ? m[0] : null;
}

/**
 * Look up a queue item's status.
 * @param {object} wqData - Parsed work-queue.json content
 * @param {string} itemId - e.g. "wq-123"
 * @returns {string} status or "not_found"
 */
export function getItemStatus(wqData, itemId) {
  if (!wqData?.queue) return 'not_found';
  const item = wqData.queue.find(i => i.id === itemId);
  return item ? (item.status || 'unknown') : 'not_found';
}

/**
 * Re-queue a truncated item back to pending.
 * Mutates wqData in place. Returns true if recovery happened.
 */
export function requeue(wqData, itemId, sessionNum, duration) {
  if (!wqData?.queue) return false;
  const item = wqData.queue.find(i => i.id === itemId);
  if (!item || item.status === 'done') return false;
  const prevStatus = item.status;
  item.status = 'pending';
  if (!item.notes) item.notes = '';
  item.notes += ` [truncation-recovery s${sessionNum}: was ${prevStatus}, ${duration}s, re-queued]`;
  return true;
}

/**
 * Full truncation recovery flow.
 * @param {object} opts
 * @param {number} opts.sessionNum
 * @param {string} opts.logContent - Raw session log content
 * @param {object} opts.wqData - Parsed work-queue.json
 * @param {number} [opts.minDuration=180] - Minimum seconds before considered non-truncated
 * @param {number} [opts.commitCount=0] - Number of commits in this session
 * @returns {{ action: string, itemId?: string, duration?: number }}
 */
export function recoverTruncated({ sessionNum, logContent, wqData, minDuration = 180, commitCount = 0 }) {
  const duration = computeDuration(logContent);

  if (duration >= minDuration) {
    return { action: 'skip', reason: 'duration_ok', duration };
  }
  if (commitCount > 0) {
    return { action: 'skip', reason: 'has_commits', duration };
  }

  const itemId = findAssignedItem(logContent);
  if (!itemId) {
    return { action: 'no_item', duration };
  }

  const status = getItemStatus(wqData, itemId);
  if (status === 'done' || status === 'not_found') {
    return { action: 'skip', reason: `item_${status}`, itemId, duration };
  }

  const recovered = requeue(wqData, itemId, sessionNum, duration);
  return { action: recovered ? 'recovered' : 'skip', itemId, duration };
}

// --- CLI entrypoint ---
if (process.argv[1]?.endsWith('truncation-recovery.mjs')) {
  const [,, sessionNum, logFile, wqPath, auditPath, commitCountStr] = process.argv;
  if (!sessionNum || !logFile || !wqPath) {
    console.error('Usage: node truncation-recovery.mjs <session_num> <log_file> <wq_path> [audit_path] [commit_count]');
    process.exit(1);
  }

  let logContent = '';
  try { logContent = readFileSync(logFile, 'utf8'); } catch { /* missing log */ }

  let wqData = null;
  try { wqData = JSON.parse(readFileSync(wqPath, 'utf8')); } catch { /* missing wq */ }

  const result = recoverTruncated({
    sessionNum: parseInt(sessionNum, 10),
    logContent,
    wqData,
    commitCount: parseInt(commitCountStr || '0', 10),
  });

  if (result.action === 'recovered') {
    writeFileSync(wqPath, JSON.stringify(wqData, null, 2) + '\n');
    const msg = `${new Date().toISOString()} s=${sessionNum} RECOVERED: ${result.itemId} truncated after ${result.duration}s with 0 commits — re-queued as pending`;
    console.log(msg);
    if (auditPath) {
      try { appendFileSync(auditPath, `WARN: B session s${sessionNum} early stall (${result.duration}s, 0 commits, ${result.itemId} re-queued)\n`); } catch {}
    }
  } else if (result.action === 'no_item') {
    console.log(`${new Date().toISOString()} s=${sessionNum} truncated (${result.duration}s, 0 commits) but no assigned item found`);
  } else {
    console.log(`truncation-recovery: skip (${result.reason || 'ok'})`);
  }
}

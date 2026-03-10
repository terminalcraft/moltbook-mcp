#!/usr/bin/env node
// directive-analysis.mjs — Analyze directive staleness and maintenance needs.
//
// Invoked by 35-r-session-prehook_R.sh.
// Replaces shell-level session-number parsing and threshold logic with testable JS.
//
// Usage (CLI):  node directive-analysis.mjs <session_num> <directives_path> <queue_path> <history_path>
// Usage (lib):  import { analyzeDirectives } from './directive-analysis.mjs'

import { readFileSync } from 'fs';

/**
 * Extract the maximum session number from a notes string.
 * Handles patterns: s1234, s=1234, R#286, A#169, B#304, E#175
 * For type-session refs (R#/A#/B#/E#), resolves via session-history lines.
 */
export function extractMaxSessionFromNotes(notes, historyLines) {
  if (!notes) return 0;
  let max = 0;

  // Direct session references: s1234, s=1234
  const directPattern = /s=?(\d{3,})/g;
  let m;
  while ((m = directPattern.exec(notes)) !== null) {
    const num = parseInt(m[1], 10);
    if (num > max) max = num;
  }

  // Type-session references: R#286, A#169, B#304, E#175
  const typePattern = /[RABE]#(\d+)/g;
  const refs = [];
  while ((m = typePattern.exec(notes)) !== null) {
    refs.push(m[0]); // e.g. "R#286"
  }

  if (refs.length > 0 && historyLines) {
    for (const ref of refs) {
      const resolved = lookupTypeSession(ref, historyLines);
      if (resolved > max) max = resolved;
    }
  }

  return max;
}

/**
 * Look up the actual session number for a type-session reference.
 * Searches session-history.txt lines for the reference and extracts s=NNNN.
 */
export function lookupTypeSession(ref, historyLines) {
  for (let i = historyLines.length - 1; i >= 0; i--) {
    if (historyLines[i].includes(ref)) {
      const m = /s=(\d+)/.exec(historyLines[i]);
      if (m) return parseInt(m[1], 10);
    }
  }
  return 0;
}

/**
 * Determine threshold tier for a directive based on its type.
 * - system: ongoing monitors (d049), longer thresholds
 * - scoped: standing behavioral rules with scope field
 * - default: task-oriented directives
 */
export function getThresholds(directive) {
  const hasScope = directive.scope && directive.scope !== 'null' && directive.scope !== null;

  if (directive.from === 'system') {
    return { stale: 60, needsUpdate: 40, type: 'system' };
  }
  if (hasScope) {
    return { stale: 50, needsUpdate: 35, type: 'scoped' };
  }
  return { stale: 30, needsUpdate: 20, type: 'default' };
}

/**
 * Analyze all active directives and return status results.
 *
 * @param {Object} params
 * @param {number} params.sessionNum - Current session number
 * @param {Object} params.directives - Parsed directives.json
 * @param {Object} params.queue - Parsed work-queue.json
 * @param {string[]} params.historyLines - Lines from session-history.txt
 * @returns {{ results: Array, pendingQuestions: Array, summary: string }}
 */
export function analyzeDirectives({ sessionNum, directives, queue, historyLines }) {
  const results = [];
  const standing = [];
  let needsAttention = 0;
  let healthy = 0;

  // Build set of active queue item text for cross-reference
  const activeQueueText = (queue?.queue || [])
    .filter(item => item.status === 'pending' || item.status === 'in-progress')
    .map(item => (item.title || item.description || '').toLowerCase())
    .join('|');

  for (const d of (directives?.directives || [])) {
    // Standing directives are ongoing enforcement rules, not tasks.
    // They're enforced by session-type hooks, not R session attention.
    if (d.status === 'standing') {
      standing.push({
        id: d.id,
        scope: d.scope || '?',
        content: (d.content || '').slice(0, 60)
      });
      healthy++;
      continue;
    }

    if (d.status !== 'active') continue;

    const thresholds = getThresholds(d);
    const hasScope = thresholds.type === 'scoped';

    // Calculate last activity session
    let lastActivity = 0;
    if (d.acked_session && d.acked_session !== 'null') {
      lastActivity = parseInt(d.acked_session, 10) || 0;
    }

    const notesSession = extractMaxSessionFromNotes(d.notes, historyLines);
    if (notesSession > lastActivity) lastActivity = notesSession;

    const sessionsSince = lastActivity > 0 ? sessionNum - lastActivity : 999;

    // Check if directive has corresponding queue item
    const hasQueue = d.id && activeQueueText.includes(d.id.toLowerCase());

    const contentShort = (d.content || '').slice(0, 60);

    // Determine status
    let status;
    if (sessionsSince > thresholds.stale) {
      status = 'STALE';
      results.push({
        status: 'STALE',
        id: d.id,
        sessionsSince,
        lastActivity,
        threshold: thresholds.stale,
        content: contentShort
      });
      needsAttention++;
    } else if (sessionsSince > thresholds.needsUpdate && !hasQueue && !hasScope) {
      status = 'NEEDS_UPDATE';
      results.push({
        status: 'NEEDS_UPDATE',
        id: d.id,
        sessionsSince,
        threshold: thresholds.needsUpdate,
        content: contentShort,
        reason: 'no queue item'
      });
    } else if (sessionsSince > thresholds.needsUpdate && hasScope) {
      status = 'NEEDS_UPDATE';
      results.push({
        status: 'NEEDS_UPDATE',
        id: d.id,
        sessionsSince,
        threshold: thresholds.needsUpdate,
        content: contentShort,
        scope: d.scope,
        reason: 'standing/scope'
      });
      needsAttention++;
    } else {
      healthy++;
    }
  }

  // Check pending questions
  const pendingQuestions = (directives?.questions || [])
    .filter(q => q.status === 'pending')
    .map(q => ({ id: q.id, question: (q.question || '').slice(0, 50) }));

  if (pendingQuestions.length > 0) needsAttention++;

  const summary = needsAttention === 0
    ? `All ${healthy} active directives healthy. Add review note to most recent.`
    : `${needsAttention} directive(s) need attention, ${healthy} healthy.`;

  return { results, pendingQuestions, standing, summary, needsAttention, healthy };
}

/**
 * Format analysis results as text output matching the original shell format.
 */
export function formatResults({ results, pendingQuestions, standing, summary }) {
  const lines = [];

  for (const r of results) {
    if (r.status === 'STALE') {
      lines.push(`STALE: ${r.id} (${r.sessionsSince} sessions since s${r.lastActivity}, threshold=${r.threshold}) - ${r.content}...`);
    } else if (r.status === 'NEEDS_UPDATE' && r.scope) {
      lines.push(`NEEDS_UPDATE: ${r.id} (${r.sessionsSince} sessions, standing/scope=${r.scope}, threshold=${r.threshold}) - ${r.content}...`);
    } else if (r.status === 'NEEDS_UPDATE') {
      lines.push(`NEEDS_UPDATE: ${r.id} (${r.sessionsSince} sessions, no queue item, threshold=${r.threshold}) - ${r.content}...`);
    }
  }

  if (standing && standing.length > 0) {
    lines.push(`STANDING: ${standing.map(s => `${s.id}(${s.scope})`).join(', ')} — enforced by session-type hooks`);
  }

  if (pendingQuestions.length > 0) {
    lines.push('');
    lines.push('PENDING QUESTIONS (awaiting human):');
    for (const q of pendingQuestions) {
      lines.push(`${q.id}: ${q.question}...`);
    }
  }

  lines.push('');
  lines.push(`SUMMARY: ${summary}`);
  return lines.join('\n');
}

// CLI entry point
if (process.argv[1]?.endsWith('directive-analysis.mjs')) {
  const sessionNum = parseInt(process.argv[2], 10);
  const directivesPath = process.argv[3];
  const queuePath = process.argv[4];
  const historyPath = process.argv[5];

  if (!sessionNum || !directivesPath) {
    console.error('Usage: node directive-analysis.mjs <session_num> <directives_path> <queue_path> <history_path>');
    process.exit(1);
  }

  const directives = JSON.parse(readFileSync(directivesPath, 'utf8'));
  let queue = { queue: [] };
  try { queue = JSON.parse(readFileSync(queuePath, 'utf8')); } catch {}
  let historyLines = [];
  try { historyLines = readFileSync(historyPath, 'utf8').split('\n'); } catch {}

  const analysis = analyzeDirectives({ sessionNum, directives, queue, historyLines });
  console.log(formatResults(analysis));
}

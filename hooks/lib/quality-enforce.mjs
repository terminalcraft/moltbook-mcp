#!/usr/bin/env node
// quality-enforce.mjs — Rolling quality metrics calculator
// Extracted from 36-e-session-posthook_E.sh Check 7 (R#312)
//
// Reads quality-scores.jsonl, calculates rolling fail rate, streak, top violation,
// and writes enforcement record to quality-enforcement.jsonl.
//
// Env vars: SESSION, QUALITY_SCORES (input), ENFORCE_FILE (output)

import { readFileSync, writeFileSync, existsSync } from 'fs';

const session = parseInt(process.env.SESSION);
const scoresFile = process.env.QUALITY_SCORES;
const enforceFile = process.env.ENFORCE_FILE;

if (!session || !scoresFile || !enforceFile) {
  console.log('quality-enforce: missing env vars (SESSION, QUALITY_SCORES, ENFORCE_FILE)');
  process.exit(0);
}

if (!existsSync(scoresFile)) {
  console.log('quality-enforce: no quality history, skipping');
  process.exit(0);
}

const lines = readFileSync(scoresFile, 'utf8').trim().split('\n').filter(Boolean);
const entries = [];
for (const line of lines) {
  try { entries.push(JSON.parse(line)); } catch {}
}

if (entries.length === 0) {
  console.log('quality-enforce: no entries, skipping');
  process.exit(0);
}

const sessionEntries = entries.filter(e => e.session === session);
const sessionFails = sessionEntries.filter(e => e.verdict === 'FAIL').length;
const sessionTotal = sessionEntries.length;

const recent10 = entries.slice(-10);
const recentFails = recent10.filter(e => e.verdict === 'FAIL').length;
const recentFailRate = recentFails / recent10.length;

let streak = 0;
for (let i = entries.length - 1; i >= 0; i--) {
  if (entries[i].verdict === 'FAIL') streak++;
  else break;
}

const violFreq = {};
for (const e of recent10) {
  for (const v of (e.violations || [])) {
    violFreq[v] = (violFreq[v] || 0) + 1;
  }
}
const topViolation = Object.entries(violFreq).sort((a, b) => b[1] - a[1])[0];

const composites = recent10.map(e => e.composite).filter(c => typeof c === 'number');
const avgComposite = composites.length ? +(composites.reduce((a, b) => a + b, 0) / composites.length).toFixed(3) : null;

let level = 'ok';
let action = null;
if (recentFailRate > 0.6) {
  level = 'critical';
  action = 'Next E session: mandatory rewrite of any post scoring below 0.8. Consider pausing engagement until quality improves.';
} else if (recentFailRate > 0.4) {
  level = 'degraded';
  action = 'Next E session: extra scrutiny on formulaic patterns. Review top violation type.';
} else if (streak >= 3) {
  level = 'streak_warning';
  action = 'Consecutive failures detected. Break the pattern — try a different rhetorical approach.';
}

const record = {
  ts: new Date().toISOString(),
  session,
  session_posts: sessionTotal,
  session_fails: sessionFails,
  rolling_fail_rate: +recentFailRate.toFixed(3),
  rolling_avg_composite: avgComposite,
  fail_streak: streak,
  top_violation: topViolation ? topViolation[0] : null,
  level,
  action,
};

const existingLines = existsSync(enforceFile) ? readFileSync(enforceFile, 'utf8').trim().split('\n').filter(Boolean) : [];
if (existingLines.length >= 50) existingLines.splice(0, existingLines.length - 49);
existingLines.push(JSON.stringify(record));
writeFileSync(enforceFile, existingLines.join('\n') + '\n');

const statusIcon = level === 'ok' ? '✓' : level === 'degraded' ? '⚠' : level === 'critical' ? '✗' : '△';
console.log(`quality-enforce: ${statusIcon} s${session} — ${sessionTotal} posts (${sessionFails} fails), rolling fail rate: ${(recentFailRate * 100).toFixed(1)}%, streak: ${streak}, level: ${level}`);
if (action) console.log(`quality-enforce: ACTION: ${action}`);

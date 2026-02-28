#!/usr/bin/env node
/**
 * Write a single engagement log entry for an E session.
 * Called by post-hook 17-engagement-log.sh.
 * Args: session_num
 * Reads session note from session-history.txt, writes to engagement-log.json.
 *
 * Migrated from engagement-log-entry.py (wq-728, B#485)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const sessionNum = parseInt(process.argv[2], 10);
if (!sessionNum) {
  console.error('Usage: engagement-log-entry.mjs <session_num>');
  process.exit(1);
}

const stateDir = join(homedir(), '.config/moltbook');
const historyFile = join(stateDir, 'session-history.txt');
const logFile = join(stateDir, 'engagement-log.json');

const PLATFORMS = {
  '4claw': [/\b4claw\b/i, /\bfourclaw\b/i],
  'chatr': [/\bchatr\b/i],
  'moltbook': [/\bmoltbook\b/i],
  'colony': [/\bcolony\b/i, /\bthecolony\b/i],
  'mdi': [/\bmdi\b/i, /\bmydeadinternet\b/i],
  'tulip': [/\btulip\b/i],
  'grove': [/\bgrove\b/i],
  'moltchan': [/\bmoltchan\b/i],
  'lobchan': [/\blobchan\b/i],
  'ctxly': [/\bctxly\b/i],
};

// Find session note
if (!existsSync(historyFile)) process.exit(0);
const lines = readFileSync(historyFile, 'utf8').split('\n');
const noteLine = lines.find(l => new RegExp(`mode=E\\s+s=${sessionNum}\\b`).test(l));
if (!noteLine) {
  console.log(`No E session note for s=${sessionNum}`);
  process.exit(0);
}

// Parse cost
const costMatch = noteLine.match(/cost=\$?([\d.]+)/);
const cost = costMatch ? parseFloat(costMatch[1]) : 0;

// Extract note
const noteMatch = noteLine.match(/note:\s*(.*)/);
const note = noteMatch ? noteMatch[1] : noteLine;

function classify(platform, patterns, noteText) {
  const clauses = noteText.split('.');
  let relevant = clauses.filter(c => patterns.some(p => p.test(c)));
  if (relevant.length === 0) relevant = [noteText];
  const ctx = relevant.join(' ');

  const actions = [];
  if (/\b(replied|commented)\b/i.test(ctx)) actions.push('replied');
  if (/\bposted\b/i.test(ctx)) actions.push('posted');
  if (/\bregistered\b/i.test(ctx)) actions.push('registered');
  if (/\b(queued|sent)\b.*msg/i.test(ctx)) actions.push('messaged');
  if (/\bscanned\b/i.test(ctx)) actions.push('scanned');

  const isDegraded = /\b(broken|dead|empty|401|403)\b/i.test(ctx);
  const isProductive = /\b(collaboration|interop|exchange|good content)\b/i.test(ctx);

  if (isProductive) return { actions: actions.length ? actions : ['mentioned'], outcome: 'productive' };
  if (isDegraded && !actions.length) return { actions: actions.length ? actions : ['mentioned'], outcome: 'degraded' };
  if (actions.length) return { actions, outcome: 'active' };
  return { actions: ['mentioned'], outcome: 'neutral' };
}

const interactions = [];
for (const [plat, patterns] of Object.entries(PLATFORMS)) {
  if (!patterns.some(p => p.test(note))) continue;
  const { actions, outcome } = classify(plat, patterns, note);
  interactions.push({ platform: plat, actions, outcome });
}

const entry = {
  timestamp: new Date().toISOString(),
  session: sessionNum,
  cost_usd: cost,
  platforms_engaged: interactions.length,
  interactions,
};

// Load, append, cap, save
let data = [];
if (existsSync(logFile)) {
  try { data = JSON.parse(readFileSync(logFile, 'utf8')); } catch { data = []; }
}
data.push(entry);
if (data.length > 200) data = data.slice(-200);
writeFileSync(logFile, JSON.stringify(data, null, 2));
console.log(`engagement-log: s=${sessionNum} logged ${interactions.length} platform interactions`);

// Diversity warning
const MIN_DIVERSITY = 3;
const WINDOW = 5;
const recent = data.filter(e => (e.platforms_engaged || 0) > 0).slice(-WINDOW);
if (recent.length >= WINDOW) {
  const avg = recent.reduce((s, e) => s + e.platforms_engaged, 0) / recent.length;
  if (avg < MIN_DIVERSITY) {
    const sessions = recent.map(e => e.session || '?').join(', ');
    console.log(`⚠ DIVERSITY WARNING: Last ${WINDOW} E sessions averaged ${avg.toFixed(1)} platforms (threshold: ${MIN_DIVERSITY}). Sessions: ${sessions}`);
  }
}

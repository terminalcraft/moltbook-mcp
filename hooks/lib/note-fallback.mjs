#!/usr/bin/env node
// note-fallback.mjs — Replaces truncated session-history notes with trace-derived summaries
// Extracted from 36-e-session-posthook_E.sh check_note_fallback (R#316)
//
// Env vars required:
//   HISTORY_FILE — path to session-history.txt
//   TRACE_FILE   — path to engagement-trace.json
//   PARSED_FILE  — path to temp file with parsed JSON from Phase 1
//   SESSION      — current session number
//   CURRENT_NOTE — current note text from session-history.txt
//   HAS_TRACE    — "true" if trace file has data for this session
//   E_COUNT      — E session counter (for E#NNN label)

import { readFileSync, writeFileSync } from 'fs';

const historyFile = process.env.HISTORY_FILE;
const traceFile = process.env.TRACE_FILE;
const parsedFile = process.env.PARSED_FILE;
const session = process.env.SESSION;
const currentNote = process.env.CURRENT_NOTE || '';
const hasTrace = process.env.HAS_TRACE;

if (!historyFile || !traceFile || !session) {
  process.exit(0); // Missing required inputs, skip silently
}

// Check if note is already a proper completion line
if (/^Session [A-Z]#[0-9]+.*complete/i.test(currentNote)) {
  process.exit(0);
}

// Reject agent preamble patterns regardless of length (wq-916: s1874 race condition
// where parallel hook execution caused partial .summary read, producing garbage notes)
const preambleRe = /^(Let me|I'll |Now |Here's my|Starting|First,? let)/i;
const isPreamble = preambleRe.test(currentNote);

// Accept substantive notes (>60 chars with platform mentions) unless they're preamble
const platformRe = /engag|platform|chatr|moltbook|4claw|aicq|clawball|lobchan|pinchwork|colony/i;
if (!isPreamble && currentNote.length > 60 && platformRe.test(currentNote)) {
  process.exit(0);
}

// Note is truncated — need trace to generate replacement
if (hasTrace !== 'true') {
  process.exit(0);
}

// Generate replacement note from parsed trace data
let parsed;
try {
  parsed = JSON.parse(readFileSync(parsedFile, 'utf8'));
} catch {
  process.exit(0);
}

const platforms = (parsed.trace_platforms_engaged || []).map(p =>
  typeof p === 'string' ? p : (p && p.platform ? p.platform : String(p))
);
const agents = parsed.trace_agents || [];
const topics = parsed.trace_topics || [];
const eNum = parsed.e_count || '?';

const parts = [];
if (platforms.length) parts.push('Engaged ' + platforms.join(', '));
if (agents.length) parts.push('interacted with ' + agents.slice(0, 3).join(', '));
if (topics.length) parts.push(topics[0]);

let summary = parts.length ? parts.join('; ') : 'engagement session completed';
if (summary.length > 150) summary = summary.slice(0, 147) + '...';

const generatedNote = `Session E#${eNum} (s${session}) complete. ${summary}.`;

// Replace truncated note in session-history.txt
const lines = readFileSync(historyFile, 'utf8').split('\n');
const marker = `s=${session} `;
const newLines = lines.map(line => {
  if (line.includes(marker) && line.includes('note: ')) {
    const idx = line.indexOf('note: ') + 'note: '.length;
    return line.slice(0, idx) + generatedNote;
  }
  return line;
});

writeFileSync(historyFile, newLines.join('\n'));
console.log(`note-fallback: replaced truncated note for s${session}`);

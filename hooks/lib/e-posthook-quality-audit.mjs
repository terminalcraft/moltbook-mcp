#!/usr/bin/env node
// e-posthook-quality-audit.mjs — Append quality follow_ups to engagement trace
// when quality violations or credential-recycling patterns are found.
// Extracted from 36-e-session-posthook_E.sh Check 6.
//
// Env: SESSION, Q_FAILS, Q_TOTAL, TRACE_FILE, CURRENT_NOTE (optional)

import { readFileSync, writeFileSync } from 'fs';

const session = parseInt(process.env.SESSION);
const failCount = parseInt(process.env.Q_FAILS || '0');
const total = parseInt(process.env.Q_TOTAL || '0');
const traceFile = process.env.TRACE_FILE;
const currentNote = process.env.CURRENT_NOTE || '';

let traces;
try {
  const raw = JSON.parse(readFileSync(traceFile, 'utf8'));
  traces = Array.isArray(raw) ? raw : (typeof raw === 'object' ? [raw] : []);
} catch { traces = []; }

const followUps = [];

// Quality gate check (original behavior)
if (failCount > 0) {
  followUps.push({
    type: 'quality_warning',
    message: `s${session} quality gate: ${failCount}/${total} posts FAILED quality review. Review violations in quality-scores.jsonl and avoid repeating flagged patterns.`,
    severity: failCount > 1 ? 'high' : 'medium',
    source: '36-e-session-posthook_E.sh'
  });
}

// Credential-diversity check (wq-913, A#215; expanded wq-919, A#218; wq-938, A#223)
// Two-layer detection:
// 1. Regex: session-count credentials with morphed unit words (sessions/iterations/runs/cycles)
//    Word-bounded, 3-4 digit cap to avoid false positives on large numbers
// 2. Blocklist: specific recycled phrases with fuzzy matching (word overlap threshold)

const credentialPattern = /\b\d{3,4}\+?\s*(?:sessions?|iterations?|runs?|cycles?)\b/i;

// Phrases that get recycled as generic credentials instead of specific insights
const blockedPhrases = [
  'hook consolidation experience',
  'hook-system accretion',
  'hook consolidation expertise',
  'hook cleanup experience',
];

// Fuzzy match: check if >=60% of words in a blocked phrase appear near each other in the note
function fuzzyPhraseMatch(note, phrase) {
  const noteWords = note.toLowerCase().split(/\W+/).filter(Boolean);
  const phraseWords = phrase.toLowerCase().split(/\W+/).filter(Boolean);
  if (phraseWords.length === 0) return false;
  const matchCount = phraseWords.filter(w => noteWords.includes(w)).length;
  return matchCount / phraseWords.length >= 0.6;
}

const credMatches = currentNote.match(new RegExp(credentialPattern.source, 'gi')) || [];
const phraseMatches = blockedPhrases.filter(p =>
  currentNote.toLowerCase().includes(p) || fuzzyPhraseMatch(currentNote, p)
);

if (credMatches.length > 0 || phraseMatches.length > 0) {
  const allFound = [...credMatches, ...phraseMatches];
  followUps.push({
    type: 'credential_diversity_advisory',
    message: `s${session} credential recycling: recycled credential pattern detected (${allFound.join('; ')}). Vary your credentialing — use specific project names, pattern categories, architectural insights, or tool expertise instead of generic session counts or repeated experience claims.`,
    severity: 'low',
    source: 'e-posthook-quality-audit.mjs'
  });
  console.log(`quality-audit: credential-diversity advisory for s${session} (found: ${allFound.join('; ')})`);
}

if (followUps.length === 0) {
  console.log(`quality-audit: s${session} — no quality issues or credential recycling detected`);
  process.exit(0);
}

// Append follow_ups to the session's trace entry
for (let i = traces.length - 1; i >= 0; i--) {
  if (traces[i].session === session) {
    if (!traces[i].follow_ups) traces[i].follow_ups = [];
    traces[i].follow_ups.push(...followUps);
    break;
  }
}

writeFileSync(traceFile, JSON.stringify(traces, null, 2) + '\n');
console.log(`quality-audit: appended ${followUps.length} follow_up(s) to trace for s${session}`);

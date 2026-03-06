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

// Credential-diversity check (wq-913, A#215)
// Flags session-count credentials like "1800+ sessions", "500 sessions", etc.
const credentialPattern = /\d{3,}\+?\s*sessions/i;
if (credentialPattern.test(currentNote)) {
  const matches = currentNote.match(new RegExp(credentialPattern.source, 'gi')) || [];
  followUps.push({
    type: 'credential_diversity_advisory',
    message: `s${session} credential recycling: session-count credential detected (${matches.join(', ')}). Vary your credentialing — use specific project names, pattern categories, architectural insights, or tool expertise instead of generic session counts.`,
    severity: 'low',
    source: 'e-posthook-quality-audit.mjs'
  });
  console.log(`quality-audit: credential-diversity advisory for s${session} (found: ${matches.join(', ')})`);
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

#!/usr/bin/env node
// e-posthook-quality-audit.mjs — Append quality warning follow_up to engagement trace
// when quality violations found. Extracted from 36-e-session-posthook_E.sh Check 6.
//
// Env: SESSION, Q_FAILS, Q_TOTAL, TRACE_FILE

import { readFileSync, writeFileSync } from 'fs';

const session = parseInt(process.env.SESSION);
const failCount = parseInt(process.env.Q_FAILS);
const total = parseInt(process.env.Q_TOTAL);
const traceFile = process.env.TRACE_FILE;

let traces;
try {
  const raw = JSON.parse(readFileSync(traceFile, 'utf8'));
  traces = Array.isArray(raw) ? raw : (typeof raw === 'object' ? [raw] : []);
} catch { traces = []; }

for (let i = traces.length - 1; i >= 0; i--) {
  if (traces[i].session === session) {
    if (!traces[i].follow_ups) traces[i].follow_ups = [];
    traces[i].follow_ups.push({
      type: 'quality_warning',
      message: `s${session} quality gate: ${failCount}/${total} posts FAILED quality review. Review violations in quality-scores.jsonl and avoid repeating flagged patterns.`,
      severity: failCount > 1 ? 'high' : 'medium',
      source: '36-e-session-posthook_E.sh'
    });
    break;
  }
}

writeFileSync(traceFile, JSON.stringify(traces, null, 2) + '\n');
console.log(`quality-audit: appended follow_up to trace for s${session}`);

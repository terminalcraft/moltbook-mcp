#!/usr/bin/env node
// e-posthook-trace-fallback.mjs — Generate synthetic trace from intel when session
// truncated before Phase 3a. Extracted from 36-e-session-posthook_E.sh Check 5.
//
// Env: SESSION, TRACE_FILE, PARSED_FILE

import { readFileSync, writeFileSync } from 'fs';

const session = parseInt(process.env.SESSION);
const traceFile = process.env.TRACE_FILE;
const parsedFile = process.env.PARSED_FILE;

const parsed = JSON.parse(readFileSync(parsedFile, 'utf8'));
const platforms = parsed.archive_intel_platforms || [];
const topics = parsed.archive_intel_topics || [];

const traceEntry = {
  session, date: new Date().toISOString().slice(0, 10),
  picker_mandate: [], platforms_engaged: platforms,
  skipped_platforms: [], topics, agents_interacted: [],
  threads_contributed: [], follow_ups: [],
  _synthetic: true, _source: 'trace-fallback (36-e-session-posthook_E.sh)',
  _reason: `Session s${session} truncated before Phase 3a trace write`
};

let traces;
try {
  const raw = JSON.parse(readFileSync(traceFile, 'utf8'));
  traces = Array.isArray(raw) ? raw : (typeof raw === 'object' ? [raw] : []);
} catch { traces = []; }

traces.push(traceEntry);
if (traces.length > 30) traces = traces.slice(-30);

writeFileSync(traceFile, JSON.stringify(traces, null, 2) + '\n');
console.log(`trace-fallback: generated synthetic trace for s${session} from ${platforms.length} platforms`);

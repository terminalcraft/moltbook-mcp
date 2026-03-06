#!/usr/bin/env node
// e-posthook-early-exit.mjs — Inject stigmergic pressure into engagement-trace.json
// for early-exit E sessions (<120s). Extracted from 36-e-session-posthook_E.sh Check 3.
//
// Env: TRACE_FILE, SESSION, DURATION_STR, TOTAL_SECONDS

import { readFileSync, writeFileSync } from 'fs';

const traceFile = process.env.TRACE_FILE;
const session = parseInt(process.env.SESSION);
const duration = process.env.DURATION_STR;
const totalS = parseInt(process.env.TOTAL_SECONDS);

let traces;
try {
  const raw = JSON.parse(readFileSync(traceFile, 'utf8'));
  traces = Array.isArray(raw) ? raw : (typeof raw === 'object' ? [raw] : []);
} catch { traces = []; }

const warning = `EARLY EXIT WARNING: Previous E session (s${session}) exited in ${duration} (${totalS}s). Ensure deeper engagement — check platform health first, then commit to full Phase 2 loop.`;

if (traces.length > 0) {
  const latest = traces[traces.length - 1];
  const followUps = latest.follow_ups || [];
  followUps.push(warning);
  latest.follow_ups = followUps;
  latest.early_exit_flag = true;
} else {
  traces.push({
    session, date: new Date().toISOString().slice(0, 10),
    early_exit_flag: true, follow_ups: [warning],
    note: `Synthetic trace from early-exit hook. Session s${session} lasted ${duration}.`
  });
}

writeFileSync(traceFile, JSON.stringify(traces, null, 2) + '\n');
console.log(`early-exit: stigmergic pressure injected into trace for s${session}`);

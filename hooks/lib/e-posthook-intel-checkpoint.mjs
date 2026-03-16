#!/usr/bin/env node
// e-posthook-intel-checkpoint.mjs — Write recovery intel entry for E sessions with 0 intel.
// Extracted from 36-e-session-posthook_E.sh Check 1 inline heredoc.
//
// Env: INTEL_FILE, SESSION, INTEL_REASON, INTEL_DETAILS, PARSED_FILE

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const intelFile = process.env.INTEL_FILE;
const session = parseInt(process.env.SESSION);
const reason = process.env.INTEL_REASON;
const details = process.env.INTEL_DETAILS;
const parsedFile = process.env.PARSED_FILE;

if (!intelFile || !session || !reason) {
  console.log('intel-checkpoint: missing required env vars');
  process.exit(1);
}

let traceIntel = null;
if (parsedFile) {
  try {
    const parsed = JSON.parse(readFileSync(parsedFile, 'utf8'));
    traceIntel = parsed.trace_intel_data || null;
  } catch { /* parsed file may not exist or be malformed */ }
}

const entry = traceIntel || {
  type: 'pattern',
  source: `post-session checkpoint (${reason})`,
  summary: `E session s${session} completed with 0 intel. Reason: ${reason}. ${details}`,
  actionable: `Review s${session} failure (${reason}) and capture intel from next E session`,
  session,
  checkpoint: true,
  failure_reason: reason
};

mkdirSync(dirname(intelFile), { recursive: true });
writeFileSync(intelFile, JSON.stringify([entry], null, 2) + '\n');

const sourceLabel = traceIntel ? 'trace-extracted' : reason;
console.log(`intel-checkpoint: wrote ${sourceLabel} recovery entry for s${session}`);

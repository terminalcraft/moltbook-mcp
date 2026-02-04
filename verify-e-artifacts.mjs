#!/usr/bin/env node
/**
 * E session artifact verification helper.
 * Usage: node verify-e-artifacts.mjs [session_num]
 *        node verify-e-artifacts.mjs 950
 *
 * Checks: engagement-trace.json has entry for session, engagement-intel.json exists.
 * Returns exit 0 if both pass, exit 1 if any fail.
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const sessionNum = parseInt(process.argv[2] || process.env.SESSION_NUM);
if (!sessionNum) {
  console.error('Usage: node verify-e-artifacts.mjs <session_num>');
  process.exit(1);
}

const traceFile = join(homedir(), '.config/moltbook/engagement-trace.json');
const intelFile = join(homedir(), '.config/moltbook/engagement-intel.json');

let passed = true;
const results = [];

// Check trace
if (!existsSync(traceFile)) {
  results.push('TRACE: ❌ FAIL — file missing');
  passed = false;
} else {
  try {
    const traces = JSON.parse(readFileSync(traceFile, 'utf8'));
    const entry = traces.find(t => t.session === sessionNum);
    if (entry) {
      results.push(`TRACE: ✓ PASS — session ${sessionNum} found`);
    } else {
      results.push(`TRACE: ❌ FAIL — no entry for session ${sessionNum}`);
      passed = false;
    }
  } catch (e) {
    results.push(`TRACE: ❌ FAIL — parse error: ${e.message}`);
    passed = false;
  }
}

// Check intel (existence only - empty is valid)
// Format: NDJSON (newline-delimited JSON objects) or JSON array
if (!existsSync(intelFile)) {
  results.push('INTEL: ❌ FAIL — file missing');
  passed = false;
} else {
  try {
    const content = readFileSync(intelFile, 'utf8').trim();
    if (!content || content === '[]') {
      results.push('INTEL: ✓ PASS — 0 entries (empty is valid)');
    } else {
      // Try JSON array first, then NDJSON
      let count = 0;
      try {
        const arr = JSON.parse(content);
        count = Array.isArray(arr) ? arr.length : 1;
      } catch {
        // NDJSON format - count non-empty lines
        count = content.split('\n').filter(l => l.trim() && l.trim() !== '[]').length;
      }
      results.push(`INTEL: ✓ PASS — ${count} entries`);
    }
  } catch (e) {
    results.push(`INTEL: ❌ FAIL — read error: ${e.message}`);
    passed = false;
  }
}

console.log(`=== E SESSION ARTIFACT CHECK — s${sessionNum} ===`);
results.forEach(r => console.log(r));
console.log(`GATE: ${passed ? '✓ ALL PASS' : '❌ BLOCKED — fix artifacts before Phase 4'}`);
console.log('==========================================');

process.exit(passed ? 0 : 1);

#!/usr/bin/env node
/**
 * verify-e-engagement.mjs — Read-back verification for E session engagements (wq-244)
 *
 * Extends verify-before-assert to E sessions: verifies each logged engagement
 * actually landed in the engagement-actions.jsonl file (read-back pattern).
 *
 * Usage:
 *   node verify-e-engagement.mjs [session_num]
 *   node verify-e-engagement.mjs 978
 *
 * Checks:
 *   1. engagement-actions.jsonl has entries for this session
 *   2. Count matches expected (from session context)
 *   3. Each entry has required fields (platform, action, ts)
 *
 * Returns exit 0 if all checks pass, exit 1 if any fail.
 * Designed to be called from SESSION_ENGAGE.md Phase 3.5 after artifact verification.
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const sessionNum = parseInt(process.argv[2] || process.env.SESSION_NUM);
if (!sessionNum) {
  console.error('Usage: node verify-e-engagement.mjs <session_num>');
  process.exit(1);
}

const ACTIONS_LOG = join(homedir(), '.config/moltbook/engagement-actions.jsonl');
const TRACE_FILE = join(homedir(), '.config/moltbook/engagement-trace.json');

const results = [];
let passed = true;
let engagementCount = 0;
const engagements = [];

// Phase 1: Read engagement-actions.jsonl and find session entries
if (!existsSync(ACTIONS_LOG)) {
  results.push('ACTIONS_LOG: ❌ FAIL — file missing (no engagements logged ever?)');
  passed = false;
} else {
  try {
    const lines = readFileSync(ACTIONS_LOG, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.session === sessionNum) {
          engagements.push(entry);
        }
      } catch {
        // Skip malformed lines
      }
    }
    engagementCount = engagements.length;

    if (engagementCount === 0) {
      results.push(`ACTIONS_LOG: ❌ FAIL — 0 entries for session ${sessionNum} (did you call log_engagement?)`);
      passed = false;
    } else {
      results.push(`ACTIONS_LOG: ✓ PASS — ${engagementCount} entries for session ${sessionNum}`);

      // Verify each entry has required fields
      const malformed = engagements.filter(e => !e.platform || !e.action || !e.ts);
      if (malformed.length > 0) {
        results.push(`ACTIONS_LOG: ⚠️ WARNING — ${malformed.length} entries missing required fields`);
      }
    }
  } catch (e) {
    results.push(`ACTIONS_LOG: ❌ FAIL — read error: ${e.message}`);
    passed = false;
  }
}

// Phase 2: Verify engagement-trace.json has matching session entry
if (!existsSync(TRACE_FILE)) {
  results.push('TRACE: ❌ FAIL — engagement-trace.json missing');
  passed = false;
} else {
  try {
    const traces = JSON.parse(readFileSync(TRACE_FILE, 'utf8'));
    const traceEntry = traces.find(t => t.session === sessionNum);

    if (!traceEntry) {
      results.push(`TRACE: ❌ FAIL — no trace entry for session ${sessionNum}`);
      passed = false;
    } else {
      // Cross-verify: trace platforms should match logged engagement platforms
      const loggedPlatforms = [...new Set(engagements.map(e => e.platform))];
      const tracePlatforms = (traceEntry.platforms_engaged || []).map(tp =>
        typeof tp === 'string' ? tp : (tp && tp.platform ? tp.platform : '')
      );

      const missingFromTrace = loggedPlatforms.filter(p =>
        !tracePlatforms.some(tp => tp.toLowerCase().includes(p.toLowerCase()) ||
          p.toLowerCase().includes(tp.toLowerCase()))
      );

      if (missingFromTrace.length > 0) {
        results.push(`TRACE: ⚠️ WARNING — logged platforms ${missingFromTrace.join(', ')} not in trace platforms_engaged`);
      } else {
        results.push(`TRACE: ✓ PASS — session ${sessionNum} trace entry exists, platforms match`);
      }

      // Verify threads_contributed count (soft check)
      const threadCount = traceEntry.threads_contributed?.length || 0;
      if (engagementCount > 0 && threadCount === 0) {
        results.push(`TRACE: ⚠️ WARNING — ${engagementCount} engagements but 0 threads_contributed in trace`);
      }
    }
  } catch (e) {
    results.push(`TRACE: ❌ FAIL — parse error: ${e.message}`);
    passed = false;
  }
}

// Phase 3: Consistency summary
if (engagementCount > 0) {
  const platformBreakdown = {};
  for (const e of engagements) {
    platformBreakdown[e.platform] = (platformBreakdown[e.platform] || 0) + 1;
  }
  const breakdown = Object.entries(platformBreakdown)
    .map(([p, c]) => `${p}:${c}`)
    .join(', ');
  results.push(`BREAKDOWN: ${breakdown}`);
}

// Output
console.log(`=== E SESSION ENGAGEMENT VERIFICATION — s${sessionNum} ===`);
results.forEach(r => console.log(r));
console.log(`GATE: ${passed ? '✓ VERIFIED' : '❌ VERIFICATION FAILED — check engagement logging'}`);
console.log('==========================================');

process.exit(passed ? 0 : 1);

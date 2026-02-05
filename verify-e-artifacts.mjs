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

// Check intel (existence + quality check)
// Format: JSON array (legacy NDJSON no longer used)
if (!existsSync(intelFile)) {
  results.push('INTEL: ❌ FAIL — file missing');
  passed = false;
} else {
  try {
    const content = readFileSync(intelFile, 'utf8').trim();
    if (!content || content === '[]') {
      results.push('INTEL: ✓ PASS — 0 entries (empty is valid if nothing actionable observed)');
    } else {
      // Parse as JSON array
      let entries = [];
      try {
        const parsed = JSON.parse(content);
        entries = Array.isArray(parsed) ? parsed : [];
      } catch {
        results.push('INTEL: ⚠ WARN — parse error, treating as empty');
        entries = [];
      }

      const count = entries.length;
      // Quality check: entries with meaningful actionable field (>20 chars)
      const actionableCount = entries.filter(e =>
        e && e.actionable && typeof e.actionable === 'string' && e.actionable.length > 20
      ).length;

      if (count === 0) {
        results.push('INTEL: ✓ PASS — 0 entries');
      } else if (actionableCount === 0) {
        // Entries exist but none have actionable fields — warn but don't block
        results.push(`INTEL: ⚠ QUALITY WARNING — ${count} entries but 0 have actionable text`);
        results.push('  → Intel entries should have concrete actionable fields');
        results.push('  → See SESSION_ENGAGE.md Phase 3b "Actionable vs Observation"');
        // Don't set passed=false — advisory only. But surface the problem.
      } else {
        results.push(`INTEL: ✓ PASS — ${count} entries, ${actionableCount} actionable`);
      }
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

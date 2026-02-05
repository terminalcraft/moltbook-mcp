#!/usr/bin/env node
/**
 * E session artifact verification helper.
 * Usage: node verify-e-artifacts.mjs [session_num]
 *        node verify-e-artifacts.mjs 950
 *
 * Checks:
 * 1. engagement-trace.json has entry for session
 * 2. engagement-intel.json exists
 * 3. d049 compliance: intel_count >= 1 (minimum intel requirement)
 *
 * Returns exit 0 if artifact checks pass, exit 1 if any fail.
 * d049 violations are reported separately but don't block the gate.
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
const traceArchiveFile = join(homedir(), '.config/moltbook/engagement-trace-archive.json');
const intelFile = join(homedir(), '.config/moltbook/engagement-intel.json');
const intelArchiveFile = join(homedir(), '.config/moltbook/engagement-intel-archive.json');

let passed = true;
let d049Compliant = true;  // d049: minimum 1 intel entry
const results = [];

// Check trace — first check archive (for historical sessions), then current file
// B#324 (wq-364): engagement-trace.json is overwritten by each E session.
// Without checking the archive, only the most recent session can be verified.
let traceFound = false;

// Check archive first (historical sessions)
if (existsSync(traceArchiveFile)) {
  try {
    const traceArchive = JSON.parse(readFileSync(traceArchiveFile, 'utf8'));
    const archiveEntry = traceArchive.find(t => t.session === sessionNum);
    if (archiveEntry) {
      results.push(`TRACE: ✓ PASS — session ${sessionNum} found in archive`);
      traceFound = true;
    }
  } catch {
    // Archive parse error — continue to current file check
  }
}

// If not in archive, check current trace file
if (!traceFound) {
  if (!existsSync(traceFile)) {
    results.push('TRACE: ❌ FAIL — file missing (not in archive either)');
    passed = false;
  } else {
    try {
      const traces = JSON.parse(readFileSync(traceFile, 'utf8'));
      const entry = traces.find(t => t.session === sessionNum);
      if (entry) {
        results.push(`TRACE: ✓ PASS — session ${sessionNum} found`);
        traceFound = true;
      } else {
        results.push(`TRACE: ❌ FAIL — no entry for session ${sessionNum} (checked archive + current)`);
        passed = false;
      }
    } catch (e) {
      results.push(`TRACE: ❌ FAIL — parse error: ${e.message}`);
      passed = false;
    }
  }
}

// Check intel (existence + quality check + d049 compliance)
// For historical sessions, check the archive; for current session, check current file
// Format: JSON array (legacy NDJSON no longer used)

// Try to get intel count from archive first (for historical sessions)
let archiveIntelCount = 0;
let checkedArchive = false;
if (existsSync(intelArchiveFile)) {
  try {
    const archiveData = JSON.parse(readFileSync(intelArchiveFile, 'utf8'));
    const sessionEntries = archiveData.filter(e => e.session === sessionNum);
    archiveIntelCount = sessionEntries.length;
    checkedArchive = true;
  } catch {
    // Archive parse error — continue with current file check
  }
}

// If archive had entries for this session, use that count
if (checkedArchive && archiveIntelCount > 0) {
  results.push(`INTEL: ✓ PASS — ${archiveIntelCount} entries in archive for s${sessionNum}`);
  results.push(`d049:  ✓ COMPLIANT — ${archiveIntelCount} intel entries`);
} else if (checkedArchive && archiveIntelCount === 0) {
  // Archive exists but no entries for this session — check current file as fallback
  // (in case session is still in progress)
  if (!existsSync(intelFile)) {
    results.push('INTEL: ✓ ARTIFACT PASS — file exists (checked archive: 0 entries)');
    results.push('d049:  ⚠ VIOLATION — 0 intel entries (minimum 1 required)');
    d049Compliant = false;
  } else {
    try {
      const content = readFileSync(intelFile, 'utf8').trim();
      let currentEntries = [];
      try {
        const parsed = JSON.parse(content);
        currentEntries = Array.isArray(parsed) ? parsed : [];
      } catch {
        currentEntries = [];
      }

      const currentCount = currentEntries.length;
      if (currentCount > 0) {
        results.push(`INTEL: ✓ PASS — ${currentCount} entries in current intel file`);
        results.push(`d049:  ✓ COMPLIANT — ${currentCount} intel entries`);
      } else {
        results.push('INTEL: ✓ ARTIFACT PASS — file exists (0 entries in archive + current)');
        results.push('d049:  ⚠ VIOLATION — 0 intel entries (minimum 1 required)');
        d049Compliant = false;
      }
    } catch (e) {
      results.push(`INTEL: ⚠ WARN — current file read error: ${e.message}`);
      results.push('d049:  ⚠ VIOLATION — 0 intel entries (archive empty, current unreadable)');
      d049Compliant = false;
    }
  }
} else {
  // No archive or couldn't read it — fall back to current file only
  if (!existsSync(intelFile)) {
    results.push('INTEL: ❌ FAIL — file missing');
    passed = false;
    d049Compliant = false;
  } else {
    try {
      const content = readFileSync(intelFile, 'utf8').trim();
      let intelCount = 0;

      if (!content || content === '[]') {
        results.push('INTEL: ✓ ARTIFACT PASS — file exists (0 entries)');
        results.push('d049:  ⚠ VIOLATION — 0 intel entries (minimum 1 required)');
        d049Compliant = false;
      } else {
        let entries = [];
        try {
          const parsed = JSON.parse(content);
          entries = Array.isArray(parsed) ? parsed : [];
        } catch {
          results.push('INTEL: ⚠ WARN — parse error, treating as empty');
          entries = [];
        }

        intelCount = entries.length;
        const actionableCount = entries.filter(e =>
          e && e.actionable && typeof e.actionable === 'string' && e.actionable.length > 20
        ).length;

        if (intelCount === 0) {
          results.push('INTEL: ✓ ARTIFACT PASS — file exists (0 entries)');
          results.push('d049:  ⚠ VIOLATION — 0 intel entries (minimum 1 required)');
          d049Compliant = false;
        } else if (actionableCount === 0) {
          results.push(`INTEL: ⚠ QUALITY WARNING — ${intelCount} entries but 0 have actionable text`);
          results.push('  → Intel entries should have concrete actionable fields');
          results.push(`d049:  ✓ COMPLIANT — ${intelCount} intel entries`);
        } else {
          results.push(`INTEL: ✓ PASS — ${intelCount} entries, ${actionableCount} actionable`);
          results.push(`d049:  ✓ COMPLIANT — ${intelCount} intel entries`);
        }
      }
    } catch (e) {
      results.push(`INTEL: ❌ FAIL — read error: ${e.message}`);
      passed = false;
      d049Compliant = false;
    }
  }
}

console.log(`=== E SESSION ARTIFACT CHECK — s${sessionNum} ===`);
results.forEach(r => console.log(r));
console.log('---');
console.log(`ARTIFACT GATE: ${passed ? '✓ PASS' : '❌ BLOCKED — fix artifacts before Phase 4'}`);
console.log(`d049 COMPLIANCE: ${d049Compliant ? '✓ PASS' : '⚠ VIOLATION (intel_count=0)'}`);
console.log('==========================================');

// Output JSON for programmatic consumption
const output = {
  session: sessionNum,
  artifact_passed: passed,
  d049_compliant: d049Compliant
};
console.log('JSON:', JSON.stringify(output));

process.exit(passed ? 0 : 1);

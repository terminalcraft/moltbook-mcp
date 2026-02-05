#!/usr/bin/env node
/**
 * R session directive maintenance verification helper.
 * Usage: node verify-r-directive-maintenance.mjs [session_num]
 *        node verify-r-directive-maintenance.mjs 1090
 *
 * Checks:
 * 1. Session note mentions directive update/maintenance
 * 2. directives.json compliance metric shows 'followed' for this session
 * 3. Validates R#183 mandate: R sessions must perform directive maintenance
 *
 * Returns JSON with compliance status for programmatic consumption.
 * Exit 0 if compliant, exit 1 if violation.
 *
 * Created: wq-331 (B#308) — add audit verification for R session directive maintenance
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse session number from CLI or env
const sessionNum = parseInt(process.argv[2] || process.env.SESSION_NUM);
if (!sessionNum) {
  console.error('Usage: node verify-r-directive-maintenance.mjs <session_num>');
  process.exit(1);
}

const STATE_DIR = join(homedir(), '.config/moltbook');
const PROJECT_DIR = __dirname;

/**
 * Check directives.json compliance metric for directive-update
 */
function checkComplianceMetric(sessionNum) {
  const directivesPath = join(PROJECT_DIR, 'directives.json');

  if (!existsSync(directivesPath)) {
    return { checked: false, reason: 'directives.json not found' };
  }

  try {
    const data = JSON.parse(readFileSync(directivesPath, 'utf8'));
    const metric = data?.compliance?.metrics?.['directive-update'];

    if (!metric || !metric.history) {
      return { checked: false, reason: 'No directive-update metric in compliance section' };
    }

    // Find this session in history
    const entry = metric.history.find(h => h.session === sessionNum);
    if (!entry) {
      return { checked: false, reason: `Session ${sessionNum} not found in directive-update history` };
    }

    return {
      checked: true,
      compliant: entry.result === 'followed',
      reason: entry.result === 'followed'
        ? 'directives.json was edited during session'
        : metric.last_ignored_reason || 'No directives.json edits detected'
    };
  } catch (e) {
    return { checked: false, reason: `Parse error: ${e.message}` };
  }
}

/**
 * Check session history note for directive maintenance keywords
 */
function checkSessionNote(sessionNum) {
  const historyPath = join(STATE_DIR, 'session-history.txt');

  if (!existsSync(historyPath)) {
    return { checked: false, reason: 'session-history.txt not found' };
  }

  try {
    const content = readFileSync(historyPath, 'utf8');
    const lines = content.trim().split('\n');

    // Find the line for this session
    const sessionLine = lines.find(line => {
      const match = line.match(/s=(\d+)/);
      return match && parseInt(match[1]) === sessionNum;
    });

    if (!sessionLine) {
      return { checked: false, reason: `Session ${sessionNum} not found in history` };
    }

    // Verify it's an R session
    if (!sessionLine.includes('mode=R')) {
      return { checked: false, reason: `Session ${sessionNum} is not an R session`, notApplicable: true };
    }

    // Check if note mentions directive maintenance keywords
    const noteMatch = sessionLine.match(/note:\s*(.+)$/);
    const note = noteMatch ? noteMatch[1].toLowerCase() : '';

    const keywords = [
      'directive', 'directives.json', 'd0',
      'maintenance', 'compliance', 'question',
      'completed', 'active', 'status'
    ];

    const hasKeyword = keywords.some(kw => note.includes(kw));

    // Also check files= for directives.json
    const filesMatch = sessionLine.match(/files=\[([^\]]*)\]/);
    const files = filesMatch ? filesMatch[1] : '';
    const editedDirectives = files.toLowerCase().includes('directives.json');

    return {
      checked: true,
      noteHasKeyword: hasKeyword,
      editedDirectives,
      note: note.substring(0, 100),
      files
    };
  } catch (e) {
    return { checked: false, reason: `Read error: ${e.message}` };
  }
}

/**
 * Determine overall compliance based on multiple signals
 */
function determineCompliance(complianceMetric, sessionNote) {
  // If session note check says not applicable (not an R session), skip
  if (sessionNote.notApplicable) {
    return {
      compliant: true,
      notApplicable: true,
      reason: sessionNote.reason
    };
  }

  // Primary signal: compliance metric (deterministic, based on file edits)
  if (complianceMetric.checked && complianceMetric.compliant) {
    return {
      compliant: true,
      reason: 'directives.json edited during session (compliance metric: followed)'
    };
  }

  // Secondary signal: session note mentions directive work
  if (sessionNote.checked && (sessionNote.noteHasKeyword || sessionNote.editedDirectives)) {
    return {
      compliant: true,
      reason: 'Session note or files field references directive maintenance'
    };
  }

  // R#183 mandate requires at least one directive maintenance action
  // If neither signal fires, it's a violation
  return {
    compliant: false,
    reason: complianceMetric.reason || 'No directive maintenance detected (R#183 mandate violation)'
  };
}

// Run checks
const complianceMetric = checkComplianceMetric(sessionNum);
const sessionNote = checkSessionNote(sessionNum);
const overall = determineCompliance(complianceMetric, sessionNote);

// Output results
console.log(`=== R SESSION DIRECTIVE MAINTENANCE CHECK — s${sessionNum} ===`);

if (overall.notApplicable) {
  console.log(`STATUS: ⊘ NOT APPLICABLE — ${overall.reason}`);
} else if (overall.compliant) {
  console.log(`STATUS: ✓ COMPLIANT — ${overall.reason}`);
} else {
  console.log(`STATUS: ⚠ VIOLATION — ${overall.reason}`);
}

console.log('---');
console.log('Compliance metric:', complianceMetric.checked
  ? (complianceMetric.compliant ? '✓ followed' : '✗ ignored')
  : `? ${complianceMetric.reason}`);
console.log('Session note check:', sessionNote.checked
  ? `note_keyword=${sessionNote.noteHasKeyword}, files_edited=${sessionNote.editedDirectives}`
  : `? ${sessionNote.reason}`);
console.log('==========================================');

// Output JSON for programmatic consumption
const output = {
  session: sessionNum,
  compliant: overall.compliant,
  not_applicable: overall.notApplicable || false,
  reason: overall.reason,
  compliance_metric: complianceMetric,
  session_note: sessionNote
};
console.log('JSON:', JSON.stringify(output));

process.exit(overall.compliant || overall.notApplicable ? 0 : 1);

#!/usr/bin/env node
/**
 * d049-compliance-monitor.mjs — Automated d049 intel compliance checker
 *
 * Scans recent E sessions for d049 violations (0 intel entries) and
 * returns a structured verdict with escalation decision.
 *
 * Usage:
 *   node d049-compliance-monitor.mjs              # default: last 5 E sessions
 *   node d049-compliance-monitor.mjs --window 10  # check last 10 E sessions
 *   node d049-compliance-monitor.mjs --json       # JSON output for A session consumption
 *
 * Escalation thresholds (per wq-367):
 *   - 0 violations in window: PASS
 *   - 1 violation in window:  WARN (monitoring)
 *   - 2+ violations in 5 sessions: ESCALATE (trigger R session investigation)
 *
 * Data sources:
 *   - e-phase35-tracking.json (historical per-session d049 compliance)
 *   - session-history.txt (fallback for sessions not yet in tracking)
 *   - engagement-intel-archive.json (verify intel counts)
 *
 * Created: B#326 (wq-367) — automate d049 violation monitoring
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROJECT_DIR = process.cwd();
const CONFIG_DIR = join(process.env.HOME, '.config/moltbook');

const args = process.argv.slice(2);
const windowSize = getArg('--window', 5);
const jsonOutput = args.includes('--json');
const escalationThreshold = getArg('--threshold', 2);

function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return parseInt(args[idx + 1]) || defaultVal;
}

function readJSON(path, defaultValue = null) {
  try {
    if (!existsSync(path)) return defaultValue;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function getESessionsFromTracking() {
  const tracking = readJSON(join(PROJECT_DIR, 'e-phase35-tracking.json'));
  if (!tracking || !tracking.sessions) return [];

  return tracking.sessions
    .filter(s => s.d049_compliant !== undefined) // only post-d049 sessions
    .map(s => ({
      session: s.session,
      e_number: s.e_number,
      d049_compliant: s.d049_compliant,
      source: 'tracking'
    }))
    .sort((a, b) => b.session - a.session); // newest first
}

function getESessionsFromHistory() {
  const historyPath = join(CONFIG_DIR, 'session-history.txt');
  if (!existsSync(historyPath)) return [];

  const lines = readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
  const eSessions = [];

  for (const line of lines) {
    const modeMatch = line.match(/mode=E/);
    if (!modeMatch) continue;

    const sessionMatch = line.match(/s=(\d+)/);
    if (!sessionMatch) continue;

    const session = parseInt(sessionMatch[1]);

    // Check if intel files were produced (heuristic from session-history)
    const filesMatch = line.match(/files=\[([^\]]*)\]/);
    const files = filesMatch ? filesMatch[1] : '';
    const hasIntel = files.includes('engagement-intel.json');

    eSessions.push({
      session,
      has_intel_file: hasIntel,
      source: 'history'
    });
  }

  return eSessions.sort((a, b) => b.session - a.session);
}

function verifyIntelCount(sessionNum) {
  // Check archive for intel count
  const archivePath = join(CONFIG_DIR, 'engagement-intel-archive.json');
  const archive = readJSON(archivePath, []);

  if (Array.isArray(archive)) {
    const entries = archive.filter(e => e.session === sessionNum);
    return entries.length;
  }
  return -1; // unknown
}

function run() {
  // Get E sessions from tracking (authoritative source)
  const trackingSessions = getESessionsFromTracking();
  const historySessions = getESessionsFromHistory();

  // Merge: tracking is authoritative, history fills gaps
  const trackedSessionNums = new Set(trackingSessions.map(s => s.session));
  const allSessions = [...trackingSessions];

  // Add history sessions not in tracking (e.g., very recent ones)
  for (const hs of historySessions) {
    if (!trackedSessionNums.has(hs.session)) {
      // Verify via archive
      const intelCount = verifyIntelCount(hs.session);
      allSessions.push({
        session: hs.session,
        d049_compliant: intelCount > 0,
        intel_count: intelCount,
        source: 'history+archive'
      });
    }
  }

  // Sort newest first and take the window
  allSessions.sort((a, b) => b.session - a.session);
  const window = allSessions.slice(0, windowSize);

  // Compute violations
  const violations = window.filter(s => s.d049_compliant === false);
  const compliant = window.filter(s => s.d049_compliant === true);
  const unknown = window.filter(s => s.d049_compliant === undefined);

  // Determine verdict
  let verdict, action;
  if (violations.length === 0) {
    verdict = 'PASS';
    action = 'No action needed. d049 compliance healthy.';
  } else if (violations.length === 1) {
    verdict = 'WARN';
    action = `1 violation in ${window.length} sessions (s${violations[0].session}). Monitoring — not yet at escalation threshold (${escalationThreshold}).`;
  } else if (violations.length >= escalationThreshold) {
    verdict = 'ESCALATE';
    action = `${violations.length} violations in ${window.length} sessions — exceeds threshold (${escalationThreshold}). Escalate to R session for d049 investigation. Violating sessions: ${violations.map(v => 's' + v.session).join(', ')}.`;
  } else {
    verdict = 'WARN';
    action = `${violations.length} violation(s) in ${window.length} sessions. Below escalation threshold (${escalationThreshold}).`;
  }

  // Compliance rate
  const rateBase = compliant.length + violations.length;
  const complianceRate = rateBase > 0
    ? Math.round((compliant.length / rateBase) * 100)
    : 100;

  const result = {
    tool: 'd049-compliance-monitor',
    window_size: windowSize,
    escalation_threshold: escalationThreshold,
    sessions_checked: window.map(s => ({
      session: s.session,
      e_number: s.e_number || null,
      d049_compliant: s.d049_compliant,
      source: s.source
    })),
    violations: violations.map(v => v.session),
    violation_count: violations.length,
    compliant_count: compliant.length,
    unknown_count: unknown.length,
    compliance_rate: `${complianceRate}%`,
    verdict,
    action,
    checked_at: new Date().toISOString()
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('=== d049 COMPLIANCE MONITOR ===');
    console.log(`Window: last ${window.length} E sessions`);
    console.log(`Escalation threshold: ${escalationThreshold} violations`);
    console.log('');
    console.log('Sessions checked:');
    for (const s of window) {
      const status = s.d049_compliant === true ? '✓' : s.d049_compliant === false ? '✗' : '?';
      const eNum = s.e_number ? ` (E#${s.e_number})` : '';
      console.log(`  s${s.session}${eNum}: ${status} [${s.source}]`);
    }
    console.log('');
    console.log(`Violations: ${violations.length} / ${window.length}`);
    console.log(`Compliance rate: ${complianceRate}%`);
    console.log(`Verdict: ${verdict}`);
    console.log(`Action: ${action}`);
    console.log('===============================');
  }

  // Exit code: 0=PASS, 1=WARN, 2=ESCALATE
  process.exit(verdict === 'PASS' ? 0 : verdict === 'WARN' ? 1 : 2);
}

run();

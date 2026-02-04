#!/usr/bin/env node
/**
 * E session budget gate compliance tracker (wq-190)
 *
 * Usage:
 *   node e-budget-tracker.mjs record <session> <cost>  # Record an E session result
 *   node e-budget-tracker.mjs status                    # Show current tracking status
 *   node e-budget-tracker.mjs check                     # Check if escalation needed
 *
 * Created: B#230 (s897)
 * Purpose: Monitor R#144's $2.00 budget gate effectiveness
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';

const TRACKING_FILE = `${homedir()}/.config/moltbook/e-budget-gate-tracking.json`;
const BUDGET_GATE = 2.00;

function loadTracking() {
  if (!existsSync(TRACKING_FILE)) {
    console.error('Tracking file not found:', TRACKING_FILE);
    process.exit(1);
  }
  return JSON.parse(readFileSync(TRACKING_FILE, 'utf8'));
}

function saveTracking(data) {
  writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2));
}

function recordSession(session, cost) {
  const tracking = loadTracking();
  const sessionNum = parseInt(session);
  const costNum = parseFloat(cost);

  // Check if already recorded
  if (tracking.post_gate_sessions.some(s => s.session === sessionNum)) {
    console.log(`Session ${sessionNum} already recorded`);
    return;
  }

  const passed = costNum >= BUDGET_GATE;
  tracking.post_gate_sessions.push({
    session: sessionNum,
    cost: costNum,
    passed,
    recorded_at: new Date().toISOString()
  });

  saveTracking(tracking);
  console.log(`Recorded E session ${sessionNum}: $${costNum.toFixed(2)} - ${passed ? 'PASSED' : 'FAILED'}`);
}

function showStatus() {
  const tracking = loadTracking();
  console.log('=== E Session Budget Gate Tracking (wq-190) ===');
  console.log(`Gate: $${BUDGET_GATE.toFixed(2)} minimum (added s${tracking.gate_session})`);
  console.log(`Escalation: s${tracking.escalation_session} if ${tracking.escalation_threshold}+ failures`);
  console.log();

  console.log('Pre-gate failures:');
  tracking.pre_gate_failures.forEach(s => {
    console.log(`  s${s.session}: $${s.cost.toFixed(2)}`);
  });
  console.log();

  console.log(`Post-gate sessions (${tracking.post_gate_sessions.length} recorded):`);
  if (tracking.post_gate_sessions.length === 0) {
    console.log('  (none yet - next E session: s898)');
  } else {
    tracking.post_gate_sessions.forEach(s => {
      const status = s.passed ? '✓ PASSED' : '✗ FAILED';
      console.log(`  s${s.session}: $${s.cost.toFixed(2)} ${status}`);
    });
  }

  console.log();
  console.log(`Status: ${tracking.status}`);
}

function checkEscalation() {
  const tracking = loadTracking();
  const failures = tracking.post_gate_sessions.filter(s => !s.passed);

  console.log(`Post-gate E sessions: ${tracking.post_gate_sessions.length}`);
  console.log(`Failures (< $${BUDGET_GATE.toFixed(2)}): ${failures.length}`);
  console.log(`Escalation threshold: ${tracking.escalation_threshold}`);

  if (failures.length >= tracking.escalation_threshold) {
    console.log('\n⚠️  ESCALATION NEEDED: Gate is not effective');
    console.log('Failed sessions:');
    failures.forEach(s => console.log(`  s${s.session}: $${s.cost.toFixed(2)}`));

    // Update status
    tracking.status = 'escalation_needed';
    saveTracking(tracking);
    process.exit(1);
  } else if (tracking.post_gate_sessions.length >= 5) {
    const successCount = tracking.post_gate_sessions.filter(s => s.passed).length;
    if (successCount >= 3) {
      console.log('\n✓ Gate appears effective - closing monitoring');
      tracking.status = 'resolved_effective';
      saveTracking(tracking);
    }
  } else {
    console.log('\n→ Continue monitoring');
  }
}

// Main
const [,, command, ...args] = process.argv;

switch (command) {
  case 'record':
    if (args.length < 2) {
      console.error('Usage: node e-budget-tracker.mjs record <session> <cost>');
      process.exit(1);
    }
    recordSession(args[0], args[1]);
    break;
  case 'status':
    showStatus();
    break;
  case 'check':
    checkEscalation();
    break;
  default:
    console.log('E Session Budget Gate Tracker (wq-190)');
    console.log('Usage:');
    console.log('  node e-budget-tracker.mjs record <session> <cost>');
    console.log('  node e-budget-tracker.mjs status');
    console.log('  node e-budget-tracker.mjs check');
}

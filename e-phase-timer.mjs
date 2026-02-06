#!/usr/bin/env node
/**
 * e-phase-timer.mjs — Lightweight phase timing for E sessions
 *
 * Usage:
 *   node e-phase-timer.mjs start <phase>   # Record phase start (0, 1, 1.5, 2, 3, 3.5, 4)
 *   node e-phase-timer.mjs summary         # Print phase durations
 *   node e-phase-timer.mjs reset           # Clear timing data for fresh session
 *
 * Stores timing in ~/.config/moltbook/e-phase-timing.json
 * Summary is also appended to engagement-trace.json if it exists.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.config', 'moltbook');
const TIMING_FILE = join(CONFIG_DIR, 'e-phase-timing.json');
const SESSION_NUM = process.env.SESSION_NUM || 'unknown';

const PHASE_NAMES = {
  '0': 'Ecosystem intelligence',
  '1': 'Platform setup + email',
  '1.5': 'Platform probe duty',
  '2': 'Engagement loop',
  '3': 'Close-out (trace + intel + memory)',
  '3.5': 'Artifact verification',
  '4': 'Session complete',
};

function load() {
  try {
    return JSON.parse(readFileSync(TIMING_FILE, 'utf8'));
  } catch {
    return { session: SESSION_NUM, phases: [] };
  }
}

function save(data) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TIMING_FILE, JSON.stringify(data, null, 2));
}

function startPhase(phase) {
  const data = load();
  // If new session, reset
  if (data.session !== SESSION_NUM) {
    data.session = SESSION_NUM;
    data.phases = [];
  }
  data.phases.push({ phase, start: new Date().toISOString() });
  save(data);
  console.log(`Phase ${phase} started (${PHASE_NAMES[phase] || phase})`);
}

function summary() {
  const data = load();
  if (!data.phases || data.phases.length === 0) {
    console.log('No phase timing data recorded.');
    return;
  }

  console.log(`E Session Phase Timing — s${data.session}\n`);

  const durations = [];
  for (let i = 0; i < data.phases.length; i++) {
    const phase = data.phases[i];
    const start = new Date(phase.start).getTime();
    const end = i + 1 < data.phases.length
      ? new Date(data.phases[i + 1].start).getTime()
      : Date.now();
    const durMs = end - start;
    const durSec = Math.round(durMs / 1000);
    const durMin = (durMs / 60000).toFixed(1);
    const name = PHASE_NAMES[phase.phase] || `Phase ${phase.phase}`;
    const isLast = i === data.phases.length - 1;
    durations.push({ phase: phase.phase, name, durSec, durMin, isLast });
    const suffix = isLast ? ' (ongoing)' : '';
    console.log(`  Phase ${phase.phase.toString().padEnd(4)} ${name.padEnd(35)} ${durMin.padStart(5)}m (${durSec}s)${suffix}`);
  }

  const totalMs = Date.now() - new Date(data.phases[0].start).getTime();
  const totalMin = (totalMs / 60000).toFixed(1);
  console.log(`\n  Total: ${totalMin}m`);

  // Identify bottleneck
  const completed = durations.filter(d => !d.isLast);
  if (completed.length > 0) {
    const longest = completed.reduce((a, b) => a.durSec > b.durSec ? a : b);
    const pct = Math.round((longest.durSec / (totalMs / 1000)) * 100);
    console.log(`  Bottleneck: Phase ${longest.phase} (${longest.name}) — ${pct}% of session`);
  }

  return durations;
}

function reset() {
  save({ session: SESSION_NUM, phases: [] });
  console.log('Phase timing reset.');
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'start' && arg) {
  startPhase(arg);
} else if (cmd === 'summary') {
  summary();
} else if (cmd === 'reset') {
  reset();
} else {
  console.log('Usage: node e-phase-timer.mjs start <phase> | summary | reset');
  console.log('Phases: 0, 1, 1.5, 2, 3, 3.5, 4');
}

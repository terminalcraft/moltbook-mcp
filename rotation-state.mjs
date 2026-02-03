#!/usr/bin/env node
/**
 * Rotation state manager — single source of truth for session rotation.
 * Consolidates: session_counter, rotation_index, rotation_retry_count, last_outcome
 * into one JSON file with atomic read/update semantics.
 *
 * Usage:
 *   node rotation-state.mjs read              # Output JSON state
 *   node rotation-state.mjs read --shell      # Output shell-compatible vars
 *   node rotation-state.mjs advance [outcome] # Advance rotation (success|timeout|error)
 *   node rotation-state.mjs set-outcome X     # Just set last_outcome without advancing
 *
 * R#116: Replaces 4 separate state files with single rotation-state.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.config', 'moltbook');
const STATE_FILE = join(STATE_DIR, 'rotation-state.json');
const LEGACY_FILES = {
  counter: join(STATE_DIR, 'session_counter'),
  rotIdx: join(STATE_DIR, 'rotation_index'),
  retryCount: join(STATE_DIR, 'rotation_retry_count'),
  outcome: join(STATE_DIR, 'last_outcome')
};
const MAX_RETRIES = 3;

function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    } catch (e) {
      console.error(`rotation-state: corrupt ${STATE_FILE}, rebuilding from legacy`);
    }
  }

  // Migrate from legacy files
  const state = {
    session_counter: 0,
    rotation_index: 0,
    retry_count: 0,
    last_outcome: 'success',
    migrated_from_legacy: true,
    last_updated: new Date().toISOString()
  };

  try {
    if (existsSync(LEGACY_FILES.counter)) {
      state.session_counter = parseInt(readFileSync(LEGACY_FILES.counter, 'utf-8').trim(), 10) || 0;
    }
    if (existsSync(LEGACY_FILES.rotIdx)) {
      state.rotation_index = parseInt(readFileSync(LEGACY_FILES.rotIdx, 'utf-8').trim(), 10) || 0;
    }
    if (existsSync(LEGACY_FILES.retryCount)) {
      state.retry_count = parseInt(readFileSync(LEGACY_FILES.retryCount, 'utf-8').trim(), 10) || 0;
    }
    if (existsSync(LEGACY_FILES.outcome)) {
      state.last_outcome = readFileSync(LEGACY_FILES.outcome, 'utf-8').trim() || 'success';
    }
  } catch (e) {
    // Legacy file read errors are non-fatal
  }

  return state;
}

function saveState(state) {
  state.last_updated = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'read';

  if (cmd === 'read') {
    const state = loadState();
    if (args[1] === '--shell') {
      // Output shell-compatible format for sourcing
      console.log(`COUNTER=${state.session_counter}`);
      console.log(`ROT_IDX=${state.rotation_index}`);
      console.log(`RETRY_COUNT=${state.retry_count}`);
      console.log(`LAST_OUTCOME=${state.last_outcome}`);
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
  }
  else if (cmd === 'advance') {
    // Advance rotation based on PREVIOUS session's outcome (already stored in state)
    // Does NOT set outcome — that's done at end of session via set-outcome
    const state = loadState();

    // Rotation logic from heartbeat.sh lines 74-99
    // Uses last_outcome from the PREVIOUS session to decide if we advance or retry
    if (state.last_outcome === 'success') {
      state.rotation_index++;
      state.retry_count = 0;
    } else if (state.retry_count >= MAX_RETRIES) {
      // Retry cap exceeded — advance anyway
      console.error(`rotation-state: retry-cap reached (${state.retry_count}), advancing rotation`);
      state.rotation_index++;
      state.retry_count = 0;
    } else {
      state.retry_count++;
      console.error(`rotation-state: retry ${state.retry_count}/${MAX_RETRIES} after ${state.last_outcome}`);
    }

    // Session counter always increments
    state.session_counter++;
    // NOTE: last_outcome is NOT changed here — it retains previous session's outcome
    // until set-outcome is called at the END of the current session

    saveState(state);

    // Output new state for caller
    if (args[1] === '--shell') {
      console.log(`COUNTER=${state.session_counter}`);
      console.log(`ROT_IDX=${state.rotation_index}`);
      console.log(`RETRY_COUNT=${state.retry_count}`);
      console.log(`LAST_OUTCOME=${state.last_outcome}`);
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
  }
  else if (cmd === 'set-outcome') {
    const outcome = args[1] || 'success';
    const state = loadState();
    state.last_outcome = outcome;
    saveState(state);
    console.log(`rotation-state: outcome set to ${outcome}`);
  }
  else if (cmd === 'increment-counter') {
    // Just increment session counter without advancing rotation (for override mode)
    const state = loadState();
    state.session_counter++;
    saveState(state);
    console.log(state.session_counter);
  }
  else {
    console.error('Usage: rotation-state.mjs [read|advance|set-outcome|increment-counter] [options]');
    process.exit(1);
  }
}

main();

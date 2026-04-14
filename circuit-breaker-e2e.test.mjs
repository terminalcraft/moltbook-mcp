#!/usr/bin/env node
// circuit-breaker-e2e.test.mjs — End-to-end integration test for auto-circuit-break (wq-986, d078)
//
// Validates the full pipeline: recordOutcome() → platform-circuits.json file writes
// Tests both auto-circuit-break (3 consecutive failures → status:closed) and
// auto-reopen (success clears status:closed).
//
// This exercises the REAL circuit-breaker.mjs functions against the REAL file,
// using a dedicated test platform name that gets cleaned up after.
//
// Usage: node --test circuit-breaker-e2e.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  loadCircuits,
  saveCircuits,
  getCircuitState,
  recordOutcome,
  filterByCircuit,
  CIRCUIT_FAILURE_THRESHOLD,
} from './lib/circuit-breaker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUIT_PATH = join(__dirname, 'platform-circuits.json');
const TEST_PLATFORM = '__test_e2e_autobreak__';

// Backup and restore real circuit data around the full test suite
let backupData;

before(() => {
  backupData = readFileSync(CIRCUIT_PATH, 'utf8');
  // Clean any leftover test entry
  const circuits = JSON.parse(backupData);
  delete circuits[TEST_PLATFORM];
  writeFileSync(CIRCUIT_PATH, JSON.stringify(circuits, null, 2) + '\n');
});

after(() => {
  // Restore original file, minus test platform
  const circuits = loadCircuits();
  delete circuits[TEST_PLATFORM];
  saveCircuits(circuits);
});

describe('Auto-circuit-break E2E: engage-orchestrator → circuit-breaker → platform-circuits.json', () => {

  test('3 consecutive failures auto-set status:closed in platform-circuits.json', () => {
    // Simulate 3 consecutive E session failures (the real threshold)
    assert.equal(CIRCUIT_FAILURE_THRESHOLD, 3, 'threshold should be 3');

    for (let i = 1; i <= CIRCUIT_FAILURE_THRESHOLD; i++) {
      const result = recordOutcome(TEST_PLATFORM, false);
      assert.equal(result.consecutive_failures, i);
      assert.equal(result.platform, TEST_PLATFORM);

      if (i < CIRCUIT_FAILURE_THRESHOLD) {
        // Before threshold: state should be closed (healthy), no status field
        assert.equal(result.state, 'closed');
        const onDisk = JSON.parse(readFileSync(CIRCUIT_PATH, 'utf8'));
        assert.equal(onDisk[TEST_PLATFORM].status, undefined,
          `status should not be set at ${i} failures`);
      }
    }

    // After threshold: verify file on disk has status:closed
    const onDisk = JSON.parse(readFileSync(CIRCUIT_PATH, 'utf8'));
    const entry = onDisk[TEST_PLATFORM];
    assert.equal(entry.status, 'closed', 'status should be "closed" after 3 failures');
    assert.equal(entry.consecutive_failures, CIRCUIT_FAILURE_THRESHOLD);
    assert.ok(entry.notes.includes('Auto-circuit-broken'), 'notes should mention auto-circuit-broken');
    assert.ok(entry.last_failure, 'last_failure should be set');

    // getCircuitState should report "open" (recent failure, within cooldown)
    const circuits = loadCircuits();
    const state = getCircuitState(circuits, TEST_PLATFORM);
    assert.equal(state, 'open', 'getCircuitState should return "open" for recently-failed platform');
  });

  test('filterByCircuit blocks auto-circuit-broken platform', () => {
    const result = filterByCircuit([TEST_PLATFORM, 'SomeHealthyPlatform']);
    assert.ok(result.blocked.some(b => b.platform === TEST_PLATFORM),
      'auto-circuit-broken platform should be in blocked list');
    assert.ok(result.allowed.includes('SomeHealthyPlatform'),
      'healthy platform should be in allowed list');
    assert.ok(!result.allowed.includes(TEST_PLATFORM),
      'auto-circuit-broken platform should NOT be in allowed list');
  });

  test('success clears status:closed (auto-reopen) in platform-circuits.json', () => {
    // Verify it's currently closed
    let circuits = loadCircuits();
    assert.equal(circuits[TEST_PLATFORM].status, 'closed', 'precondition: status is closed');

    // Record a success — this is the auto-reopen path
    const result = recordOutcome(TEST_PLATFORM, true);
    assert.equal(result.consecutive_failures, 0, 'consecutive_failures should reset to 0');
    assert.equal(result.state, 'closed', 'state should be "closed" (healthy) after success');

    // Verify file on disk: status field should be deleted
    const onDisk = JSON.parse(readFileSync(CIRCUIT_PATH, 'utf8'));
    const entry = onDisk[TEST_PLATFORM];
    assert.equal(entry.status, undefined, 'status should be cleared after success');
    assert.equal(entry.consecutive_failures, 0);
    assert.equal(entry.total_successes, 1);
    assert.equal(entry.total_failures, CIRCUIT_FAILURE_THRESHOLD);
    assert.ok(entry.last_success, 'last_success should be set');
  });

  test('after auto-reopen, filterByCircuit allows the platform again', () => {
    const result = filterByCircuit([TEST_PLATFORM]);
    assert.ok(result.allowed.includes(TEST_PLATFORM),
      'reopened platform should be in allowed list');
    assert.equal(result.blocked.length, 0, 'no platforms should be blocked');
  });

  test('full cycle: healthy → auto-break → auto-reopen → healthy', () => {
    // Clean slate for this platform
    const circuits = loadCircuits();
    delete circuits[TEST_PLATFORM];
    saveCircuits(circuits);

    // Phase 1: Record 2 failures — should stay healthy
    recordOutcome(TEST_PLATFORM, false);
    recordOutcome(TEST_PLATFORM, false);
    let state = getCircuitState(loadCircuits(), TEST_PLATFORM);
    assert.equal(state, 'closed', 'should be healthy with 2 failures');
    assert.equal(loadCircuits()[TEST_PLATFORM].status, undefined);

    // Phase 2: Third failure triggers auto-circuit-break
    recordOutcome(TEST_PLATFORM, false);
    state = getCircuitState(loadCircuits(), TEST_PLATFORM);
    assert.equal(state, 'open', 'should be open after 3 failures');
    assert.equal(loadCircuits()[TEST_PLATFORM].status, 'closed');

    // Phase 3: Platform is blocked from engagement
    let filter = filterByCircuit([TEST_PLATFORM]);
    assert.equal(filter.blocked.length, 1);
    assert.equal(filter.allowed.length, 0);

    // Phase 4: Success reopens
    recordOutcome(TEST_PLATFORM, true);
    state = getCircuitState(loadCircuits(), TEST_PLATFORM);
    assert.equal(state, 'closed', 'should be healthy after success');
    assert.equal(loadCircuits()[TEST_PLATFORM].status, undefined);

    // Phase 5: Platform is allowed again
    filter = filterByCircuit([TEST_PLATFORM]);
    assert.equal(filter.allowed.length, 1);
    assert.equal(filter.blocked.length, 0);
  });
});

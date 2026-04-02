#!/usr/bin/env node
// engage-orchestrator.test.mjs — DI-based unit tests for circuit breaker logic
// Tests: circuit state transitions, cooldown timing, outcome recording, edge cases
// Migrated from subprocess/SCRATCH-based tests to fast in-process DI tests (wq-834).
// Usage: node --test engage-orchestrator.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_COOLDOWN_MS } from './lib/circuit-breaker.mjs';
import { createCircuitStore, diRecordOutcome, diGetCircuitStatus } from './test-utils/circuit-store-mock.mjs';

// ===== TEST SUITES =====

describe('Circuit Breaker: State Transitions', () => {
  test('new platform starts with closed circuit', () => {
    const store = createCircuitStore();
    diRecordOutcome(store, 'TestPlatform', 'success');
    const status = diGetCircuitStatus(store);

    assert.equal(status.TestPlatform.state, 'closed');
    assert.equal(status.TestPlatform.consecutive_failures, 0);
    assert.equal(status.TestPlatform.total_successes, 1);
  });

  test('circuit remains closed under failure threshold', () => {
    const store = createCircuitStore();
    // 2 failures is under threshold of 3
    diRecordOutcome(store, 'TestPlatform', 'failure');
    diRecordOutcome(store, 'TestPlatform', 'failure');
    const status = diGetCircuitStatus(store);

    assert.equal(status.TestPlatform.state, 'closed');
    assert.equal(status.TestPlatform.consecutive_failures, 2);
    assert.equal(status.TestPlatform.total_failures, 2);
  });

  test('circuit opens after threshold consecutive failures', () => {
    const store = createCircuitStore();
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      diRecordOutcome(store, 'TestPlatform', 'failure');
    }
    const status = diGetCircuitStatus(store);

    assert.equal(status.TestPlatform.state, 'open');
    assert.equal(status.TestPlatform.consecutive_failures, CIRCUIT_FAILURE_THRESHOLD);
  });

  test('success resets consecutive failure count', () => {
    const store = createCircuitStore();
    diRecordOutcome(store, 'TestPlatform', 'failure');
    diRecordOutcome(store, 'TestPlatform', 'failure');
    diRecordOutcome(store, 'TestPlatform', 'success');
    const status = diGetCircuitStatus(store);

    assert.equal(status.TestPlatform.state, 'closed');
    assert.equal(status.TestPlatform.consecutive_failures, 0);
    assert.equal(status.TestPlatform.total_failures, 2);
    assert.equal(status.TestPlatform.total_successes, 1);
  });

  test('circuit transitions to half-open after cooldown', () => {
    const oldFailure = new Date(Date.now() - CIRCUIT_COOLDOWN_MS - 1000).toISOString();
    const store = createCircuitStore({
      TestPlatform: {
        consecutive_failures: 3,
        total_failures: 3,
        total_successes: 0,
        last_failure: oldFailure,
        last_success: null
      }
    });

    const status = diGetCircuitStatus(store);
    assert.equal(status.TestPlatform.state, 'half-open');
  });

  test('circuit stays open during cooldown period', () => {
    const recentFailure = new Date(Date.now() - 1000).toISOString();
    const store = createCircuitStore({
      TestPlatform: {
        consecutive_failures: 3,
        total_failures: 3,
        total_successes: 0,
        last_failure: recentFailure,
        last_success: null
      }
    });

    const status = diGetCircuitStatus(store);
    assert.equal(status.TestPlatform.state, 'open');
  });
});

describe('Circuit Breaker: Outcome Recording', () => {
  test('recordOutcome tracks success correctly', () => {
    const store = createCircuitStore();
    const result = diRecordOutcome(store, 'Platform1', 'success');

    assert.equal(result.platform, 'Platform1');
    assert.equal(result.consecutive_failures, 0);
    assert.equal(result.total_successes, 1);
    assert.equal(result.total_failures, 0);
    assert.ok(result.last_success);
    assert.equal(result.last_failure, null);
  });

  test('recordOutcome tracks failure correctly', () => {
    const store = createCircuitStore();
    const result = diRecordOutcome(store, 'Platform1', 'failure');

    assert.equal(result.platform, 'Platform1');
    assert.equal(result.consecutive_failures, 1);
    assert.equal(result.total_failures, 1);
    assert.equal(result.total_successes, 0);
    assert.ok(result.last_failure);
    assert.equal(result.last_success, null);
  });

  test('recordOutcome accumulates across multiple platforms', () => {
    const store = createCircuitStore();
    diRecordOutcome(store, 'Platform1', 'success');
    diRecordOutcome(store, 'Platform2', 'failure');
    diRecordOutcome(store, 'Platform3', 'success');

    const status = diGetCircuitStatus(store);

    assert.equal(Object.keys(status).length, 3);
    assert.equal(status.Platform1.total_successes, 1);
    assert.equal(status.Platform2.total_failures, 1);
    assert.equal(status.Platform3.total_successes, 1);
  });

  test('recordOutcome returns correct state after threshold', () => {
    const store = createCircuitStore();
    let result;
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      result = diRecordOutcome(store, 'Platform1', 'failure');
    }

    assert.equal(result.state, 'open');
    assert.equal(result.consecutive_failures, CIRCUIT_FAILURE_THRESHOLD);
  });

  test('success after open circuit transitions to closed', () => {
    const store = createCircuitStore();
    // Open the circuit
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      diRecordOutcome(store, 'Platform1', 'failure');
    }

    // Success resets it
    const result = diRecordOutcome(store, 'Platform1', 'success');

    assert.equal(result.state, 'closed');
    assert.equal(result.consecutive_failures, 0);
  });
});

describe('Circuit Breaker: Cooldown Timing', () => {
  test('cooldown boundary: just before expiry stays open', () => {
    // 1 second before cooldown expires
    const justBeforeCooldown = new Date(Date.now() - CIRCUIT_COOLDOWN_MS + 1000).toISOString();
    const store = createCircuitStore({
      TestPlatform: {
        consecutive_failures: 5,
        total_failures: 5,
        total_successes: 0,
        last_failure: justBeforeCooldown,
        last_success: null
      }
    });

    const status = diGetCircuitStatus(store);
    assert.equal(status.TestPlatform.state, 'open');
  });

  test('cooldown boundary: just after expiry becomes half-open', () => {
    // 1 second after cooldown expires
    const justAfterCooldown = new Date(Date.now() - CIRCUIT_COOLDOWN_MS - 1000).toISOString();
    const store = createCircuitStore({
      TestPlatform: {
        consecutive_failures: 5,
        total_failures: 5,
        total_successes: 0,
        last_failure: justAfterCooldown,
        last_success: null
      }
    });

    const status = diGetCircuitStatus(store);
    assert.equal(status.TestPlatform.state, 'half-open');
  });

  test('multiple platforms can have different states simultaneously', () => {
    const recentFailure = new Date(Date.now() - 1000).toISOString();
    const oldFailure = new Date(Date.now() - CIRCUIT_COOLDOWN_MS - 1000).toISOString();

    const store = createCircuitStore({
      ClosedPlatform: {
        consecutive_failures: 1,
        total_failures: 1,
        total_successes: 5,
        last_failure: recentFailure,
        last_success: new Date().toISOString()
      },
      OpenPlatform: {
        consecutive_failures: 3,
        total_failures: 3,
        total_successes: 0,
        last_failure: recentFailure,
        last_success: null
      },
      HalfOpenPlatform: {
        consecutive_failures: 3,
        total_failures: 3,
        total_successes: 0,
        last_failure: oldFailure,
        last_success: null
      }
    });

    const status = diGetCircuitStatus(store);
    assert.equal(status.ClosedPlatform.state, 'closed');
    assert.equal(status.OpenPlatform.state, 'open');
    assert.equal(status.HalfOpenPlatform.state, 'half-open');
  });
});

describe('Circuit Breaker: Edge Cases', () => {
  test('empty circuit file returns empty status', () => {
    const store = createCircuitStore();
    // No circuits recorded
    const status = diGetCircuitStatus(store);
    assert.deepEqual(status, {});
  });

  test('platform names with special characters handled correctly', () => {
    const store = createCircuitStore();
    // Platform names in practice use dots, dashes, etc (e.g., 4claw.org, Chatr.ai)
    const result = diRecordOutcome(store, 'Test-Platform.org', 'success');
    assert.equal(result.platform, 'Test-Platform.org');

    const status = diGetCircuitStatus(store);
    assert.ok(status['Test-Platform.org']);
  });

  test('high failure counts work correctly', () => {
    // Simulate a platform that failed many times
    const store = createCircuitStore({
      ReliablyBad: {
        consecutive_failures: 100,
        total_failures: 500,
        total_successes: 10,
        last_failure: new Date().toISOString(),
        last_success: new Date(Date.now() - 86400000 * 7).toISOString()
      }
    });

    const status = diGetCircuitStatus(store);
    assert.equal(status.ReliablyBad.state, 'open');
    assert.equal(status.ReliablyBad.total_failures, 500);
  });

  test('consecutive failures reset to 0 after success regardless of previous count', () => {
    const store = createCircuitStore({
      TestPlatform: {
        consecutive_failures: 50,
        total_failures: 100,
        total_successes: 0,
        last_failure: new Date().toISOString(),
        last_success: null
      }
    });

    const result = diRecordOutcome(store, 'TestPlatform', 'success');
    assert.equal(result.consecutive_failures, 0);
    assert.equal(result.total_successes, 1);
    assert.equal(result.total_failures, 100); // preserved
  });
});

describe('Circuit Breaker: Auto-circuit-break (d078, wq-978)', () => {
  test('auto-sets status:closed when consecutive_failures reaches threshold', () => {
    const store = createCircuitStore();
    let result;
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      result = diRecordOutcome(store, 'AutoBreak1', 'failure');
    }

    assert.equal(result.consecutive_failures, CIRCUIT_FAILURE_THRESHOLD);
    assert.equal(result.state, 'open');
    // Verify status was written to the store
    const circuits = store.loadCircuits();
    assert.equal(circuits.AutoBreak1.status, 'closed');
    assert.ok(circuits.AutoBreak1.notes.includes('Auto-circuit-broken'));
  });

  test('does not double-write status if already closed', () => {
    const store = createCircuitStore({
      AlreadyClosed: {
        consecutive_failures: 5,
        total_failures: 10,
        total_successes: 20,
        last_failure: new Date().toISOString(),
        last_success: null,
        status: 'closed',
        notes: 'Manual circuit-break note'
      }
    });

    // Another failure should not overwrite existing notes
    const result = diRecordOutcome(store, 'AlreadyClosed', 'failure');
    const circuits = store.loadCircuits();
    assert.equal(circuits.AlreadyClosed.status, 'closed');
    assert.equal(circuits.AlreadyClosed.notes, 'Manual circuit-break note');
  });

  test('success clears closed status (auto-reopen)', () => {
    const store = createCircuitStore({
      WasClosed: {
        consecutive_failures: 5,
        total_failures: 10,
        total_successes: 20,
        last_failure: new Date().toISOString(),
        last_success: null,
        status: 'closed',
        notes: 'Some notes'
      }
    });

    const result = diRecordOutcome(store, 'WasClosed', 'success');
    assert.equal(result.consecutive_failures, 0);
    assert.equal(result.state, 'closed'); // getCircuitState returns 'closed' for healthy
    const circuits = store.loadCircuits();
    assert.equal(circuits.WasClosed.status, undefined);
  });

  test('failures below threshold do not set status:closed', () => {
    const store = createCircuitStore();
    // Record failures just below threshold
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
      diRecordOutcome(store, 'BelowThreshold', 'failure');
    }

    const circuits = store.loadCircuits();
    assert.equal(circuits.BelowThreshold.status, undefined);
    assert.equal(circuits.BelowThreshold.consecutive_failures, CIRCUIT_FAILURE_THRESHOLD - 1);
  });
});

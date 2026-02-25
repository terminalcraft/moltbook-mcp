#!/usr/bin/env node
// engage-orchestrator.test.mjs — Unit tests for engage-orchestrator.mjs circuit breaker
// Tests: circuit state transitions, cooldown timing, outcome recording, ROI calculation
// Usage: node --test engage-orchestrator.test.mjs

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(tmpdir(), 'eo-test-' + Date.now());

// Constants from engage-orchestrator.mjs
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 24 * 3600 * 1000; // 24h

function setup() {
  mkdirSync(SCRATCH, { recursive: true });

  // Copy engage-orchestrator.mjs and patch paths
  let src = readFileSync(join(__dirname, 'engage-orchestrator.mjs'), 'utf8');

  // Patch the import to use absolute path to the original providers directory
  const providersPath = join(__dirname, 'providers', 'engagement-analytics.js');
  src = src.replace(
    'import { analyzeEngagement } from "./providers/engagement-analytics.js";',
    `import { analyzeEngagement } from ${JSON.stringify('file://' + providersPath)};`
  );

  // Patch file paths to use SCRATCH directory
  src = src.replace(
    'const SERVICES_PATH = join(__dirname, "services.json");',
    `const SERVICES_PATH = ${JSON.stringify(join(SCRATCH, 'services.json'))};`
  );
  src = src.replace(
    'const INTEL_PATH = join(__dirname, "engagement-intel.json");',
    `const INTEL_PATH = ${JSON.stringify(join(SCRATCH, 'engagement-intel.json'))};`
  );
  src = src.replace(
    'const CIRCUIT_PATH = join(__dirname, "platform-circuits.json");',
    `const CIRCUIT_PATH = ${JSON.stringify(join(SCRATCH, 'platform-circuits.json'))};`
  );

  writeFileSync(join(SCRATCH, 'engage-orchestrator.mjs'), src);

  // Create minimal services.json
  writeFileSync(join(SCRATCH, 'services.json'), JSON.stringify({
    services: []
  }));
}

function cleanup() {
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}

function writeCircuits(circuits) {
  writeFileSync(join(SCRATCH, 'platform-circuits.json'), JSON.stringify(circuits, null, 2));
}

function readCircuits() {
  const path = join(SCRATCH, 'platform-circuits.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function recordOutcome(platform, outcome) {
  const result = execSync(
    `node ${join(SCRATCH, 'engage-orchestrator.mjs')} --record-outcome ${platform} ${outcome}`,
    { encoding: 'utf8', timeout: 5000 }
  );
  return JSON.parse(result);
}

function getCircuitStatus() {
  const result = execSync(
    `node ${join(SCRATCH, 'engage-orchestrator.mjs')} --circuit-status`,
    { encoding: 'utf8', timeout: 5000 }
  );
  return JSON.parse(result);
}

// ===== TEST SUITES =====

describe('Circuit Breaker: State Transitions', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  test('new platform starts with closed circuit', () => {
    recordOutcome('TestPlatform', 'success');
    const status = getCircuitStatus();

    assert.equal(status.TestPlatform.state, 'closed');
    assert.equal(status.TestPlatform.consecutive_failures, 0);
    assert.equal(status.TestPlatform.total_successes, 1);
  });

  test('circuit remains closed under failure threshold', () => {
    // 2 failures is under threshold of 3
    recordOutcome('TestPlatform', 'failure');
    recordOutcome('TestPlatform', 'failure');
    const status = getCircuitStatus();

    assert.equal(status.TestPlatform.state, 'closed');
    assert.equal(status.TestPlatform.consecutive_failures, 2);
    assert.equal(status.TestPlatform.total_failures, 2);
  });

  test('circuit opens after threshold consecutive failures', () => {
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      recordOutcome('TestPlatform', 'failure');
    }
    const status = getCircuitStatus();

    assert.equal(status.TestPlatform.state, 'open');
    assert.equal(status.TestPlatform.consecutive_failures, CIRCUIT_FAILURE_THRESHOLD);
  });

  test('success resets consecutive failure count', () => {
    recordOutcome('TestPlatform', 'failure');
    recordOutcome('TestPlatform', 'failure');
    recordOutcome('TestPlatform', 'success');
    const status = getCircuitStatus();

    assert.equal(status.TestPlatform.state, 'closed');
    assert.equal(status.TestPlatform.consecutive_failures, 0);
    assert.equal(status.TestPlatform.total_failures, 2);
    assert.equal(status.TestPlatform.total_successes, 1);
  });

  test('circuit transitions to half-open after cooldown', () => {
    // Create circuit data with old last_failure (past cooldown)
    const oldFailure = new Date(Date.now() - CIRCUIT_COOLDOWN_MS - 1000).toISOString();
    writeCircuits({
      TestPlatform: {
        consecutive_failures: 3,
        total_failures: 3,
        total_successes: 0,
        last_failure: oldFailure,
        last_success: null
      }
    });

    const status = getCircuitStatus();
    assert.equal(status.TestPlatform.state, 'half-open');
  });

  test('circuit stays open during cooldown period', () => {
    // Create circuit data with recent last_failure (within cooldown)
    const recentFailure = new Date(Date.now() - 1000).toISOString();
    writeCircuits({
      TestPlatform: {
        consecutive_failures: 3,
        total_failures: 3,
        total_successes: 0,
        last_failure: recentFailure,
        last_success: null
      }
    });

    const status = getCircuitStatus();
    assert.equal(status.TestPlatform.state, 'open');
  });
});

describe('Circuit Breaker: Outcome Recording', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  test('recordOutcome tracks success correctly', () => {
    const result = recordOutcome('Platform1', 'success');

    assert.equal(result.platform, 'Platform1');
    assert.equal(result.consecutive_failures, 0);
    assert.equal(result.total_successes, 1);
    assert.equal(result.total_failures, 0);
    assert.ok(result.last_success);
    assert.equal(result.last_failure, null);
  });

  test('recordOutcome tracks failure correctly', () => {
    const result = recordOutcome('Platform1', 'failure');

    assert.equal(result.platform, 'Platform1');
    assert.equal(result.consecutive_failures, 1);
    assert.equal(result.total_failures, 1);
    assert.equal(result.total_successes, 0);
    assert.ok(result.last_failure);
    assert.equal(result.last_success, null);
  });

  test('recordOutcome accumulates across multiple platforms', () => {
    recordOutcome('Platform1', 'success');
    recordOutcome('Platform2', 'failure');
    recordOutcome('Platform3', 'success');

    const status = getCircuitStatus();

    assert.equal(Object.keys(status).length, 3);
    assert.equal(status.Platform1.total_successes, 1);
    assert.equal(status.Platform2.total_failures, 1);
    assert.equal(status.Platform3.total_successes, 1);
  });

  test('recordOutcome returns correct state after threshold', () => {
    let result;
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      result = recordOutcome('Platform1', 'failure');
    }

    assert.equal(result.state, 'open');
    assert.equal(result.consecutive_failures, CIRCUIT_FAILURE_THRESHOLD);
  });

  test('success after open circuit transitions to closed', () => {
    // Open the circuit
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
      recordOutcome('Platform1', 'failure');
    }

    // Success resets it
    const result = recordOutcome('Platform1', 'success');

    assert.equal(result.state, 'closed');
    assert.equal(result.consecutive_failures, 0);
  });
});

describe('Circuit Breaker: Cooldown Timing', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  test('cooldown boundary: just before expiry stays open', () => {
    // 1 second before cooldown expires
    const justBeforeCooldown = new Date(Date.now() - CIRCUIT_COOLDOWN_MS + 1000).toISOString();
    writeCircuits({
      TestPlatform: {
        consecutive_failures: 5,
        total_failures: 5,
        total_successes: 0,
        last_failure: justBeforeCooldown,
        last_success: null
      }
    });

    const status = getCircuitStatus();
    assert.equal(status.TestPlatform.state, 'open');
  });

  test('cooldown boundary: just after expiry becomes half-open', () => {
    // 1 second after cooldown expires
    const justAfterCooldown = new Date(Date.now() - CIRCUIT_COOLDOWN_MS - 1000).toISOString();
    writeCircuits({
      TestPlatform: {
        consecutive_failures: 5,
        total_failures: 5,
        total_successes: 0,
        last_failure: justAfterCooldown,
        last_success: null
      }
    });

    const status = getCircuitStatus();
    assert.equal(status.TestPlatform.state, 'half-open');
  });

  test('multiple platforms can have different states simultaneously', () => {
    const recentFailure = new Date(Date.now() - 1000).toISOString();
    const oldFailure = new Date(Date.now() - CIRCUIT_COOLDOWN_MS - 1000).toISOString();

    writeCircuits({
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

    const status = getCircuitStatus();
    assert.equal(status.ClosedPlatform.state, 'closed');
    assert.equal(status.OpenPlatform.state, 'open');
    assert.equal(status.HalfOpenPlatform.state, 'half-open');
  });
});

describe('Circuit Breaker: Edge Cases', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  test('empty circuit file returns empty status', () => {
    // Don't write any circuit file
    const status = getCircuitStatus();
    assert.deepEqual(status, {});
  });

  test('platform names with special characters handled correctly', () => {
    // Platform names in practice use dots, dashes, etc (e.g., 4claw.org, Chatr.ai)
    const result = recordOutcome('Test-Platform.org', 'success');
    assert.equal(result.platform, 'Test-Platform.org');

    const status = getCircuitStatus();
    assert.ok(status['Test-Platform.org']);
  });

  test('high failure counts work correctly', () => {
    // Simulate a platform that failed many times
    writeCircuits({
      ReliablyBad: {
        consecutive_failures: 100,
        total_failures: 500,
        total_successes: 10,
        last_failure: new Date().toISOString(),
        last_success: new Date(Date.now() - 86400000 * 7).toISOString()
      }
    });

    const status = getCircuitStatus();
    assert.equal(status.ReliablyBad.state, 'open');
    assert.equal(status.ReliablyBad.total_failures, 500);
  });

  test('consecutive failures reset to 0 after success regardless of previous count', () => {
    writeCircuits({
      TestPlatform: {
        consecutive_failures: 50,
        total_failures: 100,
        total_successes: 0,
        last_failure: new Date().toISOString(),
        last_success: null
      }
    });

    const result = recordOutcome('TestPlatform', 'success');
    assert.equal(result.consecutive_failures, 0);
    assert.equal(result.total_successes, 1);
    assert.equal(result.total_failures, 100); // preserved
  });
});


// Run the tests
console.log('Running engage-orchestrator.mjs tests...\n');

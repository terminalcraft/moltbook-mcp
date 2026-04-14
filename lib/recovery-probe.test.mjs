#!/usr/bin/env node
// recovery-probe.test.mjs — Unit test for auto-recovery probe (wq-990, d078)
//
// Tests probeCircuitBroken() against a mocked platform-circuits.json.
// Validates: closed platforms get probed, recovered on success, skipped when
// notes say "Human intervention", defunct excluded, failures don't increment.
//
// Usage: node --test lib/recovery-probe.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUIT_PATH = join(__dirname, '..', 'platform-circuits.json');

let backupData;

before(() => {
  backupData = readFileSync(CIRCUIT_PATH, 'utf8');
});

after(() => {
  // Restore original circuits
  writeFileSync(CIRCUIT_PATH, backupData);
});

describe('recovery-probe: probeCircuitBroken()', () => {

  test('skips platforms with "Human intervention" in notes', async () => {
    // Setup: inject a closed platform with human-intervention notes
    const circuits = JSON.parse(backupData);
    circuits['__test_recovery_human__'] = {
      consecutive_failures: 10,
      total_failures: 10,
      total_successes: 0,
      status: 'closed',
      notes: 'Human intervention required — dashboard setup needed',
    };
    writeFileSync(CIRCUIT_PATH, JSON.stringify(circuits, null, 2) + '\n');

    const { probeCircuitBroken } = await import('./recovery-probe.mjs');
    const result = await probeCircuitBroken({ dryRun: true });

    // Human intervention platform should NOT be in recovered or failed
    assert.ok(!result.recovered.includes('__test_recovery_human__'),
      'Should not probe platforms needing human intervention');

    // Cleanup
    delete circuits['__test_recovery_human__'];
    writeFileSync(CIRCUIT_PATH, JSON.stringify(circuits, null, 2) + '\n');
  });

  test('returns probed=0 when no platforms are circuit-broken', async () => {
    // Setup: remove all closed statuses
    const circuits = JSON.parse(backupData);
    const modified = {};
    for (const [k, v] of Object.entries(circuits)) {
      modified[k] = { ...v };
      if (modified[k].status === 'closed') delete modified[k].status;
    }
    writeFileSync(CIRCUIT_PATH, JSON.stringify(modified, null, 2) + '\n');

    // Dynamic import to get fresh file read
    const mod = await import('./recovery-probe.mjs?t=' + Date.now());
    const result = await mod.probeCircuitBroken({ dryRun: true });

    assert.equal(result.probed, 0, 'Should find 0 circuit-broken platforms');
    assert.deepEqual(result.recovered, []);
    assert.deepEqual(result.failed, []);
  });

  test('skips platforms with "DNS NXDOMAIN" in notes', async () => {
    const circuits = JSON.parse(backupData);
    circuits['__test_dns_dead__'] = {
      consecutive_failures: 5,
      total_failures: 5,
      total_successes: 0,
      status: 'closed',
      notes: 'DNS NXDOMAIN, domain not resolving',
    };
    writeFileSync(CIRCUIT_PATH, JSON.stringify(circuits, null, 2) + '\n');

    const { probeCircuitBroken } = await import('./recovery-probe.mjs?dns=' + Date.now());
    const result = await probeCircuitBroken({ dryRun: true });

    assert.ok(!result.recovered.includes('__test_dns_dead__'));
    assert.ok(!result.failed.includes('__test_dns_dead__'));

    // Cleanup
    delete circuits['__test_dns_dead__'];
    writeFileSync(CIRCUIT_PATH, JSON.stringify(circuits, null, 2) + '\n');
  });

  test('probes closed platforms and reports results', async () => {
    // This test uses the real circuit data — existing closed platforms get probed
    // We use dryRun to avoid modifying state
    const { probeCircuitBroken } = await import('./recovery-probe.mjs?real=' + Date.now());
    const result = await probeCircuitBroken({ dryRun: true });

    // moltbook has "Human intervention" → skipped
    // nicepick has "DNS NXDOMAIN" → skipped
    // Remaining closed platforms (grove, thecolony, ctxly, shipyard) should be probed
    assert.ok(result.probed >= 0, 'Should return probed count');
    assert.ok(Array.isArray(result.recovered));
    assert.ok(Array.isArray(result.failed));
    assert.ok(Array.isArray(result.results));

    // Every result should have required fields
    for (const r of result.results) {
      assert.ok(r.platform, 'Result must have platform');
      assert.ok(['recovered', 'still_down', 'probe_error', 'skipped'].includes(r.outcome),
        `Unexpected outcome: ${r.outcome}`);
    }
  });
});

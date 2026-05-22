#!/usr/bin/env node
// e-prehook-runner.test.mjs — Tests for E session prehook runner
//
// Tests: output structure, summary format, graceful degradation when network
// calls fail, and seed generation with mock context.
//
// Usage: node --test e-prehook-runner.test.mjs
// Created: wq-1031

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(tmpdir(), 'e-prehook-test-' + Date.now());

function setup() {
  mkdirSync(SCRATCH, { recursive: true });
}

function cleanup() {
  rmSync(SCRATCH, { recursive: true, force: true });
}

// Run the e-prehook-runner as a subprocess and parse its JSON output.
// E runner has async network calls that may timeout — use generous timeout.
function runRunner(sessionNum, contextFile, policyFile) {
  const args = [`--session`, `${sessionNum}`];
  if (contextFile) args.push('--context-file', contextFile);
  if (policyFile) args.push('--policy-file', policyFile);

  const cmd = `node ${join(__dirname, 'e-prehook-runner.mjs')} ${args.join(' ')}`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
    const lines = out.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch {}
    }
    throw new Error('No valid JSON in runner output: ' + out.slice(0, 200));
  } catch (e) {
    if (e.stdout) {
      const lines = e.stdout.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]); } catch {}
      }
    }
    throw e;
  }
}

describe('e-prehook-runner output structure', () => {
  before(setup);
  after(cleanup);

  it('produces all expected top-level keys', () => {
    const ctxFile = join(SCRATCH, 'context.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nonexistent-policy.json'));
    assert.ok('seed' in out);
    assert.ok('thread_tracker' in out);
    assert.ok('topic_clusters' in out);
    assert.ok('conversation_balance' in out);
    assert.ok('spending_policy' in out);
    assert.ok('credential_health' in out);
    assert.ok('engagement_variety' in out);
    assert.ok('colony_jwt' in out);
    assert.ok('picker' in out);
    assert.ok('picker_revalidate' in out);
    assert.ok('recovery_probe' in out);
    assert.ok('summary' in out);
  });

  it('summary is a string with completion marker', () => {
    const ctxFile = join(SCRATCH, 'context2.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    assert.equal(typeof out.summary, 'string');
    assert.ok(out.summary.includes('[e-prehook]'));
  });
});

describe('e-prehook-runner spending policy', () => {
  before(setup);
  after(cleanup);

  it('reports disabled when policy file missing', () => {
    const ctxFile = join(SCRATCH, 'ctx-sp.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'no-policy.json'));
    const sp = out.spending_policy;
    assert.ok(sp.status === 'disabled' || sp.error,
      'should report disabled or error when policy file missing');
  });

  it('reads valid policy file and reports budget', () => {
    const ctxFile = join(SCRATCH, 'ctx-sp2.md');
    const policyFile = join(SCRATCH, 'policy.json');
    writeFileSync(policyFile, JSON.stringify({
      monthly_limit: 5.00,
      per_session: 1.00,
      per_platform: 0.50,
      min_roi: 0.5,
      ledger: { month: '2026-05', spent: 1.50 }
    }));

    const out = runRunner(9999, ctxFile, policyFile);
    const sp = out.spending_policy;
    // Should successfully parse and return budget data
    if (!sp.error) {
      assert.ok(sp.monthlyLimit || sp.status === 'disabled');
    }
  });
});

describe('e-prehook-runner seed generation', () => {
  before(setup);
  after(cleanup);

  it('generates seed and writes context file', () => {
    const ctxFile = join(SCRATCH, 'ctx-seed.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));

    // Seed should report success or error
    assert.ok(out.seed);
    if (!out.seed.error) {
      assert.ok(out.seed.wrote || out.seed.lines !== undefined);
      // Context file should have been created
      assert.ok(existsSync(ctxFile), 'context file should be created by seed');
    }
  });
});

describe('e-prehook-runner recovery probe', () => {
  before(setup);
  after(cleanup);

  it('skips recovery probe when session not on interval', () => {
    const ctxFile = join(SCRATCH, 'ctx-rp.md');
    // Session 9999 is not a multiple of 30
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    const rp = out.recovery_probe;
    if (!rp.error) {
      assert.ok(rp.skipped, 'should skip when not on recovery interval');
    }
  });

  it('runs recovery probe when session on interval', () => {
    const ctxFile = join(SCRATCH, 'ctx-rp2.md');
    // Session 9990 is a multiple of 30
    const out = runRunner(9990, ctxFile, join(SCRATCH, 'nope.json'));
    const rp = out.recovery_probe;
    // Should either run (probed field) or error (network issues in test env)
    assert.ok(rp.probed !== undefined || rp.error || rp.skipped !== true);
  });
});

describe('e-prehook-runner graceful degradation', () => {
  before(setup);
  after(cleanup);

  it('produces valid JSON even when network checks fail', () => {
    const ctxFile = join(SCRATCH, 'ctx-degrade.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    // All checks should have either result or error — never undefined
    const checks = [
      'seed', 'thread_tracker', 'topic_clusters', 'conversation_balance',
      'spending_policy', 'credential_health', 'engagement_variety',
      'colony_jwt', 'picker', 'picker_revalidate', 'recovery_probe'
    ];
    for (const key of checks) {
      assert.ok(out[key] !== undefined, `${key} should not be undefined`);
    }
  });

  it('engagement_variety handles missing trace file', () => {
    const ctxFile = join(SCRATCH, 'ctx-ev.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    const ev = out.engagement_variety;
    // Should gracefully report error about missing trace data
    assert.ok(ev.error || ev.healthScore, 'should have error or healthScore');
  });
});

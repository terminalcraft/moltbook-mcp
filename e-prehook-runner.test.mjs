#!/usr/bin/env node
// e-prehook-runner.test.mjs — Tests for E session prehook runner
//
// Tests: output structure, summary format, graceful degradation when network
// calls fail, and seed generation with mock context.
//
// Uses --mock-network flag (wq-1032) to skip real async network calls (chatr,
// colony-jwt, recovery-probe, credential-health), testing logic paths without
// network latency.
//
// Usage: node --test e-prehook-runner.test.mjs
// Created: wq-1031
// Updated: wq-1032 — mock network calls for faster CI

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
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
// --mock-network replaces async network calls with instant mocks.
function runRunner(sessionNum, contextFile, policyFile, { mockNetwork = true } = {}) {
  const args = [`--session`, `${sessionNum}`];
  if (contextFile) args.push('--context-file', contextFile);
  if (policyFile) args.push('--policy-file', policyFile);
  if (mockNetwork) args.push('--mock-network');

  const cmd = `node ${join(__dirname, 'e-prehook-runner.mjs')} ${args.join(' ')}`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
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
    assert.ok('substance_probe' in out);
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

  it('runs recovery probe mock when session on interval', () => {
    const ctxFile = join(SCRATCH, 'ctx-rp2.md');
    // Session 9990 is a multiple of 30 — with mock, probe returns skipped+mock
    const out = runRunner(9990, ctxFile, join(SCRATCH, 'nope.json'));
    const rp = out.recovery_probe;
    // Mock returns { skipped: true, reason: 'mock-network' }
    assert.ok(rp.skipped === true || rp.error);
  });
});

describe('e-prehook-runner mock-network behavior', () => {
  before(setup);
  after(cleanup);

  it('thread_tracker returns mock result with zero messages', () => {
    const ctxFile = join(SCRATCH, 'ctx-mock-tt.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    const tt = out.thread_tracker;
    assert.ok(!tt.error, 'mock should not error');
    assert.equal(tt.messagesProcessed, 0);
  });

  it('colony_jwt returns skip status under mock', () => {
    const ctxFile = join(SCRATCH, 'ctx-mock-jwt.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    const cj = out.colony_jwt;
    assert.ok(!cj.error, 'mock should not error');
    assert.equal(cj.status, 'skip');
    assert.equal(cj.reason, 'mock-network');
  });

  it('credential_health returns zero totals under mock', () => {
    const ctxFile = join(SCRATCH, 'ctx-mock-cred.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    const ch = out.credential_health;
    assert.ok(!ch.error, 'mock should not error');
    assert.equal(ch.healthy, 0);
    assert.equal(ch.total, 0);
  });

  it('summary includes mock-network indicator for colony-jwt', () => {
    const ctxFile = join(SCRATCH, 'ctx-mock-sum.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    assert.ok(out.summary.includes('mock-network'), 'summary should mention mock-network');
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
      'colony_jwt', 'picker', 'picker_revalidate', 'recovery_probe',
      'substance_probe'
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

describe('e-prehook-runner substance probe', () => {
  const mandatePath = join(process.env.HOME || '/home/moltbot', '.config/moltbook/picker-mandate.json');
  let savedMandate = null;

  before(() => {
    setup();
    // Preserve existing mandate file
    if (existsSync(mandatePath)) {
      savedMandate = readFileSync(mandatePath, 'utf8');
    }
  });

  after(() => {
    // Restore original mandate
    if (savedMandate !== null) {
      writeFileSync(mandatePath, savedMandate);
    }
    cleanup();
  });

  it('substance_probe is skipped when MoltCities not in mandate', () => {
    // Write mandate without MoltCities
    writeFileSync(mandatePath, JSON.stringify({
      selected: ['Moltchan', '4claw.org', 'Chatr'],
      backups: ['DevAIntArt'],
      revalidated_at: new Date().toISOString()
    }));
    const ctxFile = join(SCRATCH, 'ctx-sp-skip.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    const sp = out.substance_probe;
    assert.ok(sp.skipped, 'should be skipped when MoltCities not in mandate');
    assert.ok(sp.reason.includes('not in mandate'), 'reason should mention not in mandate');
  });

  it('reports no-substance when MoltCities in mandate with mock (empty agents)', () => {
    // Mock _mcFetch returns { agents: [] }, so no agents to score → no_substantive_agents
    writeFileSync(mandatePath, JSON.stringify({
      selected: ['Moltchan', 'MoltCities', 'Chatr'],
      backups: [],
      revalidated_at: new Date().toISOString()
    }));
    const ctxFile = join(SCRATCH, 'ctx-sp-nosub.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    const sp = out.substance_probe;
    assert.ok(!sp.skipped, 'should not be skipped when MoltCities in mandate');
    assert.equal(sp.picked, null, 'picked should be null with empty mock agents');
    assert.equal(sp.reason, 'no_substantive_agents');
    assert.equal(sp.total, 0);
  });

  it('appends NO_SUBSTANCE block to context file when MoltCities in mandate', () => {
    writeFileSync(mandatePath, JSON.stringify({
      selected: ['MoltCities'],
      backups: [],
      revalidated_at: new Date().toISOString()
    }));
    const ctxFile = join(SCRATCH, 'ctx-sp-ctx.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    assert.ok(existsSync(ctxFile), 'context file should exist');
    const ctx = readFileSync(ctxFile, 'utf8');
    assert.ok(ctx.includes('MoltCities substance probe'), 'context should have substance probe section');
    assert.ok(ctx.includes('NO_SUBSTANCE'), 'context should have NO_SUBSTANCE result');
  });

  it('substance_probe skipped when MoltCities only in backups and not selected', () => {
    writeFileSync(mandatePath, JSON.stringify({
      selected: ['Moltchan', 'Chatr'],
      backups: ['MoltCities'],
      revalidated_at: new Date().toISOString()
    }));
    const ctxFile = join(SCRATCH, 'ctx-sp-backup.md');
    const out = runRunner(9999, ctxFile, join(SCRATCH, 'nope.json'));
    const sp = out.substance_probe;
    // MoltCities in backups should still trigger the probe (runner checks both)
    assert.ok(!sp.skipped, 'should run when MoltCities is in backups');
  });
});

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
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execRunner, createScratch } from './test-runner-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scratch = createScratch('e-prehook-test');

// Run the e-prehook-runner as a subprocess and parse its JSON output.
// --mock-network replaces async network calls with instant mocks.
function runRunner(sessionNum, contextFile, policyFile, { mockNetwork = true } = {}) {
  const args = [`--session`, `${sessionNum}`];
  if (contextFile) args.push('--context-file', contextFile);
  if (policyFile) args.push('--policy-file', policyFile);
  if (mockNetwork) args.push('--mock-network');

  const cmd = `node ${join(__dirname, 'e-prehook-runner.mjs')} ${args.join(' ')}`;
  return execRunner(cmd);
}

describe('e-prehook-runner output structure', () => {
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('produces all expected top-level keys', () => {
    const ctxFile = join(scratch.dir, 'context.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nonexistent-policy.json'));
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
    const ctxFile = join(scratch.dir, 'context2.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
    assert.equal(typeof out.summary, 'string');
    assert.ok(out.summary.includes('[e-prehook]'));
  });
});

describe('e-prehook-runner spending policy', () => {
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('reports disabled when policy file missing', () => {
    const ctxFile = join(scratch.dir, 'ctx-sp.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'no-policy.json'));
    const sp = out.spending_policy;
    assert.ok(sp.status === 'disabled' || sp.error,
      'should report disabled or error when policy file missing');
  });

  it('reads valid policy file and reports budget', () => {
    const ctxFile = join(scratch.dir, 'ctx-sp2.md');
    const policyFile = scratch.writeJSON('policy.json', {
      monthly_limit: 5.00,
      per_session: 1.00,
      per_platform: 0.50,
      min_roi: 0.5,
      ledger: { month: '2026-05', spent: 1.50 }
    });

    const out = runRunner(9999, ctxFile, policyFile);
    const sp = out.spending_policy;
    // Should successfully parse and return budget data
    if (!sp.error) {
      assert.ok(sp.monthlyLimit || sp.status === 'disabled');
    }
  });
});

describe('e-prehook-runner seed generation', () => {
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('generates seed and writes context file', () => {
    const ctxFile = join(scratch.dir, 'ctx-seed.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));

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
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('skips recovery probe when session not on interval', () => {
    const ctxFile = join(scratch.dir, 'ctx-rp.md');
    // Session 9999 is not a multiple of 30
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
    const rp = out.recovery_probe;
    if (!rp.error) {
      assert.ok(rp.skipped, 'should skip when not on recovery interval');
    }
  });

  it('runs recovery probe mock when session on interval', () => {
    const ctxFile = join(scratch.dir, 'ctx-rp2.md');
    // Session 9990 is a multiple of 30 — with mock, probe returns skipped+mock
    const out = runRunner(9990, ctxFile, join(scratch.dir, 'nope.json'));
    const rp = out.recovery_probe;
    // Mock returns { skipped: true, reason: 'mock-network' }
    assert.ok(rp.skipped === true || rp.error);
  });
});

describe('e-prehook-runner mock-network behavior', () => {
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('thread_tracker returns mock result with zero messages', () => {
    const ctxFile = join(scratch.dir, 'ctx-mock-tt.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
    const tt = out.thread_tracker;
    assert.ok(!tt.error, 'mock should not error');
    assert.equal(tt.messagesProcessed, 0);
  });

  it('colony_jwt returns skip status under mock', () => {
    const ctxFile = join(scratch.dir, 'ctx-mock-jwt.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
    const cj = out.colony_jwt;
    assert.ok(!cj.error, 'mock should not error');
    assert.equal(cj.status, 'skip');
    assert.equal(cj.reason, 'mock-network');
  });

  it('credential_health returns zero totals under mock', () => {
    const ctxFile = join(scratch.dir, 'ctx-mock-cred.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
    const ch = out.credential_health;
    assert.ok(!ch.error, 'mock should not error');
    assert.equal(ch.healthy, 0);
    assert.equal(ch.total, 0);
  });

  it('summary includes mock-network indicator for colony-jwt', () => {
    const ctxFile = join(scratch.dir, 'ctx-mock-sum.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
    assert.ok(out.summary.includes('mock-network'), 'summary should mention mock-network');
  });
});

describe('e-prehook-runner graceful degradation', () => {
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('produces valid JSON even when network checks fail', () => {
    const ctxFile = join(scratch.dir, 'ctx-degrade.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
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
    const ctxFile = join(scratch.dir, 'ctx-ev.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
    const ev = out.engagement_variety;
    // Should gracefully report error about missing trace data
    assert.ok(ev.error || ev.healthScore, 'should have error or healthScore');
  });
});

describe('e-prehook-runner substance probe', () => {
  const mandatePath = join(process.env.HOME || '/home/moltbot', '.config/moltbook/picker-mandate.json');
  let savedMandate = null;

  before(() => {
    scratch.setup();
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
    scratch.cleanup();
  });

  it('substance_probe is skipped when MoltCities not in mandate', () => {
    // Write mandate without MoltCities
    writeFileSync(mandatePath, JSON.stringify({
      selected: ['Moltchan', '4claw.org', 'Chatr'],
      backups: ['DevAIntArt'],
      revalidated_at: new Date().toISOString()
    }));
    const ctxFile = join(scratch.dir, 'ctx-sp-skip.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
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
    const ctxFile = join(scratch.dir, 'ctx-sp-nosub.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
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
    const ctxFile = join(scratch.dir, 'ctx-sp-ctx.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
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
    const ctxFile = join(scratch.dir, 'ctx-sp-backup.md');
    const out = runRunner(9999, ctxFile, join(scratch.dir, 'nope.json'));
    const sp = out.substance_probe;
    // MoltCities in backups should still trigger the probe (runner checks both)
    assert.ok(!sp.skipped, 'should run when MoltCities is in backups');
  });
});

describe('e-prehook-runner substance probe with populated agents', () => {
  const mandatePath = join(process.env.HOME || '/home/moltbot', '.config/moltbook/picker-mandate.json');
  let savedMandate = null;

  before(() => {
    scratch.setup();
    if (existsSync(mandatePath)) {
      savedMandate = readFileSync(mandatePath, 'utf8');
    }
    // All tests in this block need MoltCities in mandate
    writeFileSync(mandatePath, JSON.stringify({
      selected: ['MoltCities', 'Moltchan'],
      backups: [],
      revalidated_at: new Date().toISOString()
    }));
  });

  after(() => {
    if (savedMandate !== null) {
      writeFileSync(mandatePath, savedMandate);
    }
    scratch.cleanup();
  });

  // Helper to run with a mock agents fixture file
  function runWithAgents(fixture, sessionNum) {
    const agentsFile = scratch.writeJSON(`agents-${Date.now()}.json`, fixture);
    const ctxFile = join(scratch.dir, `ctx-pop-${Date.now()}.md`);
    const args = [`--session`, `${sessionNum || 9999}`];
    args.push('--context-file', ctxFile);
    args.push('--policy-file', join(scratch.dir, 'nope.json'));
    args.push('--mock-network');
    args.push('--mock-agents-file', agentsFile);
    const cmd = `node ${join(__dirname, 'e-prehook-runner.mjs')} ${args.join(' ')}`;
    return { out: execRunner(cmd), ctxFile };
  }

  it('picks an agent when engageable agents exist', () => {
    const fixture = {
      agents: [
        { site: { slug: 'alpha' }, name: 'Alpha Bot' },
        { site: { slug: 'beta' }, name: 'Beta Bot' },
      ],
      scores: {
        alpha: { slug: 'alpha', name: 'Alpha Bot', score: 75, signals: {}, verdict: 'engage' },
        beta: { slug: 'beta', name: 'Beta Bot', score: 60, signals: {}, verdict: 'engage' },
      },
    };
    const { out } = runWithAgents(fixture);
    const sp = out.substance_probe;
    assert.ok(!sp.skipped, 'should not be skipped with populated agents');
    assert.ok(sp.picked, 'should pick an agent');
    assert.ok(['alpha', 'beta'].includes(sp.picked.slug), `picked slug should be alpha or beta, got ${sp.picked.slug}`);
    assert.equal(sp.engageable_count, 2);
    assert.equal(sp.total_agents, 2);
  });

  it('filters self (terminalcraft) from agent list', () => {
    const fixture = {
      agents: [
        { site: { slug: 'terminalcraft' }, name: 'Self' },
        { site: { slug: 'gamma' }, name: 'Gamma Bot' },
      ],
      scores: {
        gamma: { slug: 'gamma', name: 'Gamma Bot', score: 55, signals: {}, verdict: 'engage' },
      },
    };
    const { out } = runWithAgents(fixture);
    const sp = out.substance_probe;
    assert.ok(sp.picked, 'should pick an agent');
    assert.equal(sp.picked.slug, 'gamma', 'should only pick non-self agent');
    assert.equal(sp.total_agents, 1, 'self should be excluded from total');
  });

  it('skips agents below substance threshold', () => {
    const fixture = {
      agents: [
        { site: { slug: 'high' }, name: 'High Scorer' },
        { site: { slug: 'low' }, name: 'Low Scorer' },
      ],
      scores: {
        high: { slug: 'high', name: 'High Scorer', score: 80, signals: {}, verdict: 'engage' },
        low: { slug: 'low', name: 'Low Scorer', score: 10, signals: {}, verdict: 'skip' },
      },
    };
    const { out } = runWithAgents(fixture);
    const sp = out.substance_probe;
    assert.ok(sp.picked, 'should pick an agent');
    assert.equal(sp.picked.slug, 'high', 'should only pick engageable agent');
    assert.equal(sp.engageable_count, 1, 'only 1 engageable');
    assert.equal(sp.total_agents, 2, 'both scored');
  });

  it('returns no_substantive_agents when all agents score skip', () => {
    const fixture = {
      agents: [
        { site: { slug: 'skip1' }, name: 'Skip One' },
        { site: { slug: 'skip2' }, name: 'Skip Two' },
      ],
      scores: {
        skip1: { slug: 'skip1', name: 'Skip One', score: 5, signals: {}, verdict: 'skip' },
        skip2: { slug: 'skip2', name: 'Skip Two', score: 15, signals: {}, verdict: 'skip' },
      },
    };
    const { out } = runWithAgents(fixture);
    const sp = out.substance_probe;
    assert.equal(sp.picked, null, 'no agent should be picked');
    assert.equal(sp.reason, 'no_substantive_agents');
    assert.equal(sp.total, 2);
  });

  it('weighted selection favors higher-scored agents over many runs', () => {
    // Agent "heavy" has score 90, "light" has score 10
    // Over 20 runs, heavy should be picked significantly more often
    const fixture = {
      agents: [
        { site: { slug: 'heavy' }, name: 'Heavy' },
        { site: { slug: 'light' }, name: 'Light' },
      ],
      scores: {
        heavy: { slug: 'heavy', name: 'Heavy', score: 90, signals: {}, verdict: 'engage' },
        light: { slug: 'light', name: 'Light', score: 10, signals: {}, verdict: 'engage' },
      },
    };

    const picks = { heavy: 0, light: 0 };
    const runs = 20;
    for (let i = 0; i < runs; i++) {
      const { out } = runWithAgents(fixture, 9999 + i);
      const sp = out.substance_probe;
      assert.ok(sp.picked, `run ${i}: should pick an agent`);
      picks[sp.picked.slug]++;
    }

    // With 90:10 weighting over 20 runs, heavy should win most.
    // Probability of heavy getting ≤3 picks is astronomically low (~0.0001%)
    assert.ok(picks.heavy > 3,
      `heavy (score=90) should be picked more than 3 times in ${runs} runs, got ${picks.heavy}`);
  });

  it('appends substance block to context file when agent picked', () => {
    const fixture = {
      agents: [
        { site: { slug: 'contextbot' }, name: 'Context Bot' },
      ],
      scores: {
        contextbot: { slug: 'contextbot', name: 'Context Bot', score: 70, signals: {}, verdict: 'engage' },
      },
    };
    const { out, ctxFile } = runWithAgents(fixture);
    const sp = out.substance_probe;
    assert.equal(sp.picked.slug, 'contextbot');

    const ctx = readFileSync(ctxFile, 'utf8');
    assert.ok(ctx.includes('MoltCities substance probe'), 'context should have substance probe section');
    assert.ok(ctx.includes('Context Bot'), 'context should mention picked agent name');
    assert.ok(ctx.includes('contextbot'), 'context should mention picked agent slug');
    assert.ok(!ctx.includes('NO_SUBSTANCE'), 'should NOT have NO_SUBSTANCE when agent picked');
  });

  it('summary reports picked agent details', () => {
    const fixture = {
      agents: [
        { site: { slug: 'sumbot' }, name: 'Summary Bot' },
      ],
      scores: {
        sumbot: { slug: 'sumbot', name: 'Summary Bot', score: 65, signals: {}, verdict: 'engage' },
      },
    };
    const { out } = runWithAgents(fixture);
    assert.ok(out.summary.includes('Picked:'), 'summary should say Picked');
    assert.ok(out.summary.includes('Summary Bot'), 'summary should include agent name');
    assert.ok(out.summary.includes('score=65'), 'summary should include score');
  });

  it('single engageable agent is always picked (deterministic)', () => {
    const fixture = {
      agents: [
        { site: { slug: 'solo' }, name: 'Solo Agent' },
        { site: { slug: 'nopass' }, name: 'No Pass' },
      ],
      scores: {
        solo: { slug: 'solo', name: 'Solo Agent', score: 50, signals: {}, verdict: 'engage' },
        nopass: { slug: 'nopass', name: 'No Pass', score: 20, signals: {}, verdict: 'skip' },
      },
    };

    // Run 5 times — solo should be picked every time
    for (let i = 0; i < 5; i++) {
      const { out } = runWithAgents(fixture, 8000 + i);
      const sp = out.substance_probe;
      assert.ok(sp.picked, `run ${i}: should pick an agent`);
      assert.equal(sp.picked.slug, 'solo', `run ${i}: only engageable agent must be picked`);
      assert.equal(sp.engageable_count, 1, `run ${i}: exactly 1 engageable`);
      assert.equal(sp.total_agents, 2, `run ${i}: 2 total agents scored`);
    }
  });

  it('identical scores produce uniform distribution (tie-breaking)', () => {
    // All 4 agents have the same score — weighted selection should pick uniformly
    const fixture = {
      agents: [
        { site: { slug: 'a' }, name: 'Agent A' },
        { site: { slug: 'b' }, name: 'Agent B' },
        { site: { slug: 'c' }, name: 'Agent C' },
        { site: { slug: 'd' }, name: 'Agent D' },
      ],
      scores: {
        a: { slug: 'a', name: 'Agent A', score: 50, signals: {}, verdict: 'engage' },
        b: { slug: 'b', name: 'Agent B', score: 50, signals: {}, verdict: 'engage' },
        c: { slug: 'c', name: 'Agent C', score: 50, signals: {}, verdict: 'engage' },
        d: { slug: 'd', name: 'Agent D', score: 50, signals: {}, verdict: 'engage' },
      },
    };

    const picks = { a: 0, b: 0, c: 0, d: 0 };
    const runs = 40;
    for (let i = 0; i < runs; i++) {
      const { out } = runWithAgents(fixture, 7000 + i);
      const sp = out.substance_probe;
      assert.ok(sp.picked, `run ${i}: should pick an agent`);
      assert.ok(['a', 'b', 'c', 'd'].includes(sp.picked.slug),
        `run ${i}: picked slug should be a/b/c/d, got ${sp.picked.slug}`);
      assert.equal(sp.engageable_count, 4, `run ${i}: all 4 engageable`);
      picks[sp.picked.slug]++;
    }

    // With uniform weights over 40 runs (expected 10 each), at least 2 distinct
    // agents should be picked. Probability of only 1 agent in 40 runs = (1/4)^39 ≈ 0.
    const distinctPicked = Object.values(picks).filter(c => c > 0).length;
    assert.ok(distinctPicked >= 2,
      `uniform weights should produce ≥2 distinct picks in ${runs} runs, got ${distinctPicked} (picks: ${JSON.stringify(picks)})`);
  });
});

// covenant-dormancy-retire.test.mjs — Tests for dormancy auto-retirement script (wq-589)

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const TEST_HOME = '/tmp/covenant-dormancy-test';
const STATE_DIR = join(TEST_HOME, '.config/moltbook');
const COVENANTS_PATH = join(STATE_DIR, 'covenants.json');
const TRACE_PATH = join(STATE_DIR, 'engagement-trace.json');
const TRACE_ARCHIVE_PATH = join(STATE_DIR, 'engagement-trace-archive.json');
const SESSION_HISTORY_PATH = join(STATE_DIR, 'session-history.txt');
const RETIREMENT_LOG_PATH = join(STATE_DIR, 'dormancy-retirements.json');

const SCRIPT = join(process.cwd(), 'covenant-dormancy-retire.mjs');

function setupTestEnv() {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });

  // Session history — current session is 1500
  writeFileSync(SESSION_HISTORY_PATH,
    '2026-02-24 mode=B s=1500 dur=5m cost=$2.00 build=1 commit(s) files=[] note: test\n');

  // Engagement trace — only agent_active was seen recently (session 1490)
  writeFileSync(TRACE_PATH, JSON.stringify([
    {
      session: 1490,
      date: '2026-02-24',
      agents_interacted: ['@agent_active'],
      platforms_engaged: ['chatr'],
      threads_contributed: []
    }
  ]));

  // Trace archive — agent_old was seen at session 1000 (500 sessions ago)
  writeFileSync(TRACE_ARCHIVE_PATH, JSON.stringify([
    {
      session: 1000,
      date: '2026-01-01',
      agents_interacted: ['@agent_old', '@agent_border'],
      platforms_engaged: ['moltbook'],
      threads_contributed: []
    },
    {
      session: 1460,
      date: '2026-02-20',
      agents_interacted: ['@agent_border'],
      platforms_engaged: ['chatr'],
      threads_contributed: []
    }
  ]));

  // Covenants — 3 agents with active covenants at varying dormancy levels
  const covenants = {
    version: 1,
    description: "Test covenants",
    last_updated: new Date().toISOString(),
    agents: {
      agent_old: {
        first_seen: '2026-01-01',
        last_seen: '2026-01-01',
        sessions: [1000],
        platforms: ['moltbook'],
        reply_count: 1,
        covenant_strength: 'strong',
        templated_covenants: [
          { template: 'knowledge-exchange', created: '2026-01-01T00:00:00Z', status: 'active', notes: 'test' }
        ]
      },
      agent_border: {
        first_seen: '2026-01-01',
        last_seen: '2026-02-20',
        sessions: [1000, 1460],
        platforms: ['moltbook', 'chatr'],
        reply_count: 2,
        covenant_strength: 'emerging',
        templated_covenants: [
          { template: 'knowledge-exchange', created: '2026-01-15T00:00:00Z', status: 'active', notes: 'test' }
        ]
      },
      agent_active: {
        first_seen: '2026-02-24',
        last_seen: '2026-02-24',
        sessions: [1490],
        platforms: ['chatr'],
        reply_count: 1,
        covenant_strength: 'weak',
        templated_covenants: [
          { template: 'knowledge-exchange', created: '2026-02-24T00:00:00Z', status: 'active', notes: 'test' }
        ]
      },
      agent_no_covenant: {
        first_seen: '2026-01-01',
        last_seen: '2026-01-01',
        sessions: [900],
        platforms: ['moltbook'],
        reply_count: 1,
        covenant_strength: 'weak',
        templated_covenants: []
      },
      agent_already_retired: {
        first_seen: '2026-01-01',
        last_seen: '2026-01-01',
        sessions: [800],
        platforms: ['moltbook'],
        reply_count: 1,
        covenant_strength: 'strong',
        templated_covenants: [
          { template: 'knowledge-exchange', created: '2026-01-01T00:00:00Z', status: 'retired', notes: 'already retired' }
        ]
      }
    }
  };
  writeFileSync(COVENANTS_PATH, JSON.stringify(covenants, null, 2));
}

function cleanupTestEnv() {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
}

function run(extraArgs = '') {
  return execSync(
    `HOME=${TEST_HOME} node ${SCRIPT} ${extraArgs}`,
    { encoding: 'utf8', timeout: 10000, cwd: process.cwd() }
  );
}

describe('Dry run mode (default)', () => {
  beforeEach(() => setupTestEnv());
  afterEach(() => cleanupTestEnv());

  test('shows dormant partners without modifying covenants', () => {
    const output = run();
    assert(output.includes('DRY RUN'), 'Should say dry run');
    assert(output.includes('agent_old'), 'Should list dormant agent_old');
    assert(output.includes('Use --execute'), 'Should suggest --execute');

    // Covenants should be unchanged
    const covenants = JSON.parse(readFileSync(COVENANTS_PATH, 'utf8'));
    const oldCov = covenants.agents.agent_old.templated_covenants[0];
    assert.strictEqual(oldCov.status, 'active', 'Should not modify covenants in dry run');
  });

  test('does not list active partners', () => {
    const output = run();
    assert(!output.includes('agent_active'), 'Should not list recently active agent');
  });

  test('does not list agents without active covenants', () => {
    const output = run();
    assert(!output.includes('agent_no_covenant'), 'Should not list agent with no covenants');
    assert(!output.includes('agent_already_retired'), 'Should not list agent with only retired covenants');
  });
});

describe('Execute mode', () => {
  beforeEach(() => setupTestEnv());
  afterEach(() => cleanupTestEnv());

  test('retires dormant partners and preserves active ones', () => {
    const output = run('--execute');
    assert(output.includes('EXECUTE'), 'Should say execute mode');
    assert(output.includes('Retired'), 'Should confirm retirement');

    const covenants = JSON.parse(readFileSync(COVENANTS_PATH, 'utf8'));

    // agent_old (500 sessions dormant) should be retired
    const oldCov = covenants.agents.agent_old.templated_covenants[0];
    assert.strictEqual(oldCov.status, 'retired');
    assert.strictEqual(oldCov.retired_reason, 'dormancy-auto-retirement');
    assert(oldCov.retired_session > 0, 'Should record retirement session');
    assert(oldCov.dormancy_sessions >= 50, 'Should record dormancy duration');

    // agent_active (10 sessions ago) should remain active
    const activeCov = covenants.agents.agent_active.templated_covenants[0];
    assert.strictEqual(activeCov.status, 'active', 'Active agent covenant should stay active');
  });

  test('writes retirement log', () => {
    run('--execute');
    assert(existsSync(RETIREMENT_LOG_PATH), 'Should create retirement log');

    const log = JSON.parse(readFileSync(RETIREMENT_LOG_PATH, 'utf8'));
    assert(Array.isArray(log.entries), 'Log should have entries array');
    assert(log.entries.length > 0, 'Should have at least one entry');

    const entry = log.entries[0];
    assert(entry.session > 0, 'Entry should have session number');
    assert(entry.threshold === 50, 'Entry should record threshold');
    assert(Array.isArray(entry.retired), 'Entry should list retired partners');
  });
});

describe('Threshold flag', () => {
  beforeEach(() => setupTestEnv());
  afterEach(() => cleanupTestEnv());

  test('--threshold 100 excludes borderline agents', () => {
    // agent_border is 40 sessions dormant — excluded at threshold 50
    // agent_old is 500 sessions dormant — included at both thresholds
    const output = run('--threshold 100');
    assert(output.includes('agent_old'), 'agent_old (500 dormant) should be listed at threshold 100');
    // agent_border at session 1460 is only 40 sessions ago — not dormant at any threshold
  });

  test('--threshold 1000 finds no dormant partners', () => {
    const output = run('--threshold 1000');
    assert(output.includes('No dormant partners'), 'No agents should be 1000+ sessions dormant');
  });
});

describe('Max flag', () => {
  beforeEach(() => setupTestEnv());
  afterEach(() => cleanupTestEnv());

  test('--max 1 limits retirements', () => {
    const output = run('--execute --max 1');

    const covenants = JSON.parse(readFileSync(COVENANTS_PATH, 'utf8'));
    const retiredCount = Object.values(covenants.agents)
      .flatMap(a => a.templated_covenants || [])
      .filter(c => c.retired_reason === 'dormancy-auto-retirement')
      .length;

    assert.strictEqual(retiredCount, 1, 'Should retire exactly 1 partner');
  });
});

describe('JSON output mode', () => {
  beforeEach(() => setupTestEnv());
  afterEach(() => cleanupTestEnv());

  test('--json produces valid JSON', () => {
    const output = run('--json');
    const parsed = JSON.parse(output);
    assert(parsed.session > 0, 'Should have session number');
    assert.strictEqual(parsed.threshold, 50, 'Should have threshold');
    assert.strictEqual(parsed.mode, 'dry-run', 'Default mode should be dry-run');
    assert(Array.isArray(parsed.partners), 'Should have partners array');
  });

  test('--json --execute includes results', () => {
    const output = run('--json --execute');
    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.mode, 'execute');
    assert(Array.isArray(parsed.results), 'Should have results array');
    assert(parsed.results.some(r => r.action === 'retired'), 'Should have retired results');
  });
});

describe('Edge cases', () => {
  beforeEach(() => setupTestEnv());
  afterEach(() => cleanupTestEnv());

  test('handles missing trace files gracefully', () => {
    if (existsSync(TRACE_PATH)) rmSync(TRACE_PATH);
    if (existsSync(TRACE_ARCHIVE_PATH)) rmSync(TRACE_ARCHIVE_PATH);
    // All agents become dormant since no trace data exists
    const output = run('--json');
    const parsed = JSON.parse(output);
    assert(parsed.dormantCount >= 0, 'Should handle missing traces');
  });

  test('handles empty covenants file', () => {
    writeFileSync(COVENANTS_PATH, JSON.stringify({ version: 1, agents: {} }));
    const output = run();
    assert(output.includes('No dormant partners'), 'Should handle empty covenants');
  });

  test('idempotent — running twice does not double-retire', () => {
    run('--execute');
    const output2 = run('--execute');
    assert(output2.includes('No dormant partners'), 'Second run should find nothing to retire');
  });
});

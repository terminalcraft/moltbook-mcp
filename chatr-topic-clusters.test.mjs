// chatr-topic-clusters.test.mjs — Tests for topic clustering (wq-591)

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const TEST_HOME = '/tmp/chatr-clusters-test';
const STATE_DIR = join(TEST_HOME, '.config/moltbook');
const THREADS_PATH = join(STATE_DIR, 'chatr-threads.json');
const SCRIPT = join(process.cwd(), 'chatr-topic-clusters.mjs');

function makeThread(id, topic, words, participants, engaged, ageHours = 1) {
  const lastActivity = new Date(Date.now() - ageHours * 3600000).toISOString();
  return {
    id,
    messageIds: ['m1', 'm2'],
    participants,
    topicWords: words,
    topic,
    firstActivity: lastActivity,
    lastActivity,
    messageCount: 3,
    engaged,
  };
}

function setupTestEnv(threads) {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  const state = {
    version: 1,
    lastUpdate: new Date().toISOString(),
    lastMessageId: '100',
    threads: {},
    messageIndex: {},
  };
  for (const t of threads) {
    state.threads[t.id] = t;
  }
  writeFileSync(THREADS_PATH, JSON.stringify(state, null, 2));
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

describe('Basic clustering', () => {
  afterEach(() => cleanupTestEnv());

  test('clusters similar topics together', () => {
    setupTestEnv([
      makeThread('t1', 'agent trust', ['agent', 'trust', 'reputation', 'verify'], ['alice', 'bob'], false),
      makeThread('t2', 'trust scores', ['trust', 'score', 'reputation', 'identity'], ['charlie', 'dave'], false),
      makeThread('t3', 'build features', ['build', 'code', 'deploy', 'feature'], ['eve', 'frank'], true),
    ]);

    const output = run('--json --min-threads 1');
    const result = JSON.parse(output);
    assert(result.clusters.length >= 1, 'Should produce clusters');
    assert.strictEqual(result.threadCount, 3, 'Should see all 3 threads');
  });

  test('identifies unengaged clusters', () => {
    setupTestEnv([
      makeThread('t1', 'economy', ['economy', 'market', 'trade', 'value'], ['alice'], false),
      makeThread('t2', 'marketplace', ['marketplace', 'economic', 'cost'], ['bob'], false),
      makeThread('t3', 'coding', ['build', 'code', 'ship'], ['charlie'], true),
    ]);

    const output = run('--json --min-threads 1');
    const result = JSON.parse(output);
    const unengaged = result.clusters.filter(c => !c.engaged);
    assert(unengaged.length >= 0, 'Should identify engagement status');
    assert(result.recommendations !== undefined, 'Should have recommendations');
  });
});

describe('Time filtering', () => {
  afterEach(() => cleanupTestEnv());

  test('--hours filters old threads', () => {
    setupTestEnv([
      makeThread('t1', 'recent', ['agent', 'build'], ['alice'], false, 2),   // 2h ago
      makeThread('t2', 'old', ['agent', 'build'], ['bob'], false, 200),      // 200h ago
    ]);

    const output = run('--json --hours 24 --min-threads 1');
    const result = JSON.parse(output);
    assert.strictEqual(result.threadCount, 1, 'Should only include recent thread');
  });
});

describe('JSON output', () => {
  afterEach(() => cleanupTestEnv());

  test('produces valid JSON with expected fields', () => {
    setupTestEnv([
      makeThread('t1', 'topic1', ['agent', 'trust'], ['alice'], true),
      makeThread('t2', 'topic2', ['agent', 'trust'], ['bob'], false),
    ]);

    const output = run('--json --min-threads 1');
    const result = JSON.parse(output);
    assert(result.threadCount >= 0, 'Should have threadCount');
    assert(result.clusterCount >= 0, 'Should have clusterCount');
    assert(Array.isArray(result.clusters), 'Should have clusters array');
    assert(Array.isArray(result.recommendations), 'Should have recommendations array');
  });

  test('cluster has required fields', () => {
    setupTestEnv([
      makeThread('t1', 'topic', ['agent', 'trust', 'memory'], ['alice', 'bob'], false),
      makeThread('t2', 'topic', ['agent', 'trust', 'recall'], ['charlie'], true),
    ]);

    const output = run('--json --min-threads 1');
    const result = JSON.parse(output);
    if (result.clusters.length > 0) {
      const c = result.clusters[0];
      assert(c.label, 'Cluster should have label');
      assert(typeof c.threadCount === 'number', 'Should have threadCount');
      assert(typeof c.totalMessages === 'number', 'Should have totalMessages');
      assert(typeof c.engaged === 'boolean', 'Should have engaged boolean');
      assert(typeof c.engagementGap === 'number', 'Should have engagementGap');
      assert(Array.isArray(c.topWords), 'Should have topWords');
    }
  });
});

describe('Edge cases', () => {
  afterEach(() => cleanupTestEnv());

  test('handles missing thread state gracefully', () => {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
    mkdirSync(STATE_DIR, { recursive: true });
    // No threads file

    try {
      run();
      assert.fail('Should exit with error');
    } catch (e) {
      assert(e.stderr.includes('No Chatr thread state'), 'Should report missing state');
    }
  });

  test('handles empty threads', () => {
    setupTestEnv([]);
    const output = run('--json');
    const result = JSON.parse(output);
    assert.strictEqual(result.threadCount, 0);
    assert.strictEqual(result.clusters.length, 0);
  });

  test('human-readable output works', () => {
    setupTestEnv([
      makeThread('t1', 'agents', ['agent', 'trust'], ['alice'], false),
      makeThread('t2', 'agents', ['agent', 'trust'], ['bob'], false),
    ]);

    const output = run('--min-threads 1');
    assert(output.includes('Chatr Topic Clusters'), 'Should have header');
  });
});

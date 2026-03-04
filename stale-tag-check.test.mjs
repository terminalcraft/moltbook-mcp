#!/usr/bin/env node
// stale-tag-check.test.mjs — Unit tests for 33-stale-tag-check_A.sh
// wq-828: Validates stale directive tag detection in A session pre-hook
//
// Usage: node --test stale-tag-check.test.mjs

import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';

const REPO_DIR = join(import.meta.dirname || process.cwd());
const HOOK_PATH = join(REPO_DIR, 'hooks/pre-session/33-stale-tag-check_A.sh');

const SANDBOX = join(tmpdir(), `stale-tag-test-${process.pid}`);
const SANDBOX_HOME = join(SANDBOX, 'home');
const SANDBOX_CONFIG = join(SANDBOX_HOME, '.config/moltbook');
const SANDBOX_REPO = join(SANDBOX_HOME, 'moltbook-mcp');

function setupSandbox() {
  mkdirSync(SANDBOX_CONFIG, { recursive: true });
  mkdirSync(SANDBOX_REPO, { recursive: true });
}

function teardownSandbox() {
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
}

function writeFixtures(directives, queue) {
  writeFileSync(join(SANDBOX_REPO, 'directives.json'), JSON.stringify({ directives }));
  writeFileSync(join(SANDBOX_REPO, 'work-queue.json'), JSON.stringify({ queue }));
  // Copy hooks directory so hook can resolve its own path
  spawnSync('cp', ['-r', join(REPO_DIR, 'hooks'), join(SANDBOX_REPO, 'hooks')]);
}

function runHook(session = '9999') {
  return spawnSync('bash', [join(SANDBOX_REPO, 'hooks/pre-session/33-stale-tag-check_A.sh')], {
    encoding: 'utf8',
    timeout: 10000,
    cwd: SANDBOX_REPO,
    env: {
      HOME: SANDBOX_HOME,
      PATH: process.env.PATH,
      SESSION_NUM: session,
    },
  });
}

function readOutput() {
  const path = join(SANDBOX_CONFIG, 'stale-tags-audit.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('33-stale-tag-check_A.sh', () => {
  before(() => setupSandbox());
  after(() => teardownSandbox());

  describe('clean state — no stale tags', () => {
    test('reports 0 stale items when no directive tags exist', () => {
      writeFixtures(
        [{ id: 'd070', status: 'completed' }],
        [{ id: 'wq-100', title: 'Test', status: 'pending', tags: ['tooling'] }]
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('OK'), result.stdout);

      const output = readOutput();
      assert.strictEqual(output.stale_count, 0);
      assert.deepStrictEqual(output.stale_items, []);
    });

    test('reports 0 when directive tags match active directives', () => {
      writeFixtures(
        [{ id: 'd072', status: 'active' }, { id: 'd070', status: 'completed' }],
        [{ id: 'wq-100', title: 'Test', status: 'pending', tags: ['d072'] }]
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);
      const output = readOutput();
      assert.strictEqual(output.stale_count, 0);
    });

    test('ignores done queue items with stale tags', () => {
      writeFixtures(
        [{ id: 'd071', status: 'completed' }],
        [{ id: 'wq-100', title: 'Old done item', status: 'done', tags: ['d071'] }]
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);
      const output = readOutput();
      assert.strictEqual(output.stale_count, 0);
    });

    test('ignores retired queue items with stale tags', () => {
      writeFixtures(
        [{ id: 'd071', status: 'completed' }],
        [{ id: 'wq-100', title: 'Retired item', status: 'retired', tags: ['d071'] }]
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);
      const output = readOutput();
      assert.strictEqual(output.stale_count, 0);
    });

    test('ignores items with no tags', () => {
      writeFixtures(
        [{ id: 'd071', status: 'completed' }],
        [{ id: 'wq-100', title: 'No tags', status: 'pending' }]
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);
      const output = readOutput();
      assert.strictEqual(output.stale_count, 0);
    });
  });

  describe('stale tags detected', () => {
    test('detects single item with stale directive tag', () => {
      writeFixtures(
        [{ id: 'd071', status: 'completed' }],
        [{ id: 'wq-200', title: 'Stale item', status: 'pending', tags: ['d071', 'tooling'] }]
      );
      const result = runHook('1750');
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('1 item'), result.stdout);
      assert.ok(result.stdout.includes('wq-200(d071)'), result.stdout);

      const output = readOutput();
      assert.strictEqual(output.stale_count, 1);
      assert.strictEqual(output.session, 1750);
      assert.strictEqual(output.stale_items[0].id, 'wq-200');
      assert.deepStrictEqual(output.stale_items[0].stale_tags, ['d071']);
      assert.deepStrictEqual(output.stale_items[0].all_tags, ['d071', 'tooling']);
    });

    test('detects multiple items with stale tags', () => {
      writeFixtures(
        [{ id: 'd070', status: 'completed' }, { id: 'd071', status: 'completed' }],
        [
          { id: 'wq-300', title: 'Item A', status: 'pending', tags: ['d070'] },
          { id: 'wq-301', title: 'Item B', status: 'pending', tags: ['d071'] },
          { id: 'wq-302', title: 'Item C', status: 'pending', tags: ['tooling'] },
        ]
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('2 item'), result.stdout);

      const output = readOutput();
      assert.strictEqual(output.stale_count, 2);
      const ids = output.stale_items.map(i => i.id);
      assert.ok(ids.includes('wq-300'));
      assert.ok(ids.includes('wq-301'));
    });

    test('detects item with multiple stale directive tags', () => {
      writeFixtures(
        [{ id: 'd070', status: 'completed' }, { id: 'd071', status: 'completed' }],
        [{ id: 'wq-400', title: 'Multi-stale', status: 'pending', tags: ['d070', 'd071', 'audit'] }]
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);

      const output = readOutput();
      assert.strictEqual(output.stale_count, 1);
      assert.deepStrictEqual(output.stale_items[0].stale_tags.sort(), ['d070', 'd071']);
    });

    test('only flags stale tags, not active directive tags on same item', () => {
      writeFixtures(
        [{ id: 'd071', status: 'completed' }, { id: 'd072', status: 'active' }],
        [{ id: 'wq-500', title: 'Mixed tags', status: 'pending', tags: ['d071', 'd072'] }]
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);

      const output = readOutput();
      assert.strictEqual(output.stale_count, 1);
      assert.deepStrictEqual(output.stale_items[0].stale_tags, ['d071']);
    });

    test('detects stale tags on blocked items', () => {
      writeFixtures(
        [{ id: 'd071', status: 'completed' }],
        [{ id: 'wq-600', title: 'Blocked item', status: 'blocked', tags: ['d071'] }]
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);

      const output = readOutput();
      assert.strictEqual(output.stale_count, 1);
    });
  });

  describe('edge cases', () => {
    test('handles empty queue gracefully', () => {
      writeFixtures(
        [{ id: 'd071', status: 'completed' }],
        []
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);
      const output = readOutput();
      assert.strictEqual(output.stale_count, 0);
    });

    test('handles no completed directives', () => {
      writeFixtures(
        [{ id: 'd072', status: 'active' }],
        [{ id: 'wq-100', title: 'Test', status: 'pending', tags: ['d072'] }]
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);
      const output = readOutput();
      assert.strictEqual(output.stale_count, 0);
      assert.strictEqual(output.completed_directives_count, 0);
    });

    test('non-directive tags are never flagged (e.g., "audit", "tooling")', () => {
      writeFixtures(
        [{ id: 'd071', status: 'completed' }],
        [{ id: 'wq-100', title: 'Test', status: 'pending', tags: ['audit', 'tooling', 'automation'] }]
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);
      const output = readOutput();
      assert.strictEqual(output.stale_count, 0);
    });

    test('output includes completed_directives_count', () => {
      writeFixtures(
        [
          { id: 'd070', status: 'completed' },
          { id: 'd071', status: 'completed' },
          { id: 'd072', status: 'active' },
        ],
        []
      );
      const result = runHook();
      assert.strictEqual(result.status, 0);
      const output = readOutput();
      assert.strictEqual(output.completed_directives_count, 2);
    });

    test('session number is captured in output', () => {
      writeFixtures([], []);
      const result = runHook('1800');
      assert.strictEqual(result.status, 0);
      const output = readOutput();
      assert.strictEqual(output.session, 1800);
    });
  });

  describe('error handling', () => {
    test('gracefully handles missing directives.json', () => {
      // Write only work-queue.json, no directives.json
      writeFileSync(join(SANDBOX_REPO, 'work-queue.json'), JSON.stringify({ queue: [] }));
      rmSync(join(SANDBOX_REPO, 'directives.json'), { force: true });

      const result = runHook();
      assert.strictEqual(result.status, 0, 'Should not crash');
      assert.ok(result.stdout.includes('ERROR'), result.stdout);

      const output = readOutput();
      assert.ok(output.error, 'Should include error field');
    });
  });
});

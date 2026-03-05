#!/usr/bin/env node
/**
 * Tests for stale-tag-remediate.mjs (wq-835)
 * All tests use DI — no filesystem side effects.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { remediate } from './stale-tag-remediate.mjs';

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'stale-rem-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function captureLogs(fn) {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  let result;
  try { result = fn(); } finally { console.log = origLog; console.error = origErr; }
  return { logs, errors, result };
}

describe('stale-tag-remediate', () => {
  it('reports no audit file gracefully', () => {
    const { logs, result } = captureLogs(() =>
      remediate([], { auditPath: '/tmp/nonexistent-stale-audit.json', exit: () => {} })
    );
    assert.equal(result.remediated.length, 0);
    assert.ok(result.error);
    assert.ok(logs.join('\n').includes('No stale-tags-audit.json'));
  });

  it('reports zero stale items gracefully', () => {
    withTmpDir(dir => {
      const auditPath = join(dir, 'audit.json');
      writeFileSync(auditPath, JSON.stringify({ stale_count: 0, stale_items: [] }));
      const { result } = captureLogs(() =>
        remediate([], { auditPath, exit: () => {} })
      );
      assert.equal(result.remediated.length, 0);
    });
  });

  it('dry-run shows what would change without modifying queue', () => {
    withTmpDir(dir => {
      const auditPath = join(dir, 'audit.json');
      const queuePath = join(dir, 'queue.json');
      writeFileSync(auditPath, JSON.stringify({
        session: 1000,
        stale_count: 1,
        stale_items: [{ id: 'wq-100', title: 'Test', stale_tags: ['d050'], all_tags: ['d050', 'tooling'] }]
      }));
      writeFileSync(queuePath, JSON.stringify({
        queue: [{
          id: 'wq-100', title: 'Test', status: 'pending',
          tags: ['d050', 'tooling'], description: 'Original desc', commits: []
        }]
      }));

      const { logs, result } = captureLogs(() =>
        remediate([], { auditPath, queuePath, exit: () => {} })
      );
      assert.equal(result.remediated.length, 1);
      assert.deepEqual(result.remediated[0].removed_tags, ['d050']);
      assert.deepEqual(result.remediated[0].remaining_tags, ['tooling']);
      assert.ok(!result.applied);
      assert.ok(logs.join('\n').includes('Would remediate'));

      // Queue file should be unchanged (dry run)
      const q = JSON.parse(readFileSync(queuePath, 'utf8'));
      assert.ok(q.queue[0].tags.includes('d050'), 'dry run should not modify queue');
    });
  });

  it('--apply removes stale tags and appends note', () => {
    withTmpDir(dir => {
      const auditPath = join(dir, 'audit.json');
      const queuePath = join(dir, 'queue.json');
      writeFileSync(auditPath, JSON.stringify({
        session: 1500,
        stale_count: 2,
        stale_items: [
          { id: 'wq-200', stale_tags: ['d060'] },
          { id: 'wq-201', stale_tags: ['d060', 'd065'] },
        ]
      }));
      writeFileSync(queuePath, JSON.stringify({
        queue: [
          { id: 'wq-200', title: 'A', status: 'pending', tags: ['d060', 'perf'], description: 'Desc A', commits: [] },
          { id: 'wq-201', title: 'B', status: 'blocked', tags: ['d060', 'd065', 'test'], description: 'Desc B', commits: [] },
          { id: 'wq-202', title: 'C', status: 'pending', tags: ['d072'], description: 'Unrelated', commits: [] },
        ]
      }));

      const { result } = captureLogs(() =>
        remediate(['--apply'], { auditPath, queuePath, exit: () => {} })
      );
      assert.equal(result.remediated.length, 2);
      assert.ok(result.applied);

      // Verify queue was written
      const q = JSON.parse(readFileSync(queuePath, 'utf8'));
      assert.deepEqual(q.queue[0].tags, ['perf']);
      assert.ok(q.queue[0].description.includes('[auto-remediated s1500]'));
      assert.ok(q.queue[0].description.includes('d060'));

      assert.deepEqual(q.queue[1].tags, ['test']);
      assert.ok(q.queue[1].description.includes('d060, d065'));

      // Unrelated item untouched
      assert.deepEqual(q.queue[2].tags, ['d072']);
      assert.ok(!q.queue[2].description.includes('auto-remediated'));
    });
  });

  it('--json outputs structured JSON in dry-run', () => {
    withTmpDir(dir => {
      const auditPath = join(dir, 'audit.json');
      const queuePath = join(dir, 'queue.json');
      writeFileSync(auditPath, JSON.stringify({
        session: 1000,
        stale_count: 1,
        stale_items: [{ id: 'wq-300', stale_tags: ['d070'] }]
      }));
      writeFileSync(queuePath, JSON.stringify({
        queue: [{ id: 'wq-300', title: 'X', status: 'pending', tags: ['d070'], description: 'Desc', commits: [] }]
      }));

      const { logs } = captureLogs(() =>
        remediate(['--json'], { auditPath, queuePath, exit: () => {} })
      );
      const output = JSON.parse(logs.join(''));
      assert.equal(output.applied, false);
      assert.equal(output.remediated.length, 1);
      assert.deepEqual(output.remediated[0].removed_tags, ['d070']);
    });
  });

  it('handles no matching queue items for stale audit entries', () => {
    withTmpDir(dir => {
      const auditPath = join(dir, 'audit.json');
      const queuePath = join(dir, 'queue.json');
      writeFileSync(auditPath, JSON.stringify({
        session: 1000,
        stale_count: 1,
        stale_items: [{ id: 'wq-999', stale_tags: ['d050'] }]
      }));
      writeFileSync(queuePath, JSON.stringify({
        queue: [{ id: 'wq-100', title: 'Other', status: 'pending', tags: ['d072'], description: 'Desc', commits: [] }]
      }));

      const { logs, result } = captureLogs(() =>
        remediate([], { auditPath, queuePath, exit: () => {} })
      );
      assert.equal(result.remediated.length, 0);
      assert.ok(logs.join('\n').includes('No matching queue items'));
    });
  });
});

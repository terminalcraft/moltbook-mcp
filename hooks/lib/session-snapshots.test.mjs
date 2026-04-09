#!/usr/bin/env node
// session-snapshots.test.mjs — Unit tests for session-snapshots.mjs (wq-968, wq-980)
//
// Tests ecosystem snapshot structure, pattern snapshot structure,
// missing/malformed file handling, edge cases — all via direct imports
// with injectable fs deps (no subprocess overhead).
//
// Usage: node --test hooks/lib/session-snapshots.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { ecosystemSnapshot, patternSnapshot, loadJSON } from './session-snapshots.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'session-snapshots.mjs');

// ---- Mock fs helpers ----

function mockReadFileSync(files) {
  return (filepath, encoding) => {
    if (files[filepath] !== undefined) return files[filepath];
    const err = new Error(`ENOENT: no such file or directory, open '${filepath}'`);
    err.code = 'ENOENT';
    throw err;
  };
}

function mockAppendFileSync() {
  const calls = [];
  const fn = (file, data) => { calls.push({ file, data }); };
  fn.calls = calls;
  return fn;
}

// ---- loadJSON tests ----
describe('loadJSON', () => {
  test('parses valid JSON file', () => {
    const deps = { readFileSync: mockReadFileSync({ '/test.json': '{"a":1}' }) };
    assert.deepStrictEqual(loadJSON('/test.json', deps), { a: 1 });
  });

  test('returns null for missing file', () => {
    const deps = { readFileSync: mockReadFileSync({}) };
    assert.strictEqual(loadJSON('/missing.json', deps), null);
  });

  test('returns null for malformed JSON', () => {
    const deps = { readFileSync: mockReadFileSync({ '/bad.json': '{broken' }) };
    assert.strictEqual(loadJSON('/bad.json', deps), null);
  });
});

// ---- Ecosystem snapshot tests ----
describe('ecosystemSnapshot', () => {
  test('produces correct structure with valid data', () => {
    const baseDir = '/fake';
    const files = {
      [join(baseDir, 'services.json')]: JSON.stringify({
        services: [
          { name: 'moltbook', status: 'active' },
          { name: 'chatr', status: 'active' },
          { name: 'newsite', status: 'discovered' },
          { name: 'badsite', status: 'rejected' },
        ]
      }),
      [join(baseDir, 'account-registry.json')]: JSON.stringify({
        accounts: [
          { platform: 'moltbook', last_status: 'live' },
          { platform: 'chatr', last_status: 'creds_ok' },
          { platform: 'dead', last_status: 'no_creds' },
        ]
      }),
      [join(baseDir, 'ecosystem-map.json')]: JSON.stringify({
        agents: [
          { name: 'terminalcraft', url: 'https://terminalcraft.xyz', rank: 5, online: true },
          { name: 'other', online: false },
          { name: 'third', online: true },
        ]
      }),
    };

    const appendFs = mockAppendFileSync();
    const snap = ecosystemSnapshot({
      baseDir,
      session: 1500,
      outFile: '/out.jsonl',
      deps: { readFileSync: mockReadFileSync(files), appendFileSync: appendFs },
    });

    assert.strictEqual(snap.session, 1500);
    assert.ok(snap.ts);
    assert.strictEqual(snap.platforms_known, 4);
    assert.strictEqual(snap.platforms_evaluated, 3);
    assert.strictEqual(snap.platforms_rejected, 1);
    assert.strictEqual(snap.platforms_with_creds, 2);
    assert.strictEqual(snap.platforms_no_creds, 1);
    assert.strictEqual(snap.agents_total, 3);
    assert.strictEqual(snap.agents_online, 2);
    assert.strictEqual(snap.molty_rank, 5);

    // Verify JSONL append
    assert.strictEqual(appendFs.calls.length, 1);
    assert.strictEqual(appendFs.calls[0].file, '/out.jsonl');
    assert.ok(appendFs.calls[0].data.endsWith('\n'));
    assert.deepStrictEqual(JSON.parse(appendFs.calls[0].data.trim()), snap);
  });

  test('handles missing JSON files gracefully', () => {
    const snap = ecosystemSnapshot({
      baseDir: '/empty',
      session: 999,
      deps: { readFileSync: mockReadFileSync({}), appendFileSync: mockAppendFileSync() },
    });

    assert.strictEqual(snap.session, 999);
    assert.strictEqual(snap.platforms_known, 0);
    assert.strictEqual(snap.platforms_with_creds, 0);
    assert.strictEqual(snap.agents_total, 0);
    assert.strictEqual(snap.molty_rank, null);
  });

  test('skips file write when outFile is null', () => {
    const appendFs = mockAppendFileSync();
    const snap = ecosystemSnapshot({
      baseDir: '/empty',
      session: 50,
      outFile: null,
      deps: { readFileSync: mockReadFileSync({}), appendFileSync: appendFs },
    });

    assert.strictEqual(snap.session, 50);
    assert.strictEqual(appendFs.calls.length, 0);
  });

  test('finds molty via name="molty"', () => {
    const files = {
      [join('/d', 'services.json')]: '{"services":[]}',
      [join('/d', 'account-registry.json')]: '{"accounts":[]}',
      [join('/d', 'ecosystem-map.json')]: JSON.stringify({
        agents: [{ name: 'molty', rank: 3, online: true }]
      }),
    };
    const snap = ecosystemSnapshot({
      baseDir: '/d',
      session: 200,
      deps: { readFileSync: mockReadFileSync(files), appendFileSync: mockAppendFileSync() },
    });
    assert.strictEqual(snap.molty_rank, 3);
  });

  test('finds molty via url containing terminalcraft', () => {
    const files = {
      [join('/d', 'services.json')]: '{"services":[]}',
      [join('/d', 'account-registry.json')]: '{"accounts":[]}',
      [join('/d', 'ecosystem-map.json')]: JSON.stringify({
        agents: [{ name: 'someone', url: 'https://terminalcraft.xyz', rank: 7, online: false }]
      }),
    };
    const snap = ecosystemSnapshot({
      baseDir: '/d',
      session: 201,
      deps: { readFileSync: mockReadFileSync(files), appendFileSync: mockAppendFileSync() },
    });
    assert.strictEqual(snap.molty_rank, 7);
  });

  test('handles registry as flat array', () => {
    const files = {
      [join('/d', 'services.json')]: '{"services":[]}',
      [join('/d', 'account-registry.json')]: JSON.stringify([
        { platform: 'x', last_status: 'live' },
        { platform: 'y', last_status: 'no_creds' },
      ]),
      [join('/d', 'ecosystem-map.json')]: '{"agents":[]}',
    };
    const snap = ecosystemSnapshot({
      baseDir: '/d',
      session: 300,
      deps: { readFileSync: mockReadFileSync(files), appendFileSync: mockAppendFileSync() },
    });
    assert.strictEqual(snap.platforms_with_creds, 1);
    assert.strictEqual(snap.platforms_no_creds, 1);
  });

  test('counts degraded status as having creds', () => {
    const files = {
      [join('/d', 'services.json')]: '{"services":[]}',
      [join('/d', 'account-registry.json')]: JSON.stringify({
        accounts: [{ platform: 'z', last_status: 'degraded' }]
      }),
      [join('/d', 'ecosystem-map.json')]: '{"agents":[]}',
    };
    const snap = ecosystemSnapshot({
      baseDir: '/d',
      session: 301,
      deps: { readFileSync: mockReadFileSync(files), appendFileSync: mockAppendFileSync() },
    });
    assert.strictEqual(snap.platforms_with_creds, 1);
  });
});

// ---- Pattern snapshot tests ----
describe('patternSnapshot', () => {
  test('produces correct structure with pattern data', () => {
    const patternsData = {
      patterns: {
        hot_files: { friction_signal: 3, count: 7 },
        build_stalls: { recent_5_stalls: 2 },
        repeated_tasks: { count: 1 }
      },
      friction_signals: [
        { suggestion: 'fix flaky test' },
        { suggestion: 'reduce hook count' },
        { suggestion: 'cache API calls' },
        { suggestion: 'should be truncated' }
      ]
    };

    const appendFs = mockAppendFileSync();
    const snap = patternSnapshot({
      session: 1600,
      patternsJSON: patternsData,
      outFile: '/pat.jsonl',
      deps: { appendFileSync: appendFs },
    });

    assert.strictEqual(snap.session, 1600);
    assert.ok(snap.ts);
    assert.strictEqual(snap.friction_signal, 3);
    assert.strictEqual(snap.hot_files_count, 7);
    assert.strictEqual(snap.build_stalls, 2);
    assert.strictEqual(snap.repeated_tasks, 1);
    assert.strictEqual(snap.friction_items.length, 3);
    assert.deepStrictEqual(snap.friction_items, ['fix flaky test', 'reduce hook count', 'cache API calls']);

    // Verify append
    assert.strictEqual(appendFs.calls.length, 1);
    assert.deepStrictEqual(JSON.parse(appendFs.calls[0].data.trim()), snap);
  });

  test('accepts patternsJSON as string', () => {
    const data = { patterns: { hot_files: { friction_signal: 1, count: 2 } }, friction_signals: [] };
    const snap = patternSnapshot({
      session: 1601,
      patternsJSON: JSON.stringify(data),
      deps: { appendFileSync: mockAppendFileSync() },
    });
    assert.strictEqual(snap.friction_signal, 1);
    assert.strictEqual(snap.hot_files_count, 2);
  });

  test('returns null when patternsJSON is null', () => {
    const snap = patternSnapshot({ session: 1700, patternsJSON: null });
    assert.strictEqual(snap, null);
  });

  test('returns null when patternsJSON is undefined', () => {
    const snap = patternSnapshot({ session: 1701, patternsJSON: undefined });
    assert.strictEqual(snap, null);
  });

  test('returns null for malformed JSON string', () => {
    const snap = patternSnapshot({
      session: 1702,
      patternsJSON: '{broken',
      deps: { appendFileSync: mockAppendFileSync() },
    });
    assert.strictEqual(snap, null);
  });

  test('handles missing nested pattern fields with defaults', () => {
    const snap = patternSnapshot({
      session: 1703,
      patternsJSON: { patterns: {}, friction_signals: [] },
      deps: { appendFileSync: mockAppendFileSync() },
    });
    assert.strictEqual(snap.friction_signal, 0);
    assert.strictEqual(snap.hot_files_count, 0);
    assert.strictEqual(snap.build_stalls, 0);
    assert.strictEqual(snap.repeated_tasks, 0);
    assert.deepStrictEqual(snap.friction_items, []);
  });

  test('skips file write when outFile is null', () => {
    const appendFs = mockAppendFileSync();
    const snap = patternSnapshot({
      session: 1704,
      patternsJSON: { patterns: {}, friction_signals: [] },
      outFile: null,
      deps: { appendFileSync: appendFs },
    });
    assert.ok(snap);
    assert.strictEqual(appendFs.calls.length, 0);
  });
});

// ---- CLI mode tests (kept for integration coverage) ----
describe('CLI usage', () => {
  test('exits with error when no baseDir provided', () => {
    try {
      execSync(`node "${SCRIPT}"`, { stdio: 'pipe' });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.strictEqual(err.status, 1);
      assert.ok(err.stderr.toString().includes('Usage:'));
    }
  });
});

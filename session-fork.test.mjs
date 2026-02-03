#!/usr/bin/env node
// session-fork.test.mjs — Tests for session forking functionality
// Run with: node --test session-fork.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const MCP_DIR = process.cwd();
const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const FORK_DIR = join(STATE_DIR, 'forks');

// Helper to run session-fork.mjs
function fork(args) {
  try {
    return execSync(`node session-fork.mjs ${args}`, {
      encoding: 'utf8',
      cwd: MCP_DIR,
      env: { ...process.env, SESSION_NUM: '999' }
    });
  } catch (e) {
    return e.stdout + e.stderr;
  }
}

// Clean up test snapshots
function cleanup() {
  const testDirs = ['test-snapshot-1', 'test-snapshot-2', 'test-cleanup-old'];
  for (const name of testDirs) {
    const dir = join(FORK_DIR, name);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
  }
}

describe('session-fork.mjs', () => {
  before(() => cleanup());
  after(() => cleanup());

  test('shows help when invoked without arguments', () => {
    const output = fork('');
    assert.match(output, /snapshot <name>/);
    assert.match(output, /restore <name>/);
    assert.match(output, /commit <name>/);
  });

  test('list shows no snapshots initially', () => {
    const output = fork('list');
    // May have existing snapshots from real usage, just check format
    assert.ok(output.includes('No snapshots found') || output.includes('Available snapshots'));
  });

  test('snapshot creates a new snapshot', () => {
    const output = fork('snapshot test-snapshot-1');
    assert.match(output, /Snapshot 'test-snapshot-1' created/);
    assert.ok(existsSync(join(FORK_DIR, 'test-snapshot-1', 'meta.json')));
    assert.ok(existsSync(join(FORK_DIR, 'test-snapshot-1', 'mcp')));
    assert.ok(existsSync(join(FORK_DIR, 'test-snapshot-1', 'state')));
  });

  test('snapshot fails for duplicate name', () => {
    const output = fork('snapshot test-snapshot-1');
    assert.match(output, /already exists/);
  });

  test('snapshot fails for invalid names', () => {
    let output = fork('snapshot ../escape');
    assert.match(output, /Invalid snapshot name/);

    output = fork('snapshot path/with/slash');
    assert.match(output, /Invalid snapshot name/);
  });

  test('list shows created snapshot', () => {
    const output = fork('list');
    assert.match(output, /test-snapshot-1/);
    assert.match(output, /s999/); // session number from env
  });

  test('status shows snapshot exists', () => {
    const output = fork('status');
    assert.match(output, /test-snapshot-1/);
  });

  test('restore reverts files', () => {
    // Make a change to BRAINSTORMING.md
    const bsPath = join(MCP_DIR, 'BRAINSTORMING.md');
    const original = readFileSync(bsPath, 'utf8');
    const marker = '\n# TEST MARKER FOR FORK TEST ' + Date.now() + '\n';
    writeFileSync(bsPath, original + marker);

    // Verify change
    assert.ok(readFileSync(bsPath, 'utf8').includes('TEST MARKER FOR FORK TEST'));

    // Restore
    const output = fork('restore test-snapshot-1');
    assert.match(output, /Restored 'test-snapshot-1'/);

    // Verify marker is gone
    const restored = readFileSync(bsPath, 'utf8');
    assert.ok(!restored.includes('TEST MARKER FOR FORK TEST'));
  });

  test('restore fails for non-existent snapshot', () => {
    const output = fork('restore non-existent-snapshot');
    assert.match(output, /not found/);
  });

  test('commit deletes snapshot', () => {
    const output = fork('commit test-snapshot-1');
    assert.match(output, /deleted/);
    assert.ok(!existsSync(join(FORK_DIR, 'test-snapshot-1')));
  });

  test('commit fails for non-existent snapshot', () => {
    const output = fork('commit non-existent-snapshot');
    assert.match(output, /not found/);
  });

  test('cleanup removes old snapshots', () => {
    // Create a snapshot with old timestamp
    const name = 'test-cleanup-old';
    fork(`snapshot ${name}`);

    // Backdate the meta.json
    const metaPath = join(FORK_DIR, name, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.created = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    // Cleanup with 3 day threshold
    const output = fork('cleanup 3');
    assert.match(output, /Removed stale snapshot.*test-cleanup-old/);
    assert.ok(!existsSync(join(FORK_DIR, name)));
  });

  test('snapshot metadata includes session number', () => {
    fork('snapshot test-snapshot-2');
    const meta = JSON.parse(readFileSync(join(FORK_DIR, 'test-snapshot-2', 'meta.json'), 'utf8'));
    assert.equal(meta.session, 999);
    assert.ok(meta.created);
    assert.ok(meta.files > 0);

    // Cleanup
    fork('commit test-snapshot-2');
  });
});

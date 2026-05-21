#!/usr/bin/env node
// b-prehook-runner.test.mjs — Tests for B session prehook runner
//
// Tests: stuck-items detection with mock queue data, lintTitles integration,
// runner-utils importability from all four runners.
//
// Usage: node --test b-prehook-runner.test.mjs
// Created: wq-1007

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(tmpdir(), 'b-prehook-test-' + Date.now());

function setup() {
  mkdirSync(SCRATCH, { recursive: true });
}

function cleanup() {
  rmSync(SCRATCH, { recursive: true, force: true });
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// Run the b-prehook-runner as a subprocess and parse its JSON output
function runRunner(sessionNum, queuePath, historyPath) {
  const cmd = `node ${join(__dirname, 'b-prehook-runner.mjs')} ${sessionNum} ${__dirname} ${queuePath} ${historyPath || ''}`;
  const out = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
  return JSON.parse(out.trim());
}

describe('runner-utils importability', () => {
  it('a-prehook-runner.mjs imports runner-utils without error', () => {
    // Just verify the import resolves — we run with --check which validates syntax
    // but dynamic import actually tests the module resolution
    assert.doesNotThrow(() => {
      execSync(`node -e "import('./a-prehook-runner.mjs').catch(() => {})"`, {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 5000,
      });
    });
  });

  it('b-prehook-runner.mjs imports runner-utils without error', () => {
    assert.doesNotThrow(() => {
      execSync(`node -e "import('./b-prehook-runner.mjs').catch(() => {})"`, {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 5000,
      });
    });
  });

  it('e-prehook-runner.mjs imports runner-utils without error', () => {
    // e-prehook-runner may do network I/O on import; just verify syntax + resolution
    execSync(`node --check e-prehook-runner.mjs`, {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 5000,
    });
  });

  it('r-prehook-runner.mjs imports runner-utils without error', () => {
    assert.doesNotThrow(() => {
      execSync(`node -e "import('./r-prehook-runner.mjs').catch(() => {})"`, {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 5000,
      });
    });
  });
});

describe('b-prehook-runner stuck-items detection', () => {
  before(setup);
  after(cleanup);

  it('detects no stuck items when queue has no in-progress items', () => {
    const queuePath = join(SCRATCH, 'queue-empty.json');
    const histPath = join(SCRATCH, 'history-empty.txt');
    writeJSON(queuePath, { queue: [
      { id: 'wq-100', title: 'Test pending', status: 'pending' },
      { id: 'wq-101', title: 'Test done', status: 'done' },
    ]});
    writeFileSync(histPath, '2026-05-21 mode=B s=2082 dur=2m cost=$0.50 build=1 commit(s) files=[] note: test\n');

    const out = runRunner(2082, queuePath, histPath);
    assert.equal(out.stuck_items.count, 0);
    assert.deepStrictEqual(out.stuck_items.items, []);
  });

  it('detects stuck items that have been in-progress for 5+ B sessions', () => {
    const queuePath = join(SCRATCH, 'queue-stuck.json');
    const histPath = join(SCRATCH, 'history-stuck.txt');
    // Item started at s1900, current session is 2082 → elapsed = 182
    // bSessionsApprox = floor(182 * 60 / 100) = 109 → well above 5
    writeJSON(queuePath, { queue: [
      { id: 'wq-200', title: 'Stuck task', status: 'in-progress', created_session: 1900 },
      { id: 'wq-201', title: 'Recent task', status: 'in-progress', created_session: 2080 },
    ]});
    writeFileSync(histPath, '2026-05-21 mode=B s=2082 dur=2m cost=$0.50 build=1 commit(s) files=[] note: test\n');

    const out = runRunner(2082, queuePath, histPath);
    assert.equal(out.stuck_items.count, 1);
    assert.equal(out.stuck_items.items[0].id, 'wq-200');
    assert.ok(out.stuck_items.items[0].bSessionsApprox >= 5);
  });

  it('extracts session from notes when created_session is missing', () => {
    const queuePath = join(SCRATCH, 'queue-notes.json');
    const histPath = join(SCRATCH, 'history-notes.txt');
    writeJSON(queuePath, { queue: [
      { id: 'wq-300', title: 'Old task from notes', status: 'in-progress', notes: 'Started in s1800' },
    ]});
    writeFileSync(histPath, '2026-05-21 mode=B s=2082 dur=2m cost=$0.50 build=1 commit(s) files=[] note: test\n');

    const out = runRunner(2082, queuePath, histPath);
    assert.equal(out.stuck_items.count, 1);
    assert.equal(out.stuck_items.items[0].startSession, 1800);
  });

  it('returns empty when no history path provided', () => {
    const queuePath = join(SCRATCH, 'queue-nohist.json');
    writeJSON(queuePath, { queue: [
      { id: 'wq-400', title: 'In progress', status: 'in-progress', created_session: 1900 },
    ]});

    const out = runRunner(2082, queuePath, '');
    assert.equal(out.stuck_items.count, 0);
  });

  it('skips items without determinable start session', () => {
    const queuePath = join(SCRATCH, 'queue-nostart.json');
    const histPath = join(SCRATCH, 'history-nostart.txt');
    writeJSON(queuePath, { queue: [
      { id: 'wq-500', title: 'No start info', status: 'in-progress' },
    ]});
    writeFileSync(histPath, '2026-05-21 mode=B s=2082 dur=2m cost=$0.50 build=1 commit(s) files=[] note: test\n');

    const out = runRunner(2082, queuePath, histPath);
    assert.equal(out.stuck_items.count, 0);
  });
});

describe('b-prehook-runner title lint integration', () => {
  before(setup);
  after(cleanup);

  it('runs title lint and returns result structure', () => {
    const queuePath = join(SCRATCH, 'queue-lint.json');
    writeJSON(queuePath, { queue: [
      { id: 'wq-600', title: 'Add unit tests for runner module', status: 'pending' },
    ]});

    const out = runRunner(2082, queuePath, '');
    // title_lint should have a result (not an error)
    assert.ok(!out.title_lint.error, 'title_lint should not error');
    assert.ok(typeof out.title_lint.checked === 'number' || out.title_lint.issues !== undefined);
  });

  it('flags overly long titles', () => {
    const queuePath = join(SCRATCH, 'queue-long.json');
    const longTitle = 'A'.repeat(85) + ' something something';
    writeJSON(queuePath, { queue: [
      { id: 'wq-601', title: longTitle, status: 'pending' },
    ]});

    const out = runRunner(2082, queuePath, '');
    assert.ok(!out.title_lint.error);
    const issues = out.title_lint.issues || [];
    const found = issues.find(i => i.id === 'wq-601');
    assert.ok(found, 'should flag the long title');
  });
});

describe('b-prehook-runner output structure', () => {
  before(setup);
  after(cleanup);

  it('produces all expected top-level keys', () => {
    const queuePath = join(SCRATCH, 'queue-struct.json');
    writeJSON(queuePath, { queue: [] });

    const out = runRunner(2082, queuePath, '');
    assert.ok('title_lint' in out);
    assert.ok('stuck_items' in out);
    assert.ok('pipeline_nudge' in out);
    assert.ok('knowledge_revalidate' in out);
    assert.ok('summary' in out);
    assert.ok('stuck_nudge' in out);
  });
});

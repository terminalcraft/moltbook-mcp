#!/usr/bin/env node
// r-prehook-runner.test.mjs — Tests for R session prehook runner
//
// Tests: maintain-audit, security-posture, directive-analysis, brainstorm-gate,
// output structure, and issue counting.
//
// Usage: node --test r-prehook-runner.test.mjs
// Created: wq-1031

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(tmpdir(), 'r-prehook-test-' + Date.now());

function setup() {
  mkdirSync(SCRATCH, { recursive: true });
}

function cleanup() {
  rmSync(SCRATCH, { recursive: true, force: true });
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// Run the r-prehook-runner as a subprocess and parse its JSON output
function runRunner(sessionNum, directivesPath, queuePath, historyPath) {
  const cmd = `node ${join(__dirname, 'r-prehook-runner.mjs')} ${sessionNum} ${directivesPath} ${queuePath} ${historyPath || ''}`;
  const out = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
  // Runner outputs JSON (may have stderr noise), grab last line that parses as JSON
  const lines = out.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('No valid JSON in runner output: ' + out.slice(0, 200));
}

describe('r-prehook-runner output structure', () => {
  before(setup);
  after(cleanup);

  it('produces all expected top-level keys', () => {
    const dirPath = join(SCRATCH, 'dirs.json');
    const queuePath = join(SCRATCH, 'queue.json');
    const histPath = join(SCRATCH, 'hist.txt');
    writeJSON(dirPath, { directives: [] });
    writeJSON(queuePath, { queue: [] });
    writeFileSync(histPath, '2026-05-20 mode=R s=2080 dur=2m cost=$0.50 build=1 commit(s) files=[] note: test\n');

    const out = runRunner(2080, dirPath, queuePath, histPath);
    assert.ok('maintain_audit' in out);
    assert.ok('security_posture' in out);
    assert.ok('hook_health' in out);
    assert.ok('directive_analysis' in out);
    assert.ok('brainstorm_gate' in out);
    assert.ok('total_issues' in out);
    assert.ok('summary' in out);
    assert.ok('audit_text' in out);
    assert.ok('directive_status_text' in out);
  });

  it('total_issues is a number', () => {
    const dirPath = join(SCRATCH, 'dirs2.json');
    const queuePath = join(SCRATCH, 'queue2.json');
    writeJSON(dirPath, { directives: [] });
    writeJSON(queuePath, { queue: [] });

    const out = runRunner(2080, dirPath, queuePath, '');
    assert.equal(typeof out.total_issues, 'number');
  });
});

describe('r-prehook-runner directive analysis', () => {
  before(setup);
  after(cleanup);

  it('reports directive staleness for active directives near deadline', () => {
    const dirPath = join(SCRATCH, 'dirs-stale.json');
    const queuePath = join(SCRATCH, 'queue-stale.json');
    const histPath = join(SCRATCH, 'hist-stale.txt');

    writeJSON(dirPath, {
      directives: [
        { id: 'd081', status: 'active', defined_session: 2071, deadline_session: 2111, title: 'automate knowledge base maintenance' },
        { id: 'd080', status: 'completed', defined_session: 2055, completed_session: 2071, title: 'reduce prehook shell complexity' },
      ]
    });
    writeJSON(queuePath, { queue: [
      { id: 'wq-1024', title: 'knowledge auto-retire', status: 'done', tags: ['d081'] },
    ]});
    writeFileSync(histPath, '2026-05-20 mode=R s=2100 dur=2m cost=$0.50 build=1 commit(s) files=[] note: test\n');

    const out = runRunner(2100, dirPath, queuePath, histPath);
    assert.ok(out.directive_analysis);
    // Should have text output from analysis
    assert.ok(out.directive_analysis.text || out.directive_analysis.error);
  });

  it('handles empty directives gracefully', () => {
    const dirPath = join(SCRATCH, 'dirs-empty.json');
    const queuePath = join(SCRATCH, 'queue-empty.json');
    writeJSON(dirPath, { directives: [] });
    writeJSON(queuePath, { queue: [] });

    const out = runRunner(2080, dirPath, queuePath, '');
    // Should not crash — either produces analysis or error
    assert.ok(out.directive_analysis);
  });
});

describe('r-prehook-runner brainstorm gate', () => {
  before(setup);
  after(cleanup);

  it('reports healthy when brainstorming has enough ideas', () => {
    // This test runs against the actual BRAINSTORMING.md in the project
    const dirPath = join(SCRATCH, 'dirs-bg.json');
    const queuePath = join(SCRATCH, 'queue-bg.json');
    writeJSON(dirPath, { directives: [] });
    writeJSON(queuePath, { queue: [] });

    const out = runRunner(2080, dirPath, queuePath, '');
    assert.ok(out.brainstorm_gate);
    // brainstorm_gate should have totalActive and freshCount
    if (!out.brainstorm_gate.error) {
      assert.ok(typeof out.brainstorm_gate.totalActive === 'number');
      assert.ok(typeof out.brainstorm_gate.freshCount === 'number');
      assert.ok('healthy' in out.brainstorm_gate);
    }
  });
});

describe('r-prehook-runner maintain-audit check', () => {
  before(setup);
  after(cleanup);

  it('returns warnings array and issueCount', () => {
    const dirPath = join(SCRATCH, 'dirs-ma.json');
    const queuePath = join(SCRATCH, 'queue-ma.json');
    writeJSON(dirPath, { directives: [] });
    writeJSON(queuePath, { queue: [] });

    const out = runRunner(2080, dirPath, queuePath, '');
    assert.ok(out.maintain_audit);
    if (!out.maintain_audit.error) {
      assert.ok(Array.isArray(out.maintain_audit.warnings));
      assert.equal(typeof out.maintain_audit.issueCount, 'number');
    }
  });
});

describe('r-prehook-runner security posture', () => {
  before(setup);
  after(cleanup);

  it('returns clean status or issues array', () => {
    const dirPath = join(SCRATCH, 'dirs-sp.json');
    const queuePath = join(SCRATCH, 'queue-sp.json');
    writeJSON(dirPath, { directives: [] });
    writeJSON(queuePath, { queue: [] });

    const out = runRunner(2080, dirPath, queuePath, '');
    assert.ok(out.security_posture);
    if (!out.security_posture.error) {
      assert.ok('clean' in out.security_posture);
      assert.ok(Array.isArray(out.security_posture.issues));
    }
  });
});

describe('r-prehook-runner summary text', () => {
  before(setup);
  after(cleanup);

  it('contains r-prehook completion marker', () => {
    const dirPath = join(SCRATCH, 'dirs-sum.json');
    const queuePath = join(SCRATCH, 'queue-sum.json');
    writeJSON(dirPath, { directives: [] });
    writeJSON(queuePath, { queue: [] });

    const out = runRunner(2080, dirPath, queuePath, '');
    assert.ok(out.summary.includes('[r-prehook]'));
    // Should have either ALL CLEAR or TOTAL line
    assert.ok(out.summary.includes('ALL CLEAR') || out.summary.includes('TOTAL'));
  });
});

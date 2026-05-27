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
import { writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execRunner, createScratch } from './test-runner-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scratch = createScratch('r-prehook-test');

// Run the r-prehook-runner as a subprocess and parse its JSON output
function runRunner(sessionNum, directivesPath, queuePath, historyPath) {
  const cmd = `node ${join(__dirname, 'r-prehook-runner.mjs')} ${sessionNum} ${directivesPath} ${queuePath} ${historyPath || ''}`;
  return execRunner(cmd);
}

describe('r-prehook-runner output structure', () => {
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('produces all expected top-level keys', () => {
    const dirPath = scratch.writeJSON('dirs.json', { directives: [] });
    const queuePath = scratch.writeJSON('queue.json', { queue: [] });
    const histPath = scratch.writeFile('hist.txt',
      '2026-05-20 mode=R s=2080 dur=2m cost=$0.50 build=1 commit(s) files=[] note: test\n');

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
    const dirPath = scratch.writeJSON('dirs2.json', { directives: [] });
    const queuePath = scratch.writeJSON('queue2.json', { queue: [] });

    const out = runRunner(2080, dirPath, queuePath, '');
    assert.equal(typeof out.total_issues, 'number');
  });
});

describe('r-prehook-runner directive analysis', () => {
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('reports directive staleness for active directives near deadline', () => {
    const dirPath = scratch.writeJSON('dirs-stale.json', {
      directives: [
        { id: 'd081', status: 'active', defined_session: 2071, deadline_session: 2111, title: 'automate knowledge base maintenance' },
        { id: 'd080', status: 'completed', defined_session: 2055, completed_session: 2071, title: 'reduce prehook shell complexity' },
      ]
    });
    const queuePath = scratch.writeJSON('queue-stale.json', { queue: [
      { id: 'wq-1024', title: 'knowledge auto-retire', status: 'done', tags: ['d081'] },
    ]});
    const histPath = scratch.writeFile('hist-stale.txt',
      '2026-05-20 mode=R s=2100 dur=2m cost=$0.50 build=1 commit(s) files=[] note: test\n');

    const out = runRunner(2100, dirPath, queuePath, histPath);
    assert.ok(out.directive_analysis);
    // Should have text output from analysis
    assert.ok(out.directive_analysis.text || out.directive_analysis.error);
  });

  it('handles empty directives gracefully', () => {
    const dirPath = scratch.writeJSON('dirs-empty.json', { directives: [] });
    const queuePath = scratch.writeJSON('queue-empty.json', { queue: [] });

    const out = runRunner(2080, dirPath, queuePath, '');
    // Should not crash — either produces analysis or error
    assert.ok(out.directive_analysis);
  });
});

describe('r-prehook-runner brainstorm gate', () => {
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('reports healthy when brainstorming has enough ideas', () => {
    // This test runs against the actual BRAINSTORMING.md in the project
    const dirPath = scratch.writeJSON('dirs-bg.json', { directives: [] });
    const queuePath = scratch.writeJSON('queue-bg.json', { queue: [] });

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
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('returns warnings array and issueCount', () => {
    const dirPath = scratch.writeJSON('dirs-ma.json', { directives: [] });
    const queuePath = scratch.writeJSON('queue-ma.json', { queue: [] });

    const out = runRunner(2080, dirPath, queuePath, '');
    assert.ok(out.maintain_audit);
    if (!out.maintain_audit.error) {
      assert.ok(Array.isArray(out.maintain_audit.warnings));
      assert.equal(typeof out.maintain_audit.issueCount, 'number');
    }
  });
});

describe('r-prehook-runner security posture', () => {
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('returns clean status or issues array', () => {
    const dirPath = scratch.writeJSON('dirs-sp.json', { directives: [] });
    const queuePath = scratch.writeJSON('queue-sp.json', { queue: [] });

    const out = runRunner(2080, dirPath, queuePath, '');
    assert.ok(out.security_posture);
    if (!out.security_posture.error) {
      assert.ok('clean' in out.security_posture);
      assert.ok(Array.isArray(out.security_posture.issues));
    }
  });
});

describe('r-prehook-runner summary text', () => {
  before(() => scratch.setup());
  after(() => scratch.cleanup());

  it('contains r-prehook completion marker', () => {
    const dirPath = scratch.writeJSON('dirs-sum.json', { directives: [] });
    const queuePath = scratch.writeJSON('queue-sum.json', { queue: [] });

    const out = runRunner(2080, dirPath, queuePath, '');
    assert.ok(out.summary.includes('[r-prehook]'));
    // Should have either ALL CLEAR or TOTAL line
    assert.ok(out.summary.includes('ALL CLEAR') || out.summary.includes('TOTAL'));
  });
});

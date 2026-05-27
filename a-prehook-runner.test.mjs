#!/usr/bin/env node
// a-prehook-runner.test.mjs — Tests for A session prehook runner
//
// Tests: output structure, summary format, check labeling, and graceful
// handling when dependent modules encounter missing state files.
//
// Usage: node --test a-prehook-runner.test.mjs
// Created: wq-1031

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execRunner } from './test-runner-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Run the a-prehook-runner as a subprocess and parse its JSON output
function runRunner(sessionNum) {
  const cmd = `node ${join(__dirname, 'a-prehook-runner.mjs')} --session ${sessionNum}`;
  return execRunner(cmd, { timeout: 20000 });
}

describe('a-prehook-runner output structure', () => {
  it('produces all expected top-level keys', () => {
    const out = runRunner(9999);
    assert.ok('b_cost_trend' in out);
    assert.ok('r_cost_monitor' in out);
    assert.ok('hook_timing' in out);
    assert.ok('stale_tag_detect' in out);
    assert.ok('stale_tag_remediate' in out);
    assert.ok('cred_health' in out);
    assert.ok('briefing_directives' in out);
    assert.ok('cost_escalation' in out);
    assert.ok('auto_retire' in out);
    assert.ok('stale_refs' in out);
    assert.ok('summary' in out);
  });

  it('summary is a string with check labels', () => {
    const out = runRunner(9999);
    assert.equal(typeof out.summary, 'string');
    // Summary should contain the completion marker
    assert.ok(out.summary.includes('[a-prehook] All 8 checks complete'));
  });

  it('each check returns result or error (never undefined)', () => {
    const out = runRunner(9999);
    const checks = [
      'b_cost_trend', 'r_cost_monitor', 'hook_timing',
      'stale_tag_detect', 'stale_tag_remediate', 'cred_health',
      'briefing_directives', 'cost_escalation', 'auto_retire', 'stale_refs'
    ];
    for (const key of checks) {
      assert.ok(out[key] !== undefined, `${key} should not be undefined`);
      assert.equal(typeof out[key], 'object', `${key} should be an object`);
    }
  });
});

describe('a-prehook-runner cost trend checks', () => {
  it('b_cost_trend has status or error field', () => {
    const out = runRunner(9999);
    const bCost = out.b_cost_trend;
    assert.ok('status' in bCost || 'error' in bCost,
      'b_cost_trend should have status or error');
  });

  it('r_cost_monitor has status or error field', () => {
    const out = runRunner(9999);
    const rCost = out.r_cost_monitor;
    assert.ok('status' in rCost || 'error' in rCost,
      'r_cost_monitor should have status or error');
  });
});

describe('a-prehook-runner stale tag detection', () => {
  it('stale_tag_detect returns stale_count', () => {
    const out = runRunner(9999);
    const st = out.stale_tag_detect;
    if (!st.error) {
      assert.equal(typeof st.stale_count, 'number');
      assert.ok(Array.isArray(st.stale_items));
    }
  });
});

describe('a-prehook-runner briefing directive check', () => {
  it('briefing_directives returns severity field', () => {
    const out = runRunner(9999);
    const bd = out.briefing_directives;
    if (!bd.error) {
      assert.ok(bd.severity === 'clean' || bd.severity === 'critical',
        `unexpected severity: ${bd.severity}`);
      assert.equal(typeof bd.stale_count, 'number');
    }
  });
});

describe('a-prehook-runner credential health', () => {
  it('cred_health returns a recognized status or data shape', () => {
    const out = runRunner(9999);
    const ch = out.cred_health;
    // Either has status field (no_file, invalid_json) or numeric fields
    assert.ok(
      ch.status === 'no_file' || ch.status === 'invalid_json' ||
      typeof ch.before === 'number' || ch.error,
      'cred_health should have recognized shape'
    );
  });
});

describe('a-prehook-runner auto-retire', () => {
  it('auto_retire returns count or error', () => {
    const out = runRunner(9999);
    const ar = out.auto_retire;
    assert.ok(typeof ar.count === 'number' || ar.error,
      'auto_retire should have count or error');
  });
});

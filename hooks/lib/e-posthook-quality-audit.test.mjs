#!/usr/bin/env node
// e-posthook-quality-audit.test.mjs — Unit tests for e-posthook-quality-audit.mjs (d077, wq-943)
//
// Tests via subprocess with controlled env vars and temp files.
// Covers: happy path (quality warning + credential advisory), clean pass (no issues),
// malformed input, fuzzy phrase matching edge cases, credential regex patterns.
//
// Usage: node --test hooks/lib/e-posthook-quality-audit.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = new URL('./e-posthook-quality-audit.mjs', import.meta.url).pathname;

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'quality-audit-test-'));
}

function run(env) {
  try {
    const stdout = execFileSync('node', [SCRIPT], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 5000,
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status || 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function readTrace(traceFile) {
  return JSON.parse(readFileSync(traceFile, 'utf8'));
}

// ---- HAPPY PATH: quality warning ----
describe('quality warning (happy path)', () => {
  test('appends quality_warning when Q_FAILS > 0', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, JSON.stringify([{ session: 100, platforms: [] }]));

    const result = run({
      SESSION: '100',
      Q_FAILS: '2',
      Q_TOTAL: '3',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: 'clean note with no issues',
    });

    assert.strictEqual(result.code, 0);
    const traces = readTrace(traceFile);
    assert.strictEqual(traces[0].follow_ups.length, 1);
    assert.strictEqual(traces[0].follow_ups[0].type, 'quality_warning');
    assert.strictEqual(traces[0].follow_ups[0].severity, 'high');
    assert.ok(traces[0].follow_ups[0].message.includes('2/3'));

    rmSync(tmp, { recursive: true });
  });

  test('single fail gets medium severity', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, JSON.stringify([{ session: 200, platforms: [] }]));

    const result = run({
      SESSION: '200',
      Q_FAILS: '1',
      Q_TOTAL: '3',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: '',
    });

    assert.strictEqual(result.code, 0);
    const traces = readTrace(traceFile);
    assert.strictEqual(traces[0].follow_ups[0].severity, 'medium');

    rmSync(tmp, { recursive: true });
  });
});

// ---- HAPPY PATH: credential recycling ----
describe('credential recycling detection', () => {
  test('detects session-count credential pattern', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, JSON.stringify([{ session: 300, platforms: [] }]));

    const result = run({
      SESSION: '300',
      Q_FAILS: '0',
      Q_TOTAL: '3',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: 'contributed from 1900+ sessions of experience on the topic',
    });

    assert.strictEqual(result.code, 0);
    const traces = readTrace(traceFile);
    assert.strictEqual(traces[0].follow_ups.length, 1);
    assert.strictEqual(traces[0].follow_ups[0].type, 'credential_diversity_advisory');
    assert.ok(result.stdout.includes('credential-diversity advisory'));

    rmSync(tmp, { recursive: true });
  });

  test('detects blocked phrase via exact match', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, JSON.stringify([{ session: 400, platforms: [] }]));

    const result = run({
      SESSION: '400',
      Q_FAILS: '0',
      Q_TOTAL: '2',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: 'drew on hook consolidation experience to argue the point',
    });

    assert.strictEqual(result.code, 0);
    const traces = readTrace(traceFile);
    assert.strictEqual(traces[0].follow_ups.length, 1);
    assert.strictEqual(traces[0].follow_ups[0].type, 'credential_diversity_advisory');

    rmSync(tmp, { recursive: true });
  });

  test('detects blocked phrase via fuzzy match (60% threshold)', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, JSON.stringify([{ session: 500, platforms: [] }]));

    // "hook consolidation expertise" blocked — test with words rearranged/partial
    // "expertise in hook consolidation" contains 3/3 words of "hook consolidation expertise" = 100%
    const result = run({
      SESSION: '500',
      Q_FAILS: '0',
      Q_TOTAL: '2',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: 'expertise in hook consolidation processes',
    });

    assert.strictEqual(result.code, 0);
    const traces = readTrace(traceFile);
    assert.strictEqual(traces[0].follow_ups.length, 1);
    assert.strictEqual(traces[0].follow_ups[0].type, 'credential_diversity_advisory');

    rmSync(tmp, { recursive: true });
  });
});

// ---- CLEAN PASS (no issues) ----
describe('clean pass', () => {
  test('exits cleanly with no follow_ups when no issues detected', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, JSON.stringify([{ session: 600, platforms: [] }]));

    const result = run({
      SESSION: '600',
      Q_FAILS: '0',
      Q_TOTAL: '3',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: 'contributed architectural perspective on identity triage',
    });

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('no quality issues'));
    // Trace should NOT have follow_ups added
    const traces = readTrace(traceFile);
    assert.strictEqual(traces[0].follow_ups, undefined);

    rmSync(tmp, { recursive: true });
  });
});

// ---- MALFORMED INPUT ----
describe('malformed input', () => {
  test('handles missing trace file gracefully (empty traces)', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'nonexistent-trace.json');

    const result = run({
      SESSION: '700',
      Q_FAILS: '1',
      Q_TOTAL: '2',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: '',
    });

    // Should still run — creates follow_ups but can't find matching session in empty traces
    // The script writes back the (empty) traces array
    assert.strictEqual(result.code, 0);

    rmSync(tmp, { recursive: true });
  });

  test('handles single-object trace format (not array)', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, JSON.stringify({ session: 800, platforms: [] }));

    const result = run({
      SESSION: '800',
      Q_FAILS: '1',
      Q_TOTAL: '1',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: '',
    });

    assert.strictEqual(result.code, 0);
    const traces = readTrace(traceFile);
    assert.ok(Array.isArray(traces));
    assert.strictEqual(traces[0].follow_ups.length, 1);

    rmSync(tmp, { recursive: true });
  });

  test('handles malformed JSON in trace file', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, '{broken json!!!');

    const result = run({
      SESSION: '900',
      Q_FAILS: '0',
      Q_TOTAL: '0',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: '',
    });

    // Should exit 0 — no issues to report, empty traces
    assert.strictEqual(result.code, 0);

    rmSync(tmp, { recursive: true });
  });
});

// ---- EDGE CASES ----
describe('edge cases', () => {
  test('both quality warning AND credential recycling in same session', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, JSON.stringify([{ session: 1000, platforms: [] }]));

    const result = run({
      SESSION: '1000',
      Q_FAILS: '2',
      Q_TOTAL: '3',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: 'leveraging 1500 sessions of hook-system accretion knowledge',
    });

    assert.strictEqual(result.code, 0);
    const traces = readTrace(traceFile);
    assert.strictEqual(traces[0].follow_ups.length, 2);
    const types = traces[0].follow_ups.map(f => f.type);
    assert.ok(types.includes('quality_warning'));
    assert.ok(types.includes('credential_diversity_advisory'));

    rmSync(tmp, { recursive: true });
  });

  test('credential regex ignores 2-digit and 5+ digit session counts', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, JSON.stringify([{ session: 1100, platforms: [] }]));

    const result = run({
      SESSION: '1100',
      Q_FAILS: '0',
      Q_TOTAL: '2',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: 'built on 50 sessions and 99999 iterations of testing',
    });

    assert.strictEqual(result.code, 0);
    const traces = readTrace(traceFile);
    // Neither "50 sessions" (2 digits) nor "99999 iterations" (5 digits) should trigger
    assert.strictEqual(traces[0].follow_ups, undefined);

    rmSync(tmp, { recursive: true });
  });

  test('fuzzy match does not trigger below 60% word overlap', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, JSON.stringify([{ session: 1200, platforms: [] }]));

    // "hook consolidation experience" has 3 words
    // Note with only 1/3 matching = 33% < 60%
    const result = run({
      SESSION: '1200',
      Q_FAILS: '0',
      Q_TOTAL: '2',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: 'the hook refactoring was straightforward',
    });

    assert.strictEqual(result.code, 0);
    const traces = readTrace(traceFile);
    assert.strictEqual(traces[0].follow_ups, undefined);

    rmSync(tmp, { recursive: true });
  });

  test('session matching finds correct trace entry in multi-entry array', () => {
    const tmp = makeTmpDir();
    const traceFile = join(tmp, 'trace.json');
    writeFileSync(traceFile, JSON.stringify([
      { session: 1299, platforms: [] },
      { session: 1300, platforms: [] },
      { session: 1301, platforms: [] },
    ]));

    const result = run({
      SESSION: '1300',
      Q_FAILS: '1',
      Q_TOTAL: '2',
      TRACE_FILE: traceFile,
      CURRENT_NOTE: '',
    });

    assert.strictEqual(result.code, 0);
    const traces = readTrace(traceFile);
    // Only session 1300 should have follow_ups
    assert.strictEqual(traces[0].follow_ups, undefined);
    assert.strictEqual(traces[1].follow_ups.length, 1);
    assert.strictEqual(traces[2].follow_ups, undefined);

    rmSync(tmp, { recursive: true });
  });
});

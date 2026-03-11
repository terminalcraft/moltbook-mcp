#!/usr/bin/env node
// e-posthook-early-exit.test.mjs — Unit tests for e-posthook-early-exit.mjs (d076, wq-941)
//
// Tests via subprocess with controlled env vars and temp files.
// Covers: happy path (warning injected into trace), empty trace file,
// malformed input, single-object trace format.
//
// Usage: node --test hooks/lib/e-posthook-early-exit.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = new URL('./e-posthook-early-exit.mjs', import.meta.url).pathname;

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'early-exit-test-'));
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

// ---- HAPPY PATH ----

describe('e-posthook-early-exit: happy path', () => {
  test('injects warning into latest trace entry follow_ups', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      writeFileSync(traceFile, JSON.stringify([{
        session: 1800,
        platforms_engaged: ['moltbook'],
        follow_ups: [],
      }]));

      const r = run({
        TRACE_FILE: traceFile,
        SESSION: '1800',
        DURATION_STR: '1m45s',
        TOTAL_SECONDS: '105',
      });

      assert.strictEqual(r.code, 0);
      assert.ok(r.stdout.includes('stigmergic pressure'));

      const traces = readTrace(traceFile);
      assert.strictEqual(traces.length, 1);
      assert.strictEqual(traces[0].early_exit_flag, true);
      assert.ok(traces[0].follow_ups.length >= 1);
      assert.ok(traces[0].follow_ups[0].includes('EARLY EXIT WARNING'));
      assert.ok(traces[0].follow_ups[0].includes('s1800'));
      assert.ok(traces[0].follow_ups[0].includes('105s'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('appends to existing follow_ups', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      writeFileSync(traceFile, JSON.stringify([{
        session: 1801,
        follow_ups: ['existing follow-up'],
      }]));

      run({
        TRACE_FILE: traceFile,
        SESSION: '1801',
        DURATION_STR: '0m50s',
        TOTAL_SECONDS: '50',
      });

      const traces = readTrace(traceFile);
      assert.strictEqual(traces[0].follow_ups.length, 2);
      assert.strictEqual(traces[0].follow_ups[0], 'existing follow-up');
      assert.ok(traces[0].follow_ups[1].includes('EARLY EXIT WARNING'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('targets the last trace entry in multi-entry array', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      writeFileSync(traceFile, JSON.stringify([
        { session: 1798, follow_ups: [] },
        { session: 1799, follow_ups: [] },
        { session: 1800, follow_ups: [] },
      ]));

      run({
        TRACE_FILE: traceFile,
        SESSION: '1802',
        DURATION_STR: '1m00s',
        TOTAL_SECONDS: '60',
      });

      const traces = readTrace(traceFile);
      assert.strictEqual(traces.length, 3);
      // First two should be untouched
      assert.strictEqual(traces[0].follow_ups.length, 0);
      assert.strictEqual(traces[1].follow_ups.length, 0);
      // Last one gets the warning
      assert.ok(traces[2].follow_ups.length >= 1);
      assert.strictEqual(traces[2].early_exit_flag, true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---- EMPTY/MISSING TRACE ----

describe('e-posthook-early-exit: empty or missing trace', () => {
  test('creates synthetic trace entry when trace file is empty array', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      writeFileSync(traceFile, '[]');

      run({
        TRACE_FILE: traceFile,
        SESSION: '1803',
        DURATION_STR: '0m30s',
        TOTAL_SECONDS: '30',
      });

      const traces = readTrace(traceFile);
      assert.strictEqual(traces.length, 1);
      assert.strictEqual(traces[0].session, 1803);
      assert.strictEqual(traces[0].early_exit_flag, true);
      assert.ok(traces[0].note.includes('Synthetic trace'));
      assert.ok(traces[0].follow_ups[0].includes('EARLY EXIT WARNING'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('creates synthetic entry when trace file has invalid JSON', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      writeFileSync(traceFile, '{broken json!!');

      run({
        TRACE_FILE: traceFile,
        SESSION: '1804',
        DURATION_STR: '0m45s',
        TOTAL_SECONDS: '45',
      });

      const traces = readTrace(traceFile);
      assert.strictEqual(traces.length, 1);
      assert.strictEqual(traces[0].early_exit_flag, true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---- EDGE CASES ----

describe('e-posthook-early-exit: edge cases', () => {
  test('handles single-object trace (not array)', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      writeFileSync(traceFile, JSON.stringify({
        session: 1805,
        platforms_engaged: ['chatr'],
        follow_ups: [],
      }));

      run({
        TRACE_FILE: traceFile,
        SESSION: '1805',
        DURATION_STR: '1m10s',
        TOTAL_SECONDS: '70',
      });

      const traces = readTrace(traceFile);
      assert.ok(Array.isArray(traces));
      assert.strictEqual(traces.length, 1);
      assert.strictEqual(traces[0].early_exit_flag, true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('handles trace entry with no follow_ups field', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      writeFileSync(traceFile, JSON.stringify([{
        session: 1806,
        platforms_engaged: ['moltbook'],
      }]));

      run({
        TRACE_FILE: traceFile,
        SESSION: '1806',
        DURATION_STR: '1m30s',
        TOTAL_SECONDS: '90',
      });

      const traces = readTrace(traceFile);
      assert.ok(Array.isArray(traces[0].follow_ups));
      assert.ok(traces[0].follow_ups[0].includes('EARLY EXIT WARNING'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('warning message includes duration string and total seconds', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      writeFileSync(traceFile, JSON.stringify([{ session: 1807, follow_ups: [] }]));

      run({
        TRACE_FILE: traceFile,
        SESSION: '1807',
        DURATION_STR: '2m05s',
        TOTAL_SECONDS: '125',
      });

      const traces = readTrace(traceFile);
      const warning = traces[0].follow_ups[0];
      assert.ok(warning.includes('2m05s'));
      assert.ok(warning.includes('125s'));
      assert.ok(warning.includes('s1807'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

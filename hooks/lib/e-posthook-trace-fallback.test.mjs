#!/usr/bin/env node
// e-posthook-trace-fallback.test.mjs — Unit tests for e-posthook-trace-fallback.mjs (d076, wq-941)
//
// Tests via subprocess with controlled env vars and temp files.
// Covers: happy path (synthetic trace created from intel), existing trace appended,
// malformed input, trace cap at 30 entries.
//
// Usage: node --test hooks/lib/e-posthook-trace-fallback.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = new URL('./e-posthook-trace-fallback.mjs', import.meta.url).pathname;

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'trace-fallback-test-'));
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

function readTrace(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parsedJson(overrides = {}) {
  return JSON.stringify({
    archive_intel_platforms: ['moltbook', 'chatr'],
    archive_intel_topics: ['agent cooperation', 'testing patterns'],
    ...overrides,
  });
}

// ---- HAPPY PATH ----

describe('e-posthook-trace-fallback: happy path', () => {
  test('generates synthetic trace entry from parsed intel', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(traceFile, '[]');
      writeFileSync(parsedFile, parsedJson());

      const r = run({
        SESSION: '1800',
        TRACE_FILE: traceFile,
        PARSED_FILE: parsedFile,
      });

      assert.strictEqual(r.code, 0);
      assert.ok(r.stdout.includes('trace-fallback'));
      assert.ok(r.stdout.includes('2 platforms'));

      const traces = readTrace(traceFile);
      assert.strictEqual(traces.length, 1);
      assert.strictEqual(traces[0].session, 1800);
      assert.strictEqual(traces[0]._synthetic, true);
      assert.deepStrictEqual(traces[0].platforms_engaged, ['moltbook', 'chatr']);
      assert.deepStrictEqual(traces[0].topics, ['agent cooperation', 'testing patterns']);
      assert.ok(traces[0]._reason.includes('s1800'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('appends to existing traces', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(traceFile, JSON.stringify([
        { session: 1798, platforms_engaged: ['4claw'] },
        { session: 1799, platforms_engaged: ['moltbook'] },
      ]));
      writeFileSync(parsedFile, parsedJson());

      run({
        SESSION: '1801',
        TRACE_FILE: traceFile,
        PARSED_FILE: parsedFile,
      });

      const traces = readTrace(traceFile);
      assert.strictEqual(traces.length, 3);
      assert.strictEqual(traces[2].session, 1801);
      assert.strictEqual(traces[2]._synthetic, true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('initializes empty arrays for missing trace fields', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(traceFile, '[]');
      writeFileSync(parsedFile, parsedJson({ archive_intel_platforms: ['solo'] }));

      run({
        SESSION: '1802',
        TRACE_FILE: traceFile,
        PARSED_FILE: parsedFile,
      });

      const traces = readTrace(traceFile);
      const entry = traces[0];
      assert.deepStrictEqual(entry.picker_mandate, []);
      assert.deepStrictEqual(entry.skipped_platforms, []);
      assert.deepStrictEqual(entry.agents_interacted, []);
      assert.deepStrictEqual(entry.threads_contributed, []);
      assert.deepStrictEqual(entry.follow_ups, []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---- MALFORMED INPUT ----

describe('e-posthook-trace-fallback: malformed input', () => {
  test('fails gracefully when parsed file has invalid JSON', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(traceFile, '[]');
      writeFileSync(parsedFile, '{not valid json!!');

      const r = run({
        SESSION: '1803',
        TRACE_FILE: traceFile,
        PARSED_FILE: parsedFile,
      });

      // Script should fail (JSON.parse throws, no try/catch in parsedFile read)
      assert.notStrictEqual(r.code, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('handles missing archive_intel_platforms gracefully', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(traceFile, '[]');
      writeFileSync(parsedFile, JSON.stringify({}));

      const r = run({
        SESSION: '1804',
        TRACE_FILE: traceFile,
        PARSED_FILE: parsedFile,
      });

      assert.strictEqual(r.code, 0);
      const traces = readTrace(traceFile);
      assert.deepStrictEqual(traces[0].platforms_engaged, []);
      assert.deepStrictEqual(traces[0].topics, []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('handles broken trace file by starting fresh array', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(traceFile, 'not json at all');
      writeFileSync(parsedFile, parsedJson());

      run({
        SESSION: '1805',
        TRACE_FILE: traceFile,
        PARSED_FILE: parsedFile,
      });

      const traces = readTrace(traceFile);
      assert.strictEqual(traces.length, 1);
      assert.strictEqual(traces[0]._synthetic, true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---- EDGE CASES ----

describe('e-posthook-trace-fallback: edge cases', () => {
  test('caps trace array at 30 entries', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      const parsedFile = join(dir, 'parsed.json');
      // Create 30 existing entries
      const existing = Array.from({ length: 30 }, (_, i) => ({
        session: 1700 + i,
        platforms_engaged: [],
      }));
      writeFileSync(traceFile, JSON.stringify(existing));
      writeFileSync(parsedFile, parsedJson());

      run({
        SESSION: '1806',
        TRACE_FILE: traceFile,
        PARSED_FILE: parsedFile,
      });

      const traces = readTrace(traceFile);
      assert.strictEqual(traces.length, 30);
      // Newest entry should be last
      assert.strictEqual(traces[29].session, 1806);
      assert.strictEqual(traces[29]._synthetic, true);
      // Oldest entry should have been dropped
      assert.strictEqual(traces[0].session, 1701);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('handles single-object trace (not array)', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(traceFile, JSON.stringify({
        session: 1799,
        platforms_engaged: ['moltbook'],
      }));
      writeFileSync(parsedFile, parsedJson());

      run({
        SESSION: '1807',
        TRACE_FILE: traceFile,
        PARSED_FILE: parsedFile,
      });

      const traces = readTrace(traceFile);
      assert.ok(Array.isArray(traces));
      assert.strictEqual(traces.length, 2);
      assert.strictEqual(traces[0].session, 1799);
      assert.strictEqual(traces[1].session, 1807);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('sets correct _source metadata', () => {
    const dir = makeTmpDir();
    try {
      const traceFile = join(dir, 'trace.json');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(traceFile, '[]');
      writeFileSync(parsedFile, parsedJson());

      run({
        SESSION: '1808',
        TRACE_FILE: traceFile,
        PARSED_FILE: parsedFile,
      });

      const traces = readTrace(traceFile);
      assert.ok(traces[0]._source.includes('trace-fallback'));
      assert.ok(traces[0]._reason.includes('truncated'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

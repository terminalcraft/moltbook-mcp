#!/usr/bin/env node
// quality-enforce.test.mjs — Unit tests for quality-enforce.mjs (d077, wq-944)
//
// Tests via subprocess with controlled env vars and temp files.
// Covers: happy path (ok/degraded/critical levels), streak detection,
// enforcement file rotation, missing input, edge cases.
//
// Usage: node --test hooks/lib/quality-enforce.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = new URL('./quality-enforce.mjs', import.meta.url).pathname;

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'quality-enforce-test-'));
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

function makeScoresFile(tmp, entries) {
  const path = join(tmp, 'quality-scores.jsonl');
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

function readEnforcement(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// ---- HAPPY PATH: level=ok ----
describe('level: ok', () => {
  test('all passing entries produce ok level with no action', () => {
    const tmp = makeTmpDir();
    const scoresFile = makeScoresFile(tmp, [
      { session: 100, verdict: 'PASS', composite: 0.9, violations: [] },
      { session: 100, verdict: 'PASS', composite: 0.85, violations: [] },
      { session: 100, verdict: 'PASS', composite: 0.95, violations: [] },
    ]);
    const enforceFile = join(tmp, 'enforce.jsonl');

    const result = run({ SESSION: '100', QUALITY_SCORES: scoresFile, ENFORCE_FILE: enforceFile });

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('level: ok'));
    assert.ok(result.stdout.includes('✓'));

    const records = readEnforcement(enforceFile);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].level, 'ok');
    assert.strictEqual(records[0].action, null);
    assert.strictEqual(records[0].session, 100);
    assert.strictEqual(records[0].session_fails, 0);
    assert.strictEqual(records[0].session_posts, 3);
    assert.strictEqual(records[0].fail_streak, 0);

    rmSync(tmp, { recursive: true });
  });
});

// ---- DEGRADED LEVEL (fail rate > 0.4) ----
describe('level: degraded', () => {
  test('fail rate > 40% triggers degraded with action', () => {
    const tmp = makeTmpDir();
    // 10 entries, 5 FAIL = 50% rate
    const entries = [];
    for (let i = 0; i < 5; i++) entries.push({ session: 200, verdict: 'PASS', composite: 0.9, violations: [] });
    for (let i = 0; i < 5; i++) entries.push({ session: 200, verdict: 'FAIL', composite: 0.3, violations: ['formulaic'] });
    const scoresFile = makeScoresFile(tmp, entries);
    const enforceFile = join(tmp, 'enforce.jsonl');

    const result = run({ SESSION: '200', QUALITY_SCORES: scoresFile, ENFORCE_FILE: enforceFile });

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('level: degraded'));
    assert.ok(result.stdout.includes('⚠'));

    const records = readEnforcement(enforceFile);
    assert.strictEqual(records[0].level, 'degraded');
    assert.ok(records[0].action.includes('formulaic'));
    assert.strictEqual(records[0].rolling_fail_rate, 0.5);

    rmSync(tmp, { recursive: true });
  });
});

// ---- CRITICAL LEVEL (fail rate > 0.6) ----
describe('level: critical', () => {
  test('fail rate > 60% triggers critical with mandatory rewrite action', () => {
    const tmp = makeTmpDir();
    // 10 entries, 7 FAIL = 70% rate
    const entries = [];
    for (let i = 0; i < 3; i++) entries.push({ session: 300, verdict: 'PASS', composite: 0.9, violations: [] });
    for (let i = 0; i < 7; i++) entries.push({ session: 300, verdict: 'FAIL', composite: 0.2, violations: ['repetitive'] });
    const scoresFile = makeScoresFile(tmp, entries);
    const enforceFile = join(tmp, 'enforce.jsonl');

    const result = run({ SESSION: '300', QUALITY_SCORES: scoresFile, ENFORCE_FILE: enforceFile });

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('level: critical'));
    assert.ok(result.stdout.includes('✗'));

    const records = readEnforcement(enforceFile);
    assert.strictEqual(records[0].level, 'critical');
    assert.ok(records[0].action.includes('mandatory rewrite'));
    assert.strictEqual(records[0].rolling_fail_rate, 0.7);
    assert.strictEqual(records[0].top_violation, 'repetitive');

    rmSync(tmp, { recursive: true });
  });
});

// ---- STREAK WARNING ----
describe('streak detection', () => {
  test('3 consecutive fails at end triggers streak_warning (when rate <= 0.4)', () => {
    const tmp = makeTmpDir();
    // 10 entries: 7 PASS then 3 FAIL = 30% rate but streak=3
    const entries = [];
    for (let i = 0; i < 7; i++) entries.push({ session: 400 + i, verdict: 'PASS', composite: 0.9, violations: [] });
    for (let i = 0; i < 3; i++) entries.push({ session: 410 + i, verdict: 'FAIL', composite: 0.4, violations: ['bland'] });
    const scoresFile = makeScoresFile(tmp, entries);
    const enforceFile = join(tmp, 'enforce.jsonl');

    const result = run({ SESSION: '412', QUALITY_SCORES: scoresFile, ENFORCE_FILE: enforceFile });

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('streak: 3'));

    const records = readEnforcement(enforceFile);
    assert.strictEqual(records[0].level, 'streak_warning');
    assert.ok(records[0].action.includes('rhetorical'));
    assert.strictEqual(records[0].fail_streak, 3);

    rmSync(tmp, { recursive: true });
  });

  test('broken streak (PASS at end) resets streak to 0', () => {
    const tmp = makeTmpDir();
    const entries = [
      { session: 500, verdict: 'FAIL', composite: 0.3, violations: [] },
      { session: 500, verdict: 'FAIL', composite: 0.3, violations: [] },
      { session: 500, verdict: 'PASS', composite: 0.9, violations: [] },
    ];
    const scoresFile = makeScoresFile(tmp, entries);
    const enforceFile = join(tmp, 'enforce.jsonl');

    const result = run({ SESSION: '500', QUALITY_SCORES: scoresFile, ENFORCE_FILE: enforceFile });

    const records = readEnforcement(enforceFile);
    assert.strictEqual(records[0].fail_streak, 0);

    rmSync(tmp, { recursive: true });
  });
});

// ---- MISSING / MALFORMED INPUT ----
describe('missing and malformed input', () => {
  test('exits gracefully with missing env vars', () => {
    const result = run({ SESSION: '', QUALITY_SCORES: '', ENFORCE_FILE: '' });
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('missing env vars'));
  });

  test('exits gracefully when scores file does not exist', () => {
    const tmp = makeTmpDir();
    const result = run({
      SESSION: '600',
      QUALITY_SCORES: join(tmp, 'nonexistent.jsonl'),
      ENFORCE_FILE: join(tmp, 'enforce.jsonl'),
    });
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('no quality history'));

    rmSync(tmp, { recursive: true });
  });

  test('skips malformed JSON lines in scores file', () => {
    const tmp = makeTmpDir();
    const scoresFile = join(tmp, 'scores.jsonl');
    writeFileSync(scoresFile, [
      JSON.stringify({ session: 700, verdict: 'PASS', composite: 0.9, violations: [] }),
      '{broken!!!',
      JSON.stringify({ session: 700, verdict: 'PASS', composite: 0.8, violations: [] }),
    ].join('\n') + '\n');
    const enforceFile = join(tmp, 'enforce.jsonl');

    const result = run({ SESSION: '700', QUALITY_SCORES: scoresFile, ENFORCE_FILE: enforceFile });

    assert.strictEqual(result.code, 0);
    const records = readEnforcement(enforceFile);
    assert.strictEqual(records[0].session_posts, 2); // only 2 valid entries for session 700

    rmSync(tmp, { recursive: true });
  });

  test('handles empty scores file (all blank lines)', () => {
    const tmp = makeTmpDir();
    const scoresFile = join(tmp, 'scores.jsonl');
    writeFileSync(scoresFile, '\n\n\n');
    const enforceFile = join(tmp, 'enforce.jsonl');

    const result = run({ SESSION: '800', QUALITY_SCORES: scoresFile, ENFORCE_FILE: enforceFile });

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('no entries'));

    rmSync(tmp, { recursive: true });
  });
});

// ---- EDGE CASES ----
describe('edge cases', () => {
  test('enforcement file rotation caps at 50 lines', () => {
    const tmp = makeTmpDir();
    const scoresFile = makeScoresFile(tmp, [
      { session: 900, verdict: 'PASS', composite: 0.9, violations: [] },
    ]);
    const enforceFile = join(tmp, 'enforce.jsonl');

    // Pre-fill with 55 lines
    const oldLines = [];
    for (let i = 0; i < 55; i++) {
      oldLines.push(JSON.stringify({ ts: '2026-01-01', session: i, level: 'ok' }));
    }
    writeFileSync(enforceFile, oldLines.join('\n') + '\n');

    const result = run({ SESSION: '900', QUALITY_SCORES: scoresFile, ENFORCE_FILE: enforceFile });

    assert.strictEqual(result.code, 0);
    const finalLines = readFileSync(enforceFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(finalLines.length, 50); // capped at 50

    rmSync(tmp, { recursive: true });
  });

  test('rolling average composite handles entries without composite field', () => {
    const tmp = makeTmpDir();
    const scoresFile = makeScoresFile(tmp, [
      { session: 1000, verdict: 'PASS', composite: 0.9, violations: [] },
      { session: 1000, verdict: 'PASS', violations: [] }, // no composite
    ]);
    const enforceFile = join(tmp, 'enforce.jsonl');

    const result = run({ SESSION: '1000', QUALITY_SCORES: scoresFile, ENFORCE_FILE: enforceFile });

    assert.strictEqual(result.code, 0);
    const records = readEnforcement(enforceFile);
    assert.strictEqual(records[0].rolling_avg_composite, 0.9); // only counts the one with composite

    rmSync(tmp, { recursive: true });
  });

  test('top_violation is null when no violations present', () => {
    const tmp = makeTmpDir();
    const scoresFile = makeScoresFile(tmp, [
      { session: 1100, verdict: 'PASS', composite: 0.9, violations: [] },
    ]);
    const enforceFile = join(tmp, 'enforce.jsonl');

    const result = run({ SESSION: '1100', QUALITY_SCORES: scoresFile, ENFORCE_FILE: enforceFile });

    const records = readEnforcement(enforceFile);
    assert.strictEqual(records[0].top_violation, null);

    rmSync(tmp, { recursive: true });
  });

  test('session-specific counts only count matching session entries', () => {
    const tmp = makeTmpDir();
    const scoresFile = makeScoresFile(tmp, [
      { session: 1199, verdict: 'FAIL', composite: 0.3, violations: ['old'] },
      { session: 1200, verdict: 'PASS', composite: 0.9, violations: [] },
      { session: 1200, verdict: 'FAIL', composite: 0.4, violations: ['test'] },
      { session: 1201, verdict: 'FAIL', composite: 0.2, violations: ['future'] },
    ]);
    const enforceFile = join(tmp, 'enforce.jsonl');

    const result = run({ SESSION: '1200', QUALITY_SCORES: scoresFile, ENFORCE_FILE: enforceFile });

    const records = readEnforcement(enforceFile);
    assert.strictEqual(records[0].session_posts, 2); // only session 1200
    assert.strictEqual(records[0].session_fails, 1); // only session 1200 FAILs

    rmSync(tmp, { recursive: true });
  });
});

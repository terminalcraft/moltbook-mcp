#!/usr/bin/env node
// e-posthook-parser.test.mjs — Unit tests for e-posthook-parser.mjs (d076, wq-942)
//
// Tests via subprocess with controlled env vars and temp files.
// Covers: trace parsing, malformed JSON, missing fields, rate-limit detection,
// failure mode classification, shell variable output format.
//
// Usage: node --test hooks/lib/e-posthook-parser.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = new URL('./e-posthook-parser.mjs', import.meta.url).pathname;

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'parser-test-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function run(stateDir, session = 100, extraEnv = {}) {
  const logDir = join(stateDir, 'logs');
  try {
    const stdout = execFileSync('node', [SCRIPT], {
      env: {
        HOME: '/home/moltbot',
        SESSION_NUM: String(session),
        STATE_DIR: stateDir,
        LOG_DIR: logDir,
        LOG_FILE: join(logDir, `session-${session}.log`),
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status || 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function parseOutput(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  const jsonLine = lines.find(l => l.startsWith('JSON:'));
  const vars = {};
  for (const l of lines) {
    if (l.startsWith('VARS:')) {
      const eq = l.indexOf('=');
      if (eq > 5) vars[l.slice(5, eq)] = l.slice(eq + 1);
    }
  }
  return { json: jsonLine ? JSON.parse(jsonLine.slice(5)) : null, vars };
}

// ---- HAPPY PATH: full trace with all fields ----

describe('e-posthook-parser: happy path', () => {
  test('parses complete trace with intel', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), JSON.stringify([
        { session: 100, platform: 'moltbook', learned: 'API v5 header fix' },
        { session: 100, platform: 'chatr', learned: 'Agent handshake protocol' },
      ]));
      writeFileSync(join(dir, 'engagement-trace.json'), JSON.stringify([{
        session: 100,
        platforms_engaged: ['moltbook', 'chatr'],
        skipped_platforms: [],
        topics: ['API design'],
        agents_interacted: ['BuddyDubby'],
        picker_mandate: ['moltbook', 'chatr'],
        backup_substitutions: [],
      }]));
      writeFileSync(join(dir, 'session-history.txt'),
        '2026-03-11 mode=E s=100 dur=4m30s cost=$1.00 note: Engaged 2 platforms\n');

      const { code, stdout } = run(dir, 100);
      assert.strictEqual(code, 0);
      const { json, vars } = parseOutput(stdout);

      assert.strictEqual(json.intel_count, 2);
      assert.strictEqual(json.has_trace, true);
      assert.deepStrictEqual(json.trace_platforms_engaged, ['moltbook', 'chatr']);
      assert.strictEqual(json.failure_mode, 'none');
      assert.strictEqual(json.backup_substitution_count, 0);
      assert.strictEqual(vars.INTEL_COUNT, '2');
      assert.strictEqual(vars.HAS_TRACE, 'true');
      assert.strictEqual(vars.FAILURE_MODE, "'none'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normalizes object-style platforms_engaged', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), JSON.stringify([{
        session: 200,
        platforms_engaged: [{ platform: 'moltchan' }, 'chatr'],
      }]));
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { json } = parseOutput(run(dir, 200).stdout);
      assert.deepStrictEqual(json.trace_platforms_engaged, ['moltchan', 'chatr']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('counts backup substitutions', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), JSON.stringify([{
        session: 300,
        platforms_engaged: ['chatr'],
        backup_substitutions: [
          { original: 'grove', replacement: 'chatr', reason: 'API broken' },
        ],
      }]));
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { json } = parseOutput(run(dir, 300).stdout);
      assert.strictEqual(json.backup_substitution_count, 1);
      assert.strictEqual(json.backup_substitutions[0].original, 'grove');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- MISSING/EMPTY FILES ----

describe('e-posthook-parser: missing files', () => {
  test('handles all files missing gracefully', () => {
    const dir = makeTmpDir();
    try {
      const { code, stdout } = run(dir, 500);
      assert.strictEqual(code, 0);
      const { json, vars } = parseOutput(stdout);

      assert.strictEqual(json.intel_count, 0);
      assert.strictEqual(json.has_trace, false);
      assert.strictEqual(json.phase2_reached, false);
      // No phase2 timing data → phase2_reached=false → truncated_early
      assert.strictEqual(json.failure_mode, 'truncated_early');
      assert.strictEqual(json.e_count, 0);
      assert.strictEqual(vars.INTEL_COUNT, '0');
      assert.strictEqual(vars.HAS_TRACE, 'false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('handles empty JSON arrays', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), '[]');
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { json } = parseOutput(run(dir, 600).stdout);
      assert.strictEqual(json.intel_count, 0);
      assert.strictEqual(json.has_trace, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- MALFORMED INPUT ----

describe('e-posthook-parser: malformed input', () => {
  test('handles corrupted JSON in intel file', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '{broken json!!!');
      writeFileSync(join(dir, 'engagement-trace.json'), '[]');
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { code, stdout } = run(dir, 700);
      assert.strictEqual(code, 0);
      const { json } = parseOutput(stdout);
      assert.strictEqual(json.intel_count, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('handles corrupted JSON in trace file', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), 'not json');
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { code, stdout } = run(dir, 800);
      assert.strictEqual(code, 0);
      const { json } = parseOutput(stdout);
      assert.strictEqual(json.has_trace, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('handles single-object trace (non-array)', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), JSON.stringify({
        session: 900,
        platforms_engaged: ['moltbook'],
      }));
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { json } = parseOutput(run(dir, 900).stdout);
      assert.strictEqual(json.has_trace, true);
      assert.deepStrictEqual(json.trace_platforms_engaged, ['moltbook']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- FAILURE MODE CLASSIFICATION ----

describe('e-posthook-parser: failure modes', () => {
  test('classifies truncated_early when phase2 not reached', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), JSON.stringify([{
        session: 1000, platforms_engaged: [],
      }]));
      writeFileSync(join(dir, 'e-phase-timing.json'), JSON.stringify({
        phases: [{ phase: '0', ts: Date.now() }, { phase: '1', ts: Date.now() }],
      }));
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { json } = parseOutput(run(dir, 1000).stdout);
      assert.strictEqual(json.phase2_reached, false);
      assert.strictEqual(json.failure_mode, 'truncated_early');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('classifies platform_unavailable when all mandated platforms fail', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), JSON.stringify([{
        session: 1100,
        platforms_engaged: [],
        skipped_platforms: [
          { platform: 'grove', reason: 'API broken' },
          { platform: 'ctxly', reason: 'JSON error' },
        ],
        picker_mandate: ['grove', 'ctxly'],
      }]));
      writeFileSync(join(dir, 'e-phase-timing.json'), JSON.stringify({
        phases: [{ phase: '0', ts: Date.now() }, { phase: '2', ts: Date.now() }],
      }));
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { json } = parseOutput(run(dir, 1100).stdout);
      assert.strictEqual(json.phase2_reached, true);
      assert.strictEqual(json.all_platforms_failed, true);
      assert.strictEqual(json.failure_mode, 'platform_unavailable');
      assert.ok(json.platform_details.startsWith('ALL_FAILED:'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('classifies trace_without_intel when trace exists but no intel', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), JSON.stringify([{
        session: 1200,
        platforms_engaged: ['moltbook'],
        skipped_platforms: [],
        picker_mandate: ['moltbook', 'chatr'],
      }]));
      writeFileSync(join(dir, 'e-phase-timing.json'), JSON.stringify({
        phases: [{ phase: '0', ts: Date.now() }, { phase: '2', ts: Date.now() }],
      }));
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { json } = parseOutput(run(dir, 1200).stdout);
      assert.strictEqual(json.failure_mode, 'trace_without_intel');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- DURATION PARSING ----

describe('e-posthook-parser: duration parsing', () => {
  test('parses duration from summary file', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), '[]');
      writeFileSync(join(dir, 'session-history.txt'), '');
      writeFileSync(join(dir, 'logs', 'session-1300.summary'),
        'Session: 1300\nDuration: ~4m30s\nTokens: 50000\n');

      const { json } = parseOutput(run(dir, 1300).stdout);
      assert.strictEqual(json.total_seconds, 270);
      assert.strictEqual(json.duration_str, '4m30s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns -1 when no summary exists', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), '[]');
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { json } = parseOutput(run(dir, 1400).stdout);
      assert.strictEqual(json.total_seconds, -1);
      assert.strictEqual(json.duration_str, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- E COUNT ----

describe('e-posthook-parser: session counting', () => {
  test('counts E sessions from history', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), '[]');
      writeFileSync(join(dir, 'session-history.txt'), [
        '2026-03-01 mode=E s=90 dur=4m cost=$1.00 note: E1',
        '2026-03-02 mode=B s=91 dur=3m cost=$0.80 note: B1',
        '2026-03-03 mode=E s=92 dur=5m cost=$1.20 note: E2',
        '2026-03-04 mode=E s=93 dur=4m cost=$0.90 note: E3',
      ].join('\n'));

      const { json, vars } = parseOutput(run(dir, 1500).stdout);
      assert.strictEqual(json.e_count, 3);
      assert.strictEqual(vars.E_COUNT, '3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- QUALITY SCORES ----

describe('e-posthook-parser: quality scores', () => {
  test('aggregates quality scores for current session', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), '[]');
      writeFileSync(join(dir, 'session-history.txt'), '');
      writeFileSync(join(dir, 'logs', 'quality-scores.jsonl'), [
        JSON.stringify({ session: 1600, verdict: 'PASS', check: 'cred' }),
        JSON.stringify({ session: 1600, verdict: 'FAIL', check: 'novelty' }),
        JSON.stringify({ session: 1600, verdict: 'WARN', check: 'depth' }),
        JSON.stringify({ session: 1599, verdict: 'FAIL', check: 'cred' }),  // different session
      ].join('\n'));

      const { json } = parseOutput(run(dir, 1600).stdout);
      assert.strictEqual(json.quality_session_total, 3);
      assert.strictEqual(json.quality_session_fails, 1);
      assert.strictEqual(json.quality_session_warns, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- TRACE INTEL EXTRACTION ----

describe('e-posthook-parser: trace intel extraction', () => {
  test('generates trace-based intel when intel_count is 0 and topics exist', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), '[]');
      writeFileSync(join(dir, 'engagement-trace.json'), JSON.stringify([{
        session: 1700,
        platforms_engaged: ['moltchan'],
        topics: ['hook consolidation'],
        agents_interacted: ['HazelBot'],
      }]));
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { json } = parseOutput(run(dir, 1700).stdout);
      assert.ok(json.trace_intel_data);
      assert.strictEqual(json.trace_intel_data.type, 'pattern');
      assert.ok(json.trace_intel_data.summary.includes('moltchan'));
      assert.ok(json.trace_intel_data.summary.includes('hook consolidation'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no trace intel when intel_count > 0', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'engagement-intel.json'), JSON.stringify([
        { session: 1800, platform: 'chatr', learned: 'something' },
      ]));
      writeFileSync(join(dir, 'engagement-trace.json'), JSON.stringify([{
        session: 1800,
        platforms_engaged: ['chatr'],
        topics: ['agent design'],
        agents_interacted: [],
      }]));
      writeFileSync(join(dir, 'session-history.txt'), '');

      const { json } = parseOutput(run(dir, 1800).stdout);
      assert.strictEqual(json.trace_intel_data, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

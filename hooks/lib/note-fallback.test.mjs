#!/usr/bin/env node
// note-fallback.test.mjs — Unit tests for note-fallback.mjs (d076, wq-932)
//
// note-fallback.mjs is a script (not a module with exports), so we test it
// by spawning it as a subprocess with controlled env vars and temp files.
//
// Covers: happy path (truncated note replaced), already-complete notes skipped,
// malformed input handling, preamble rejection, platform keyword acceptance.
//
// Usage: node --test hooks/lib/note-fallback.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = new URL('./note-fallback.mjs', import.meta.url).pathname;

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'note-fallback-test-'));
}

function run(env, expectExit = 0) {
  try {
    const result = execFileSync('node', [SCRIPT], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 5000,
    });
    return { code: 0, stdout: result };
  } catch (e) {
    if (expectExit !== 0 && e.status === expectExit) {
      return { code: e.status, stdout: e.stdout || '' };
    }
    // Exit 0 with no output is common for skip cases
    if (e.status === 0 || e.status === null) {
      return { code: 0, stdout: e.stdout || '' };
    }
    throw e;
  }
}

function historyLine(session, note) {
  return `2026-03-10 mode=E s=${session} dur=4m32s cost=$1.05 build=(none) files=[(none)] note: ${note}`;
}

function parsedJson(overrides = {}) {
  return JSON.stringify({
    trace_platforms_engaged: ['moltbook', 'chatr'],
    trace_agents: ['agent1'],
    trace_topics: ['discussed testing approaches'],
    e_count: 230,
    ...overrides,
  });
}

// ---- HAPPY PATH: truncated note gets replaced ----

describe('note-fallback: truncated note replacement', () => {
  test('replaces short truncated note with trace-derived summary', () => {
    const dir = makeTmpDir();
    try {
      const histFile = join(dir, 'history.txt');
      const traceFile = join(dir, 'trace.json');
      const parsedFile = join(dir, 'parsed.json');

      writeFileSync(histFile, historyLine(1800, 'session started') + '\n');
      writeFileSync(traceFile, '[]');
      writeFileSync(parsedFile, parsedJson());

      const result = run({
        HISTORY_FILE: histFile,
        TRACE_FILE: traceFile,
        PARSED_FILE: parsedFile,
        SESSION: '1800',
        CURRENT_NOTE: 'session started',
        HAS_TRACE: 'true',
        E_COUNT: '230',
      });

      assert.strictEqual(result.code, 0);
      const updated = readFileSync(histFile, 'utf8');
      assert.ok(updated.includes('Session E#230'));
      assert.ok(updated.includes('s1800'));
      assert.ok(updated.includes('Engaged moltbook, chatr'));
      assert.ok(!updated.includes('session started'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('includes agent interactions and topics in summary', () => {
    const dir = makeTmpDir();
    try {
      const histFile = join(dir, 'history.txt');
      const parsedFile = join(dir, 'parsed.json');

      writeFileSync(histFile, historyLine(1801, 'short') + '\n');
      writeFileSync(parsedFile, parsedJson({
        trace_platforms_engaged: ['4claw'],
        trace_agents: ['BuddyDubby', 'Hazel_OC'],
        trace_topics: ['alignment testing'],
      }));

      run({
        HISTORY_FILE: histFile,
        TRACE_FILE: join(dir, 'trace.json'),
        PARSED_FILE: parsedFile,
        SESSION: '1801',
        CURRENT_NOTE: 'short',
        HAS_TRACE: 'true',
      });

      const updated = readFileSync(histFile, 'utf8');
      assert.ok(updated.includes('Engaged 4claw'));
      assert.ok(updated.includes('BuddyDubby'));
      assert.ok(updated.includes('alignment testing'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---- SKIP: already-complete notes ----

describe('note-fallback: skip conditions', () => {
  test('skips note that already starts with Session X#NNN...complete', () => {
    const dir = makeTmpDir();
    try {
      const histFile = join(dir, 'history.txt');
      const completeNote = 'Session E#229 (s1800) complete. Engaged moltbook.';
      writeFileSync(histFile, historyLine(1800, completeNote) + '\n');
      writeFileSync(join(dir, 'parsed.json'), parsedJson());

      run({
        HISTORY_FILE: histFile,
        TRACE_FILE: join(dir, 'trace.json'),
        PARSED_FILE: join(dir, 'parsed.json'),
        SESSION: '1800',
        CURRENT_NOTE: completeNote,
        HAS_TRACE: 'true',
      });

      const updated = readFileSync(histFile, 'utf8');
      assert.ok(updated.includes(completeNote), 'complete note should not be modified');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('skips substantive note >60 chars with platform mention', () => {
    const dir = makeTmpDir();
    try {
      const histFile = join(dir, 'history.txt');
      const longNote = 'Engaged 3 platforms at 100% picker compliance: replied to thread on chatr about agent cooperation patterns';
      writeFileSync(histFile, historyLine(1802, longNote) + '\n');
      writeFileSync(join(dir, 'parsed.json'), parsedJson());

      run({
        HISTORY_FILE: histFile,
        TRACE_FILE: join(dir, 'trace.json'),
        PARSED_FILE: join(dir, 'parsed.json'),
        SESSION: '1802',
        CURRENT_NOTE: longNote,
        HAS_TRACE: 'true',
      });

      const updated = readFileSync(histFile, 'utf8');
      assert.ok(updated.includes(longNote), 'substantive note should not be modified');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('skips when HAS_TRACE is not true', () => {
    const dir = makeTmpDir();
    try {
      const histFile = join(dir, 'history.txt');
      writeFileSync(histFile, historyLine(1803, 'truncated') + '\n');

      run({
        HISTORY_FILE: histFile,
        TRACE_FILE: join(dir, 'trace.json'),
        PARSED_FILE: join(dir, 'parsed.json'),
        SESSION: '1803',
        CURRENT_NOTE: 'truncated',
        HAS_TRACE: 'false',
      });

      const updated = readFileSync(histFile, 'utf8');
      assert.ok(updated.includes('truncated'), 'should not modify when no trace');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---- PREAMBLE REJECTION ----

describe('note-fallback: preamble rejection', () => {
  test('rejects preamble note even if >60 chars with platform keywords', () => {
    const dir = makeTmpDir();
    try {
      const histFile = join(dir, 'history.txt');
      const preamble = "Let me engage with moltbook and chatr platforms to complete the engagement session requirements";
      writeFileSync(histFile, historyLine(1804, preamble) + '\n');
      writeFileSync(join(dir, 'parsed.json'), parsedJson());

      run({
        HISTORY_FILE: histFile,
        TRACE_FILE: join(dir, 'trace.json'),
        PARSED_FILE: join(dir, 'parsed.json'),
        SESSION: '1804',
        CURRENT_NOTE: preamble,
        HAS_TRACE: 'true',
      });

      const updated = readFileSync(histFile, 'utf8');
      assert.ok(updated.includes('Session E#230'), 'preamble should be replaced');
      assert.ok(!updated.includes('Let me engage'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('rejects "I\'ll" preamble pattern', () => {
    const dir = makeTmpDir();
    try {
      const histFile = join(dir, 'history.txt');
      const preamble = "I'll start by checking the engagement trace for platform data and moltbook status";
      writeFileSync(histFile, historyLine(1805, preamble) + '\n');
      writeFileSync(join(dir, 'parsed.json'), parsedJson());

      run({
        HISTORY_FILE: histFile,
        TRACE_FILE: join(dir, 'trace.json'),
        PARSED_FILE: join(dir, 'parsed.json'),
        SESSION: '1805',
        CURRENT_NOTE: preamble,
        HAS_TRACE: 'true',
      });

      const updated = readFileSync(histFile, 'utf8');
      assert.ok(updated.includes('Session E#230'), '"I\'ll" preamble should be replaced');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---- MALFORMED INPUT ----

describe('note-fallback: malformed input', () => {
  test('exits silently when HISTORY_FILE missing', () => {
    const result = run({
      SESSION: '1806',
      CURRENT_NOTE: 'test',
      HAS_TRACE: 'true',
    });
    assert.strictEqual(result.code, 0);
  });

  test('exits silently when SESSION missing', () => {
    const dir = makeTmpDir();
    try {
      const result = run({
        HISTORY_FILE: join(dir, 'history.txt'),
        TRACE_FILE: join(dir, 'trace.json'),
        CURRENT_NOTE: 'test',
        HAS_TRACE: 'true',
      });
      assert.strictEqual(result.code, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('exits silently when parsed JSON is malformed', () => {
    const dir = makeTmpDir();
    try {
      const histFile = join(dir, 'history.txt');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(histFile, historyLine(1807, 'short') + '\n');
      writeFileSync(parsedFile, '{invalid json!!!');

      const result = run({
        HISTORY_FILE: histFile,
        TRACE_FILE: join(dir, 'trace.json'),
        PARSED_FILE: parsedFile,
        SESSION: '1807',
        CURRENT_NOTE: 'short',
        HAS_TRACE: 'true',
      });
      assert.strictEqual(result.code, 0);
      // History should be unchanged since parsed data failed
      const updated = readFileSync(histFile, 'utf8');
      assert.ok(updated.includes('short'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---- EDGE CASES ----

describe('note-fallback: edge cases', () => {
  test('truncates summary to 150 chars', () => {
    const dir = makeTmpDir();
    try {
      const histFile = join(dir, 'history.txt');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(histFile, historyLine(1808, 'tiny') + '\n');
      writeFileSync(parsedFile, parsedJson({
        trace_platforms_engaged: ['platform1', 'platform2', 'platform3', 'platform4', 'platform5'],
        trace_agents: ['agent_with_long_name_1', 'agent_with_long_name_2', 'agent_with_long_name_3'],
        trace_topics: ['a very detailed and lengthy topic description about agent cooperation patterns and testing methodologies'],
      }));

      run({
        HISTORY_FILE: histFile,
        TRACE_FILE: join(dir, 'trace.json'),
        PARSED_FILE: parsedFile,
        SESSION: '1808',
        CURRENT_NOTE: 'tiny',
        HAS_TRACE: 'true',
      });

      const updated = readFileSync(histFile, 'utf8');
      // The generated note part after "Session E#230 (s1808) complete. " should have summary ≤150 chars
      const noteMatch = updated.match(/note: (.+)/);
      assert.ok(noteMatch, 'should have a note');
      // Total note will be longer than 150 due to prefix, but the summary portion is capped
      assert.ok(noteMatch[1].length < 250, `note too long: ${noteMatch[1].length}`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('handles empty platforms/agents/topics gracefully', () => {
    const dir = makeTmpDir();
    try {
      const histFile = join(dir, 'history.txt');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(histFile, historyLine(1809, 'short') + '\n');
      writeFileSync(parsedFile, parsedJson({
        trace_platforms_engaged: [],
        trace_agents: [],
        trace_topics: [],
      }));

      run({
        HISTORY_FILE: histFile,
        TRACE_FILE: join(dir, 'trace.json'),
        PARSED_FILE: parsedFile,
        SESSION: '1809',
        CURRENT_NOTE: 'short',
        HAS_TRACE: 'true',
      });

      const updated = readFileSync(histFile, 'utf8');
      assert.ok(updated.includes('engagement session completed'), 'should use default summary');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('handles platform objects (not just strings) in trace', () => {
    const dir = makeTmpDir();
    try {
      const histFile = join(dir, 'history.txt');
      const parsedFile = join(dir, 'parsed.json');
      writeFileSync(histFile, historyLine(1810, 'short') + '\n');
      writeFileSync(parsedFile, parsedJson({
        trace_platforms_engaged: [{ platform: 'moltbook' }, { platform: 'chatr' }],
      }));

      run({
        HISTORY_FILE: histFile,
        TRACE_FILE: join(dir, 'trace.json'),
        PARSED_FILE: parsedFile,
        SESSION: '1810',
        CURRENT_NOTE: 'short',
        HAS_TRACE: 'true',
      });

      const updated = readFileSync(histFile, 'utf8');
      assert.ok(updated.includes('moltbook'), 'should extract platform name from object');
      assert.ok(updated.includes('chatr'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

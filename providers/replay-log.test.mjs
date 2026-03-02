// Tests for providers/replay-log.js — HTTP replay logging and analysis (wq-778, d071)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_HOME = '/tmp/replay-log-test-' + Date.now();
const TEST_CONFIG = join(TEST_HOME, '.config', 'moltbook');
const LOG_PATH = join(TEST_CONFIG, 'replay-log.jsonl');

// Set HOME and SESSION_NUM before import
process.env.HOME = TEST_HOME;
process.env.SESSION_NUM = '9999';

function setup() {
  mkdirSync(TEST_CONFIG, { recursive: true });
}

function cleanup() {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ }
}

// Import after setting HOME
const mod = await import('./replay-log.js');
const { installReplayLog, getSessionReplayCalls, getReplayLogPath, analyzeReplayLog } = mod;

describe('providers/replay-log.js', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  describe('getReplayLogPath', () => {
    it('returns path in .config/moltbook/', () => {
      const p = getReplayLogPath();
      assert.ok(p.includes('.config/moltbook/replay-log.jsonl'));
    });
  });

  describe('analyzeReplayLog', () => {
    it('returns error when no log exists', () => {
      const result = analyzeReplayLog();
      assert.ok(result.error);
    });

    it('returns error for empty log', () => {
      writeFileSync(LOG_PATH, '');
      const result = analyzeReplayLog();
      assert.ok(result.error);
    });

    it('parses entries and produces per-platform summary', () => {
      const entries = [
        { t: '2026-03-01T10:00:00Z', s: 100, p: 'moltbook', m: 'GET', url: '/api/posts', st: 200, ms: 50 },
        { t: '2026-03-01T10:01:00Z', s: 100, p: 'moltbook', m: 'POST', url: '/api/comment', st: 201, ms: 80 },
        { t: '2026-03-01T10:02:00Z', s: 100, p: 'chatr', m: 'GET', url: '/messages', st: 200, ms: 30 },
        { t: '2026-03-01T10:03:00Z', s: 100, p: 'moltbook', m: 'GET', url: '/api/posts', st: 500, ms: 100 },
      ];
      writeFileSync(LOG_PATH, entries.map(e => JSON.stringify(e)).join('\n'));

      const result = analyzeReplayLog();
      assert.strictEqual(result.totalEntries, 4);
      assert.ok(result.sessionRange);
      assert.strictEqual(result.sessionRange.first, 100);

      const mb = result.platforms.find(p => p.platform === 'moltbook');
      assert.ok(mb);
      assert.strictEqual(mb.calls, 3);
      assert.strictEqual(mb.errors, 1); // 500 status counts as error
      assert.ok(mb.avgMs > 0);
      assert.ok(mb.methods['GET'] === 2);
      assert.ok(mb.methods['POST'] === 1);
    });

    it('filters by session when sessionFilter is set', () => {
      const entries = [
        { t: '2026-03-01T10:00:00Z', s: 100, p: 'moltbook', m: 'GET', url: '/api', st: 200, ms: 50 },
        { t: '2026-03-01T10:01:00Z', s: 200, p: 'moltbook', m: 'GET', url: '/api', st: 200, ms: 30 },
      ];
      writeFileSync(LOG_PATH, entries.map(e => JSON.stringify(e)).join('\n'));

      const result = analyzeReplayLog({ sessionFilter: 100 });
      assert.strictEqual(result.totalEntries, 1);
    });

    it('respects lastN parameter', () => {
      const entries = [];
      for (let i = 0; i < 10; i++) {
        entries.push({ t: '2026-03-01T10:00:00Z', s: 100, p: 'moltbook', m: 'GET', url: '/api', st: 200, ms: 10 });
      }
      writeFileSync(LOG_PATH, entries.map(e => JSON.stringify(e)).join('\n'));

      const result = analyzeReplayLog({ lastN: 3 });
      assert.strictEqual(result.totalEntries, 3);
    });

    it('counts error entries (err field)', () => {
      const entries = [
        { t: '2026-03-01T10:00:00Z', s: 100, p: 'chatr', m: 'GET', url: '/api', st: 0, ms: 1000, err: 'ECONNREFUSED' },
      ];
      writeFileSync(LOG_PATH, entries.map(e => JSON.stringify(e)).join('\n'));

      const result = analyzeReplayLog();
      const ch = result.platforms.find(p => p.platform === 'chatr');
      assert.strictEqual(ch.errors, 1);
      assert.strictEqual(ch.errorRate, 100);
    });

    it('handles malformed JSON lines gracefully', () => {
      writeFileSync(LOG_PATH, '{"s":1,"p":"x","m":"GET","url":"/","st":200,"ms":10}\nnot-json\n{"s":2,"p":"y","m":"GET","url":"/","st":200,"ms":10}');
      const result = analyzeReplayLog();
      assert.strictEqual(result.totalEntries, 2);
    });
  });

  describe('installReplayLog', () => {
    it('monkey-patches global fetch', () => {
      const origFetch = globalThis.fetch;
      installReplayLog();
      assert.notStrictEqual(globalThis.fetch, origFetch);
      // Restore
      globalThis.fetch = origFetch;
    });
  });

  describe('getSessionReplayCalls', () => {
    it('returns an array', () => {
      const calls = getSessionReplayCalls();
      assert.ok(Array.isArray(calls));
    });
  });
});

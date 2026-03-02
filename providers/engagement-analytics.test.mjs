// Tests for providers/engagement-analytics.js — engagement replay analytics (wq-778, d071)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const TEST_HOME = '/tmp/engagement-analytics-test-' + Date.now();
const TEST_CONFIG = join(TEST_HOME, '.config', 'moltbook');

// Set HOME before import so module resolves paths correctly
process.env.HOME = TEST_HOME;

function setup() {
  mkdirSync(TEST_CONFIG, { recursive: true });
}

function cleanup() {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ }
}

// Module reads file paths at call time, so we can set up files before each call
const { analyzeEngagement } = await import('./engagement-analytics.js');

describe('providers/engagement-analytics.js', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  describe('analyzeEngagement', () => {
    it('returns baseline structure with empty data', () => {
      // No log files exist
      const result = analyzeEngagement();
      assert.strictEqual(result.data_sources.http_log_entries, 0);
      assert.strictEqual(result.data_sources.tool_log_entries, 0);
      assert.strictEqual(result.e_session_summary.count, 0);
      assert.ok(Array.isArray(result.platforms));
      assert.ok(result.diversity);
      assert.ok(typeof result.insight === 'string');
    });

    it('aggregates HTTP replay log entries by platform', () => {
      // Create replay-log.jsonl
      const entries = [
        { t: '2026-03-01T10:00:00Z', s: 100, p: 'moltbook', m: 'GET', url: '/api/posts', st: 200, ms: 50 },
        { t: '2026-03-01T10:01:00Z', s: 100, p: 'moltbook', m: 'POST', url: '/api/comments', st: 201, ms: 80 },
        { t: '2026-03-01T10:02:00Z', s: 100, p: 'chatr', m: 'GET', url: '/messages', st: 200, ms: 30 },
      ];
      writeFileSync(join(TEST_CONFIG, 'replay-log.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'));

      // Create session-history.txt with E session
      writeFileSync(join(TEST_CONFIG, 'session-history.txt'),
        '2026-03-01 mode=E s=100 dur=5m00s cost=$1.50 build=(none) files=[(none)] note: test\n');

      // Empty engagement-replay
      writeFileSync(join(TEST_CONFIG, 'engagement-replay.jsonl'), '');

      const result = analyzeEngagement();
      assert.strictEqual(result.data_sources.http_log_entries, 3);
      assert.ok(result.platforms.length >= 2);

      const mb = result.platforms.find(p => p.platform === 'moltbook');
      assert.ok(mb);
      assert.strictEqual(mb.total_calls, 2);
      assert.strictEqual(mb.writes, 1); // POST counts as write
      assert.strictEqual(mb.reads, 1);
    });

    it('aggregates tool log entries by platform', () => {
      // Create engagement-replay.jsonl with tool calls
      const toolEntries = [
        { s: 200, tool: 'moltbook_post' },
        { s: 200, tool: 'moltbook_search' },
        { s: 200, tool: 'chatr_send' },
        { s: 200, tool: 'chatr_read' },
      ];
      writeFileSync(join(TEST_CONFIG, 'engagement-replay.jsonl'),
        toolEntries.map(e => JSON.stringify(e)).join('\n'));
      writeFileSync(join(TEST_CONFIG, 'replay-log.jsonl'), '');
      writeFileSync(join(TEST_CONFIG, 'session-history.txt'),
        '2026-03-01 mode=E s=200 dur=5m00s cost=$1.00 build=(none) files=[(none)] note: test\n');

      const result = analyzeEngagement();
      assert.strictEqual(result.data_sources.tool_log_entries, 4);

      const mb = result.platforms.find(p => p.platform === 'moltbook');
      assert.ok(mb);
      assert.strictEqual(mb.total_calls, 2);
      // moltbook_post contains "post" which matches isWriteAction's check
      assert.strictEqual(mb.writes, 1);

      const ch = result.platforms.find(p => p.platform === 'chatr');
      assert.ok(ch);
      assert.strictEqual(ch.writes, 1); // chatr_send contains "send"
    });

    it('computes diversity metrics correctly', () => {
      // Create data with one dominant platform
      const entries = [];
      for (let i = 0; i < 10; i++) {
        entries.push({ t: '2026-03-01T10:00:00Z', s: 300, p: 'moltbook', m: 'POST', url: '/api', st: 200, ms: 10 });
      }
      entries.push({ t: '2026-03-01T10:00:00Z', s: 300, p: 'chatr', m: 'POST', url: '/msg', st: 200, ms: 10 });

      writeFileSync(join(TEST_CONFIG, 'replay-log.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'));
      writeFileSync(join(TEST_CONFIG, 'engagement-replay.jsonl'), '');
      writeFileSync(join(TEST_CONFIG, 'session-history.txt'),
        '2026-03-01 mode=E s=300 dur=5m00s cost=$2.00 build=(none) files=[(none)] note: test\n');

      const result = analyzeEngagement();
      assert.ok(result.diversity.top1_pct > 50, 'moltbook should dominate');
      assert.ok(result.diversity.warning, 'Should warn about over-concentration');
      assert.ok(result.diversity.warning.includes('moltbook'));
    });

    it('only counts E sessions for cost allocation', () => {
      // B session should not contribute to e_session_summary
      const entries = [
        { t: '2026-03-01T10:00:00Z', s: 400, p: 'moltbook', m: 'GET', url: '/api', st: 200, ms: 10 },
      ];
      writeFileSync(join(TEST_CONFIG, 'replay-log.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'));
      writeFileSync(join(TEST_CONFIG, 'engagement-replay.jsonl'), '');
      writeFileSync(join(TEST_CONFIG, 'session-history.txt'),
        '2026-03-01 mode=B s=400 dur=5m00s cost=$2.00 build=1 commit(s) files=[test.js] note: test\n');

      const result = analyzeEngagement();
      assert.strictEqual(result.e_session_summary.count, 0);
      const mb = result.platforms.find(p => p.platform === 'moltbook');
      assert.ok(mb);
      assert.strictEqual(mb.e_sessions, 0);
      assert.strictEqual(mb.e_cost_allocated, 0);
    });

    it('returns insight string', () => {
      writeFileSync(join(TEST_CONFIG, 'replay-log.jsonl'),
        JSON.stringify({ t: '2026-03-01T10:00:00Z', s: 500, p: 'moltbook', m: 'POST', url: '/api', st: 200, ms: 10 }));
      writeFileSync(join(TEST_CONFIG, 'engagement-replay.jsonl'), '');
      writeFileSync(join(TEST_CONFIG, 'session-history.txt'),
        '2026-03-01 mode=E s=500 dur=3m00s cost=$1.00 build=(none) files=[(none)] note: test\n');

      const result = analyzeEngagement();
      assert.ok(result.insight.includes('moltbook'));
    });
  });
});

// Tests for providers/chatr-digest.js — chatr snapshot summarizer (wq-778, d071)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const TEST_HOME = '/tmp/chatr-digest-test-' + Date.now();
const SNAP_DIR = join(TEST_HOME, '.config', 'moltbook', 'chatr-snapshots');

// Set HOME before import
process.env.HOME = TEST_HOME;

function setup() {
  mkdirSync(SNAP_DIR, { recursive: true });
}

function cleanup() {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ }
}

const { summarizeChatr } = await import('./chatr-digest.js');

describe('providers/chatr-digest.js', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  describe('summarizeChatr', () => {
    it('returns error structure when no snapshots exist', () => {
      // Empty SNAP_DIR
      const result = summarizeChatr();
      assert.ok(result.error);
      assert.deepStrictEqual(result.agents, []);
      assert.deepStrictEqual(result.topics, []);
      assert.strictEqual(result.summary, 'No data');
    });

    it('returns error when snapshot dir does not exist', () => {
      rmSync(SNAP_DIR, { recursive: true, force: true });
      const result = summarizeChatr();
      assert.ok(result.error);
    });

    it('aggregates messages from multiple snapshots', () => {
      writeFileSync(join(SNAP_DIR, 'digest-20260301-100000.json'), JSON.stringify({
        messages: [
          { id: 'msg1', agent: 'alice', score: 5, content: 'Hello world', time: '2026-03-01T10:00:00Z' },
          { id: 'msg2', agent: 'bob', score: 3, content: 'Testing', time: '2026-03-01T10:01:00Z' },
        ]
      }));
      writeFileSync(join(SNAP_DIR, 'digest-20260301-110000.json'), JSON.stringify({
        messages: [
          { id: 'msg2', agent: 'bob', score: 3, content: 'Testing', time: '2026-03-01T10:01:00Z' }, // duplicate
          { id: 'msg3', agent: 'alice', score: 7, content: 'Important update', time: '2026-03-01T11:00:00Z' },
        ]
      }));

      const result = summarizeChatr();
      assert.strictEqual(result.snapshots_analyzed, 2);
      assert.strictEqual(result.unique_messages, 3); // deduped by id
      assert.strictEqual(result.unique_agents, 2);
    });

    it('ranks agents by average score', () => {
      writeFileSync(join(SNAP_DIR, 'digest-20260301-100000.json'), JSON.stringify({
        messages: [
          { id: 'm1', agent: 'high-scorer', score: 8, content: 'Good stuff', time: '2026-03-01T10:00:00Z' },
          { id: 'm2', agent: 'high-scorer', score: 6, content: 'More good stuff', time: '2026-03-01T10:01:00Z' },
          { id: 'm3', agent: 'low-scorer', score: 1, content: 'Spam', time: '2026-03-01T10:02:00Z' },
        ]
      }));

      const result = summarizeChatr();
      assert.ok(result.agents.length === 2);
      assert.strictEqual(result.agents[0].agent, 'high-scorer');
      assert.ok(result.agents[0].avgScore > result.agents[1].avgScore);
    });

    it('identifies high-signal messages (score >= 4)', () => {
      writeFileSync(join(SNAP_DIR, 'digest-20260301-100000.json'), JSON.stringify({
        messages: [
          { id: 'm1', agent: 'a', score: 8, content: 'High signal', time: '2026-03-01T10:00:00Z' },
          { id: 'm2', agent: 'b', score: 2, content: 'Low signal', time: '2026-03-01T10:01:00Z' },
          { id: 'm3', agent: 'c', score: 5, content: 'Medium signal', time: '2026-03-01T10:02:00Z' },
        ]
      }));

      const result = summarizeChatr();
      assert.strictEqual(result.high_signal.length, 2);
      assert.strictEqual(result.high_signal[0].score, 8); // sorted by score desc
      assert.strictEqual(result.high_signal[1].score, 5);
    });

    it('detects spam patterns (repeated content > 2 times)', () => {
      const msgs = [];
      for (let i = 0; i < 5; i++) {
        msgs.push({ id: `spam${i}`, agent: 'spammer', score: 1, content: 'Buy tokens now!', time: '2026-03-01T10:00:00Z' });
      }
      msgs.push({ id: 'legit', agent: 'real', score: 6, content: 'Unique message', time: '2026-03-01T10:01:00Z' });

      writeFileSync(join(SNAP_DIR, 'digest-20260301-100000.json'), JSON.stringify({ messages: msgs }));

      const result = summarizeChatr();
      assert.ok(result.spam_patterns.length > 0);
      assert.ok(result.spam_patterns[0].count >= 3);
    });

    it('computes time range from messages', () => {
      writeFileSync(join(SNAP_DIR, 'digest-20260301-100000.json'), JSON.stringify({
        messages: [
          { id: 'm1', agent: 'a', score: 5, content: 'First', time: '2026-03-01T08:00:00Z' },
          { id: 'm2', agent: 'b', score: 5, content: 'Last', time: '2026-03-01T12:00:00Z' },
        ]
      }));

      const result = summarizeChatr();
      assert.ok(result.time_range);
      assert.strictEqual(result.time_range.earliest, '2026-03-01T08:00:00Z');
      assert.strictEqual(result.time_range.latest, '2026-03-01T12:00:00Z');
    });

    it('respects maxSnapshots option', () => {
      // Create 5 snapshots
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(SNAP_DIR, `digest-20260301-${String(i).padStart(6, '0')}.json`), JSON.stringify({
          messages: [{ id: `m${i}`, agent: 'a', score: 5, content: `Msg ${i}`, time: '2026-03-01T10:00:00Z' }]
        }));
      }

      const result = summarizeChatr({ maxSnapshots: 2 });
      assert.strictEqual(result.snapshots_analyzed, 2);
    });

    it('generates summary string', () => {
      writeFileSync(join(SNAP_DIR, 'digest-20260301-100000.json'), JSON.stringify({
        messages: [
          { id: 'm1', agent: 'alice', score: 5, content: 'Hello', time: '2026-03-01T10:00:00Z' },
        ]
      }));

      const result = summarizeChatr();
      assert.ok(typeof result.summary === 'string');
      assert.ok(result.summary.includes('alice'));
      assert.ok(result.summary.includes('1 messages'));
    });

    it('ignores non-digest files in snapshot dir', () => {
      writeFileSync(join(SNAP_DIR, 'random-file.json'), '{}');
      writeFileSync(join(SNAP_DIR, 'digest-20260301-100000.json'), JSON.stringify({
        messages: [{ id: 'm1', agent: 'a', score: 5, content: 'Test', time: '2026-03-01T10:00:00Z' }]
      }));

      const result = summarizeChatr();
      assert.strictEqual(result.snapshots_analyzed, 1);
    });

    it('handles malformed snapshot files gracefully', () => {
      writeFileSync(join(SNAP_DIR, 'digest-20260301-100000.json'), 'not-json');
      writeFileSync(join(SNAP_DIR, 'digest-20260301-110000.json'), JSON.stringify({
        messages: [{ id: 'm1', agent: 'a', score: 5, content: 'Test', time: '2026-03-01T10:00:00Z' }]
      }));

      const result = summarizeChatr();
      assert.strictEqual(result.snapshots_analyzed, 1); // malformed one is filtered
    });
  });
});

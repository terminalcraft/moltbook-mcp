/**
 * Tests for providers/engagement-scorer.js (wq-646)
 * Covers: scoreThread signal/novelty/anchor scoring, scoreTrace session-level
 * scoring with diversity bonuses, scoreAllTraces file I/O and multi-session scoring.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scoreThread, scoreTrace, scoreAllTraces } from './providers/engagement-scorer.js';

// --- scoreThread tests ---

describe('scoreThread', () => {
  it('scores a post higher than a read', () => {
    const post = scoreThread({ action: 'post', topic: 'Test topic', platform: 'moltbook' });
    const read = scoreThread({ action: 'read', topic: 'Test topic', platform: 'moltbook' });
    assert.ok(post.scores.signal > read.scores.signal);
  });

  it('returns all three score axes plus combined', () => {
    const result = scoreThread({ action: 'reply', topic: 'Some discussion', platform: 'chatr' });
    assert.ok('signal' in result.scores);
    assert.ok('novelty' in result.scores);
    assert.ok('anchor' in result.scores);
    assert.ok('combined' in result.scores);
  });

  it('scores are clamped between 0 and 1', () => {
    const result = scoreThread({
      action: 'post',
      topic: 'A very long and detailed topic with lots of specific data points like 42 metrics and protocol references to the API tool scoring rate count pattern',
      platform: 'test'
    });
    for (const axis of ['signal', 'novelty', 'anchor', 'combined']) {
      assert.ok(result.scores[axis] >= 0, `${axis} >= 0`);
      assert.ok(result.scores[axis] <= 1, `${axis} <= 1`);
    }
  });

  it('reduces novelty for repeated topics', () => {
    const fresh = scoreThread(
      { action: 'post', topic: 'Brand new unique discussion', platform: 'test' },
      { recentTopics: ['Completely different topic about cooking'] }
    );
    const repeated = scoreThread(
      { action: 'post', topic: 'Brand new unique discussion', platform: 'test' },
      { recentTopics: ['Brand new unique discussion from last session'] }
    );
    assert.ok(fresh.scores.novelty > repeated.scores.novelty);
  });

  it('boosts anchor for @mentions', () => {
    const withMention = scoreThread({ action: 'reply', topic: 'Replied to @someagent about testing', platform: 'test' });
    const noMention = scoreThread({ action: 'reply', topic: 'Replied about testing in general', platform: 'test' });
    assert.ok(withMention.scores.anchor > noMention.scores.anchor);
  });

  it('boosts signal for topics with numbers', () => {
    const withNum = scoreThread({ action: 'post', topic: 'Analyzed 42 patterns in session data', platform: 'test' });
    const noNum = scoreThread({ action: 'post', topic: 'Analyzed patterns in session data', platform: 'test' });
    assert.ok(withNum.scores.signal > noNum.scores.signal);
  });

  it('handles missing/empty fields gracefully', () => {
    const result = scoreThread({});
    assert.ok(result.scores.combined >= 0);
    const result2 = scoreThread({ action: null, topic: null });
    assert.ok(result2.scores.combined >= 0);
  });
});

// --- scoreTrace tests ---

describe('scoreTrace', () => {
  const baseTrace = {
    session: 100,
    date: '2026-01-01',
    threads_contributed: [
      { action: 'post', topic: 'Built new monitoring dashboard with 5 metrics', platform: 'moltbook' },
      { action: 'reply', topic: 'Discussed @cairn witness infrastructure patterns', platform: 'chatr' },
      { action: 'trade', topic: 'Traded on prediction market for IMO 2026', platform: 'agora' },
    ],
    topics: ['monitoring', 'witness infrastructure', 'prediction markets'],
    follow_ups: ['Check monitoring dashboard adoption', 'Follow up with cairn about patterns'],
  };

  it('adds quality_scores to trace', () => {
    const result = scoreTrace(baseTrace);
    assert.ok(result.quality_scores);
    assert.ok(result.quality_scores.session_score >= 0);
    assert.ok(result.quality_scores.threads.length === 3);
  });

  it('awards diversity bonus for multiple actions', () => {
    const diverse = scoreTrace(baseTrace);
    const uniform = scoreTrace({
      ...baseTrace,
      threads_contributed: [
        { action: 'read', topic: 'Read topic A', platform: 'moltbook' },
        { action: 'read', topic: 'Read topic B', platform: 'moltbook' },
      ]
    });
    assert.ok(diverse.quality_scores.action_diversity > uniform.quality_scores.action_diversity);
  });

  it('awards platform bonus for multi-platform engagement', () => {
    const result = scoreTrace(baseTrace);
    assert.equal(result.quality_scores.platform_diversity, 3);
  });

  it('handles trace without threads_contributed', () => {
    const result = scoreTrace({ session: 1, date: '2026-01-01' });
    assert.equal(result.quality_scores.session_score, 0);
    assert.deepEqual(result.quality_scores.threads, []);
  });

  it('handles null trace', () => {
    const result = scoreTrace(null);
    assert.equal(result.quality_scores.session_score, 0);
  });

  it('uses recent traces for novelty scoring', () => {
    const priorTraces = [{
      topics: ['Built new monitoring dashboard with 5 metrics'],
      threads_contributed: [{ topic: 'monitoring dashboard metrics' }]
    }];
    const result = scoreTrace(baseTrace, priorTraces);
    // First thread topic overlaps with prior trace, so novelty should be lower
    const firstThread = result.quality_scores.threads[0];
    assert.ok(firstThread.novelty < 0.8, 'Novelty reduced for repeated topic');
  });
});

// --- scoreAllTraces tests ---

describe('scoreAllTraces', () => {
  let SCRATCH;

  beforeEach(() => {
    SCRATCH = join(tmpdir(), `scorer-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(SCRATCH, { recursive: true });
  });

  it('scores traces from file and writes results', () => {
    const traces = [{
      session: 100,
      date: '2026-01-01',
      threads_contributed: [
        { action: 'post', topic: 'Test post', platform: 'test' }
      ],
      topics: ['Test post'],
      follow_ups: []
    }];
    writeFileSync(join(SCRATCH, 'engagement-trace.json'), JSON.stringify(traces));
    const result = scoreAllTraces(SCRATCH);
    assert.equal(result.sessions, 1);
    assert.ok(result.avg_score >= 0);
    assert.ok(result.output_path.endsWith('engagement-scores.json'));
    // Verify output file was written
    const output = JSON.parse(readFileSync(result.output_path, 'utf8'));
    assert.equal(output.version, 1);
    assert.equal(output.sessions.length, 1);
  });

  it('handles missing trace file', () => {
    const result = scoreAllTraces(SCRATCH);
    assert.ok(result.error);
    assert.equal(result.sessions, 0);
  });

  it('handles malformed JSON', () => {
    writeFileSync(join(SCRATCH, 'engagement-trace.json'), 'not json');
    const result = scoreAllTraces(SCRATCH);
    assert.ok(result.error);
    assert.equal(result.sessions, 0);
  });

  it('scores multiple sessions with novelty context', () => {
    const traces = [
      {
        session: 100, date: '2026-01-01',
        threads_contributed: [{ action: 'post', topic: 'Unique first topic', platform: 'a' }],
        topics: ['Unique first topic'], follow_ups: []
      },
      {
        session: 101, date: '2026-01-02',
        threads_contributed: [{ action: 'post', topic: 'Unique first topic repeated', platform: 'a' }],
        topics: ['Unique first topic repeated'], follow_ups: []
      },
    ];
    writeFileSync(join(SCRATCH, 'engagement-trace.json'), JSON.stringify(traces));
    const result = scoreAllTraces(SCRATCH);
    assert.equal(result.sessions, 2);
    // Second session should score lower on novelty (repeats first session topic)
    const output = JSON.parse(readFileSync(result.output_path, 'utf8'));
    const s1 = output.sessions[0].quality_scores;
    const s2 = output.sessions[1].quality_scores;
    // The second session thread should have reduced novelty
    assert.ok(s2.threads[0].novelty < s1.threads[0].novelty, 'Repeated topic gets lower novelty');
  });
});

#!/usr/bin/env node
// directive-analysis.test.mjs — Unit tests for directive-analysis.mjs (wq-968)
//
// Tests: staleness thresholds (3 tiers), maintenance needs detection,
// empty/malformed directive input, session extraction, formatting.
//
// Usage: node --test hooks/lib/directive-analysis.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  extractMaxSessionFromNotes,
  lookupTypeSession,
  getThresholds,
  analyzeDirectives,
  formatResults
} from './directive-analysis.mjs';

// ---- extractMaxSessionFromNotes ----
describe('extractMaxSessionFromNotes', () => {
  test('extracts direct session references (s1234)', () => {
    assert.strictEqual(extractMaxSessionFromNotes('completed s1500', []), 1500);
    assert.strictEqual(extractMaxSessionFromNotes('s1200 then s1400', []), 1400);
    assert.strictEqual(extractMaxSessionFromNotes('s=1800 data', []), 1800);
  });

  test('resolves type-session references via history lines', () => {
    const history = [
      '2026-03-01 mode=R s=1600 note: R#350 stuff',
      '2026-03-02 mode=A s=1610 note: A#200 audit',
      '2026-03-03 mode=B s=1620 note: B#400 build',
    ];
    assert.strictEqual(extractMaxSessionFromNotes('see R#350', history), 1600);
    assert.strictEqual(extractMaxSessionFromNotes('per A#200', history), 1610);
    assert.strictEqual(extractMaxSessionFromNotes('from B#400 and R#350', history), 1620);
  });

  test('returns 0 for null/empty notes', () => {
    assert.strictEqual(extractMaxSessionFromNotes(null, []), 0);
    assert.strictEqual(extractMaxSessionFromNotes('', []), 0);
    assert.strictEqual(extractMaxSessionFromNotes('no session refs here', []), 0);
  });

  test('picks highest when mixed direct and type refs', () => {
    const history = ['2026-03-01 mode=R s=1700 note: R#360'];
    assert.strictEqual(extractMaxSessionFromNotes('s1500 and R#360', history), 1700);
  });
});

// ---- lookupTypeSession ----
describe('lookupTypeSession', () => {
  test('finds matching line and extracts session number', () => {
    const lines = [
      '2026-01-01 mode=E s=1000 note: E#100 engaged',
      '2026-01-02 mode=R s=1010 note: R#200 reflected',
    ];
    assert.strictEqual(lookupTypeSession('E#100', lines), 1000);
    assert.strictEqual(lookupTypeSession('R#200', lines), 1010);
  });

  test('returns 0 when reference not found', () => {
    assert.strictEqual(lookupTypeSession('R#999', ['nothing here']), 0);
    assert.strictEqual(lookupTypeSession('A#50', []), 0);
  });

  test('returns last match when multiple lines contain the ref', () => {
    const lines = [
      '2026-01-01 mode=R s=1000 note: R#200 first',
      '2026-01-02 mode=R s=1050 note: R#200 second',
    ];
    // Searches from end, so finds s=1050 first
    assert.strictEqual(lookupTypeSession('R#200', lines), 1050);
  });
});

// ---- getThresholds ----
describe('getThresholds', () => {
  test('returns system tier for system directives', () => {
    const t = getThresholds({ from: 'system' });
    assert.deepStrictEqual(t, { stale: 60, needsUpdate: 40, type: 'system' });
  });

  test('returns scoped tier for directives with scope', () => {
    const t = getThresholds({ from: 'self', scope: 'E sessions' });
    assert.deepStrictEqual(t, { stale: 50, needsUpdate: 35, type: 'scoped' });
  });

  test('returns default tier for task-oriented directives', () => {
    const t = getThresholds({ from: 'self' });
    assert.deepStrictEqual(t, { stale: 30, needsUpdate: 20, type: 'default' });
  });

  test('ignores null/string-null scope', () => {
    assert.strictEqual(getThresholds({ scope: null }).type, 'default');
    assert.strictEqual(getThresholds({ scope: 'null' }).type, 'default');
  });
});

// ---- analyzeDirectives ----
describe('analyzeDirectives', () => {
  const baseParams = { sessionNum: 2000, queue: { queue: [] }, historyLines: [] };

  test('detects STALE directive (default tier, >30 sessions)', () => {
    const directives = {
      directives: [{
        id: 'd099', status: 'active', from: 'self',
        acked_session: '1960', content: 'Old task directive',
        notes: ''
      }]
    };

    const result = analyzeDirectives({ ...baseParams, directives });
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].status, 'STALE');
    assert.strictEqual(result.results[0].id, 'd099');
    assert.strictEqual(result.results[0].sessionsSince, 40);
    assert.strictEqual(result.needsAttention, 1);
  });

  test('detects STALE system directive (system tier, >60 sessions)', () => {
    const directives = {
      directives: [{
        id: 'd049', status: 'active', from: 'system',
        acked_session: '1930', content: 'System monitor',
        notes: ''
      }]
    };

    const result = analyzeDirectives({ ...baseParams, directives });
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].status, 'STALE');
    assert.strictEqual(result.results[0].threshold, 60);
  });

  test('detects NEEDS_UPDATE for default directive (>20 sessions, no queue item)', () => {
    const directives = {
      directives: [{
        id: 'd080', status: 'active', from: 'self',
        acked_session: '1975', content: 'Task without queue item',
        notes: ''
      }]
    };

    const result = analyzeDirectives({ ...baseParams, directives });
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].status, 'NEEDS_UPDATE');
    assert.strictEqual(result.results[0].reason, 'no queue item');
  });

  test('detects NEEDS_UPDATE for scoped directive (>35 sessions)', () => {
    const directives = {
      directives: [{
        id: 'd055', status: 'active', from: 'self', scope: 'E sessions',
        acked_session: '1960', content: 'Scoped behavioral rule',
        notes: ''
      }]
    };

    const result = analyzeDirectives({ ...baseParams, directives });
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].status, 'NEEDS_UPDATE');
    assert.strictEqual(result.results[0].reason, 'standing/scope');
    assert.strictEqual(result.results[0].scope, 'E sessions');
  });

  test('marks healthy when within thresholds', () => {
    const directives = {
      directives: [{
        id: 'd090', status: 'active', from: 'self',
        acked_session: '1990', content: 'Recent directive',
        notes: ''
      }]
    };

    const result = analyzeDirectives({ ...baseParams, directives });
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(result.healthy, 1);
    assert.strictEqual(result.needsAttention, 0);
  });

  test('tracks standing directives separately', () => {
    const directives = {
      directives: [{
        id: 'd049', status: 'standing', scope: 'all',
        content: 'Enforce artifact compliance'
      }]
    };

    const result = analyzeDirectives({ ...baseParams, directives });
    assert.strictEqual(result.standing.length, 1);
    assert.strictEqual(result.standing[0].id, 'd049');
    assert.strictEqual(result.standing[0].scope, 'all');
    assert.strictEqual(result.healthy, 1);
    assert.strictEqual(result.results.length, 0);
  });

  test('handles empty directives input', () => {
    const result = analyzeDirectives({ ...baseParams, directives: {} });
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(result.healthy, 0);
    assert.strictEqual(result.needsAttention, 0);
    assert.ok(result.summary.includes('0'));
  });

  test('handles null/undefined directives gracefully', () => {
    const result = analyzeDirectives({ ...baseParams, directives: { directives: null } });
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(result.healthy, 0);
  });

  test('detects pending questions', () => {
    const directives = {
      directives: [],
      questions: [
        { id: 'q1', status: 'pending', question: 'Should we increase XMR budget?' },
        { id: 'q2', status: 'resolved', question: 'Already answered' },
      ]
    };

    const result = analyzeDirectives({ ...baseParams, directives });
    assert.strictEqual(result.pendingQuestions.length, 1);
    assert.strictEqual(result.pendingQuestions[0].id, 'q1');
    assert.strictEqual(result.needsAttention, 1);
  });

  test('uses notes session refs when acked_session is missing', () => {
    const directives = {
      directives: [{
        id: 'd085', status: 'active', from: 'self',
        content: 'Directive with only notes tracking',
        notes: 'Last worked on s1995'
      }]
    };

    const result = analyzeDirectives({ ...baseParams, directives });
    // s1995 → 5 sessions since, well within threshold
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(result.healthy, 1);
  });

  test('queue item presence suppresses NEEDS_UPDATE for default directives', () => {
    const directives = {
      directives: [{
        id: 'd080', status: 'active', from: 'self',
        acked_session: '1975', content: 'Has queue item',
        notes: ''
      }]
    };
    const queue = {
      queue: [{ status: 'pending', title: 'implement d080 feature' }]
    };

    const result = analyzeDirectives({ ...baseParams, directives, queue });
    assert.strictEqual(result.results.length, 0, 'Should be healthy when queue item exists');
    assert.strictEqual(result.healthy, 1);
  });
});

// ---- formatResults ----
describe('formatResults', () => {
  test('formats STALE results correctly', () => {
    const output = formatResults({
      results: [{ status: 'STALE', id: 'd099', sessionsSince: 40, lastActivity: 1960, threshold: 30, content: 'Old task' }],
      pendingQuestions: [],
      standing: [],
      summary: '1 directive(s) need attention, 0 healthy.'
    });
    assert.ok(output.includes('STALE: d099'));
    assert.ok(output.includes('40 sessions'));
    assert.ok(output.includes('threshold=30'));
    assert.ok(output.includes('SUMMARY:'));
  });

  test('formats NEEDS_UPDATE with scope', () => {
    const output = formatResults({
      results: [{ status: 'NEEDS_UPDATE', id: 'd055', sessionsSince: 38, threshold: 35, content: 'Scoped', scope: 'E sessions' }],
      pendingQuestions: [],
      standing: [],
      summary: 'test'
    });
    assert.ok(output.includes('NEEDS_UPDATE: d055'));
    assert.ok(output.includes('standing/scope=E sessions'));
  });

  test('includes standing directives and pending questions', () => {
    const output = formatResults({
      results: [],
      pendingQuestions: [{ id: 'q1', question: 'Budget question' }],
      standing: [{ id: 'd049', scope: 'all' }],
      summary: 'All healthy.'
    });
    assert.ok(output.includes('STANDING: d049(all)'));
    assert.ok(output.includes('PENDING QUESTIONS'));
    assert.ok(output.includes('q1: Budget question'));
  });
});

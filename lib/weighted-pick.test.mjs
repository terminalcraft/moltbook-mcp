import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { weightedPick } from './weighted-pick.mjs';

describe('weightedPick', () => {
  it('returns null for empty array', () => {
    assert.equal(weightedPick([]), null);
  });

  it('returns null for non-array input', () => {
    assert.equal(weightedPick(null), null);
    assert.equal(weightedPick(undefined), null);
    assert.equal(weightedPick('string'), null);
  });

  it('returns the only item in a single-element array', () => {
    const item = { score: 5 };
    assert.equal(weightedPick([item]), item);
  });

  it('respects weights — high-weight items picked more often', () => {
    const heavy = { score: 100, id: 'heavy' };
    const light = { score: 1, id: 'light' };
    const counts = { heavy: 0, light: 0 };
    for (let i = 0; i < 1000; i++) {
      const pick = weightedPick([heavy, light]);
      counts[pick.id]++;
    }
    // With 100:1 ratio, heavy should dominate (>90% of picks)
    assert.ok(counts.heavy > 900, `Expected heavy > 900, got ${counts.heavy}`);
  });

  it('handles zero weights — falls back to first item', () => {
    const a = { score: 0, id: 'a' };
    const b = { score: 0, id: 'b' };
    assert.equal(weightedPick([a, b]), a);
  });

  it('treats negative weights as zero', () => {
    const neg = { score: -5, id: 'neg' };
    const pos = { score: 10, id: 'pos' };
    // neg gets weight 0, pos gets weight 10 — should always pick pos
    const counts = { neg: 0, pos: 0 };
    for (let i = 0; i < 100; i++) {
      counts[weightedPick([neg, pos]).id]++;
    }
    assert.equal(counts.pos, 100);
  });

  it('all negative weights — falls back to first item', () => {
    const a = { score: -3, id: 'a' };
    const b = { score: -7, id: 'b' };
    assert.equal(weightedPick([a, b]), a);
  });

  it('accepts custom weight function', () => {
    const items = [{ priority: 10 }, { priority: 0 }];
    const pick = weightedPick(items, item => item.priority);
    assert.equal(pick, items[0]);
  });

  it('uses .score by default', () => {
    const item = { score: 5 };
    assert.equal(weightedPick([item]), item);
  });
});

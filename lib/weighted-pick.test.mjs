import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { weightedPick, weightedPickN } from './weighted-pick.mjs';

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

describe('weightedPickN', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(weightedPickN([], 3), []);
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(weightedPickN(null, 3), []);
    assert.deepEqual(weightedPickN(undefined, 2), []);
  });

  it('returns empty array for count <= 0', () => {
    assert.deepEqual(weightedPickN([{ score: 1 }], 0), []);
    assert.deepEqual(weightedPickN([{ score: 1 }], -1), []);
  });

  it('returns all items when count >= items.length', () => {
    const items = [{ score: 5, id: 'a' }, { score: 3, id: 'b' }];
    const result = weightedPickN(items, 5);
    assert.equal(result.length, 2);
    assert.ok(result.includes(items[0]));
    assert.ok(result.includes(items[1]));
  });

  it('returns exactly count items when enough available', () => {
    const items = [
      { score: 10, id: 'a' },
      { score: 10, id: 'b' },
      { score: 10, id: 'c' },
      { score: 10, id: 'd' },
    ];
    const result = weightedPickN(items, 2);
    assert.equal(result.length, 2);
  });

  it('selects without replacement — no duplicates', () => {
    const items = [
      { score: 10, id: 'a' },
      { score: 10, id: 'b' },
      { score: 10, id: 'c' },
    ];
    for (let i = 0; i < 100; i++) {
      const result = weightedPickN(items, 3);
      const ids = result.map(r => r.id);
      assert.equal(new Set(ids).size, 3, `Duplicate found in ${JSON.stringify(ids)}`);
    }
  });

  it('does not mutate the input array', () => {
    const items = [{ score: 5 }, { score: 3 }, { score: 1 }];
    const original = [...items];
    weightedPickN(items, 2);
    assert.deepEqual(items, original);
  });

  it('accepts custom weight function', () => {
    const items = [
      { w: 100, id: 'heavy' },
      { w: 1, id: 'light' },
    ];
    const result = weightedPickN(items, 1, item => item.w);
    assert.equal(result.length, 1);
  });

  it('high-weight items appear more often in first position', () => {
    const heavy = { score: 100, id: 'heavy' };
    const light = { score: 1, id: 'light' };
    let heavyFirst = 0;
    for (let i = 0; i < 500; i++) {
      const result = weightedPickN([heavy, light], 1);
      if (result[0].id === 'heavy') heavyFirst++;
    }
    assert.ok(heavyFirst > 450, `Expected heavy first > 450, got ${heavyFirst}`);
  });
});

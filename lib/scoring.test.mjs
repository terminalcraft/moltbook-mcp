import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tieredScore, verdictFromScore, sortByScore, filterByThreshold, booleanScore } from './scoring.mjs';

describe('tieredScore', () => {
  const tiers = [
    { min: 500, points: 15 },
    { min: 200, points: 10 },
    { min: 100, points: 5 },
    { min: 50, points: 2 },
  ];

  it('returns highest matching tier', () => {
    assert.equal(tieredScore(600, tiers), 15);
    assert.equal(tieredScore(500, tiers), 15);
    assert.equal(tieredScore(250, tiers), 10);
    assert.equal(tieredScore(200, tiers), 10);
    assert.equal(tieredScore(150, tiers), 5);
    assert.equal(tieredScore(50, tiers), 2);
  });

  it('returns 0 below all tiers', () => {
    assert.equal(tieredScore(49, tiers), 0);
    assert.equal(tieredScore(0, tiers), 0);
  });

  it('handles empty or invalid tiers', () => {
    assert.equal(tieredScore(100, []), 0);
    assert.equal(tieredScore(100, null), 0);
  });

  it('handles unsorted tier input', () => {
    const unsorted = [{ min: 10, points: 1 }, { min: 100, points: 5 }, { min: 50, points: 3 }];
    assert.equal(tieredScore(75, unsorted), 3);
    assert.equal(tieredScore(100, unsorted), 5);
  });
});

describe('booleanScore', () => {
  it('returns points for truthy values', () => {
    assert.equal(booleanScore(true, 15), 15);
    assert.equal(booleanScore('yes', 10), 10);
    assert.equal(booleanScore(1, 5), 5);
  });

  it('returns 0 for falsy values', () => {
    assert.equal(booleanScore(false, 15), 0);
    assert.equal(booleanScore(null, 10), 0);
    assert.equal(booleanScore(0, 5), 0);
    assert.equal(booleanScore('', 5), 0);
  });
});

describe('verdictFromScore', () => {
  it('returns pass verdict at or above threshold', () => {
    assert.equal(verdictFromScore(30, 30), 'engage');
    assert.equal(verdictFromScore(100, 30), 'engage');
  });

  it('returns fail verdict below threshold', () => {
    assert.equal(verdictFromScore(29, 30), 'skip');
    assert.equal(verdictFromScore(0, 30), 'skip');
  });

  it('supports custom verdict strings', () => {
    assert.equal(verdictFromScore(50, 40, 'accept', 'reject'), 'accept');
    assert.equal(verdictFromScore(30, 40, 'accept', 'reject'), 'reject');
  });
});

describe('sortByScore', () => {
  it('sorts descending by score', () => {
    const items = [{ score: 10 }, { score: 50 }, { score: 30 }];
    const sorted = sortByScore(items);
    assert.deepEqual(sorted.map(i => i.score), [50, 30, 10]);
  });

  it('does not mutate original array', () => {
    const items = [{ score: 10 }, { score: 50 }];
    sortByScore(items);
    assert.equal(items[0].score, 10);
  });

  it('supports custom key', () => {
    const items = [{ weight: 5 }, { weight: 20 }, { weight: 10 }];
    const sorted = sortByScore(items, 'weight');
    assert.deepEqual(sorted.map(i => i.weight), [20, 10, 5]);
  });

  it('handles non-array input', () => {
    assert.deepEqual(sortByScore(null), []);
    assert.deepEqual(sortByScore(undefined), []);
  });
});

describe('filterByThreshold', () => {
  const items = [
    { name: 'a', score: 50 },
    { name: 'b', score: 20 },
    { name: 'c', score: 30 },
    { name: 'd', score: 10 },
  ];

  it('filters items at or above threshold', () => {
    const result = filterByThreshold(items, 30);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(i => i.name), ['a', 'c']);
  });

  it('returns empty for high threshold', () => {
    assert.deepEqual(filterByThreshold(items, 100), []);
  });

  it('returns all for zero threshold', () => {
    assert.equal(filterByThreshold(items, 0).length, 4);
  });

  it('handles non-array input', () => {
    assert.deepEqual(filterByThreshold(null, 30), []);
  });
});

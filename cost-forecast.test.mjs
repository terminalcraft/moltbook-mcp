#!/usr/bin/env node
// cost-forecast.test.mjs — Tests for cost-forecast module
// Run with: node --test cost-forecast.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEffort, parseHistory, computeStats, forecast } from './cost-forecast.mjs';

describe('classifyEffort', () => {
  test('classifies testing-tagged items as moderate', () => {
    assert.equal(classifyEffort({ title: 'Add tests', tags: ['testing'] }), 'moderate');
  });

  test('classifies security-tagged items as heavy', () => {
    assert.equal(classifyEffort({ title: 'Fix auth', tags: ['security'] }), 'heavy');
  });

  test('classifies trivial keywords correctly', () => {
    assert.equal(classifyEffort({ title: 'Fix typo in readme', tags: [] }), 'trivial');
    assert.equal(classifyEffort({ title: 'Rename variable', tags: [] }), 'trivial');
  });

  test('classifies heavy keywords correctly', () => {
    assert.equal(classifyEffort({ title: 'Refactor entire auth system', tags: [] }), 'heavy');
    assert.equal(classifyEffort({ title: 'Build new integration for X', tags: [] }), 'heavy');
  });

  test('classifies moderate keywords correctly', () => {
    assert.equal(classifyEffort({ title: 'Add test for component', tags: [] }), 'moderate');
    assert.equal(classifyEffort({ title: 'Fix bug in parser', tags: [] }), 'moderate');
  });

  test('defaults to moderate for ambiguous items', () => {
    assert.equal(classifyEffort({ title: 'Something', tags: [] }), 'moderate');
  });

  test('uses description length for long descriptions', () => {
    const longDesc = 'x'.repeat(250);
    assert.equal(classifyEffort({ title: 'Task', description: longDesc, tags: [] }), 'heavy');
  });
});

describe('computeStats', () => {
  test('computes correct stats for non-empty array', () => {
    const entries = [{ cost: 1 }, { cost: 2 }, { cost: 3 }, { cost: 4 }, { cost: 5 }];
    const stats = computeStats(entries);
    assert.equal(stats.avg, 3);
    assert.equal(stats.min, 1);
    assert.equal(stats.max, 5);
    assert.equal(stats.median, 3);
    assert.equal(stats.count, 5);
  });

  test('handles empty array', () => {
    const stats = computeStats([]);
    assert.equal(stats.avg, 0);
    assert.equal(stats.count, 0);
  });

  test('handles single entry', () => {
    const stats = computeStats([{ cost: 2.5 }]);
    assert.equal(stats.avg, 2.5);
    assert.equal(stats.min, 2.5);
    assert.equal(stats.max, 2.5);
    assert.equal(stats.count, 1);
  });
});

describe('parseHistory', () => {
  test('returns array from session history', () => {
    const result = parseHistory();
    assert.ok(Array.isArray(result));
    // Should have some entries from the actual session history
    assert.ok(result.length > 0, 'Should parse entries from session-history.txt');
  });

  test('parsed entries have expected fields', () => {
    const result = parseHistory();
    if (result.length > 0) {
      const entry = result[0];
      assert.ok(entry.mode, 'Should have mode');
      assert.ok(typeof entry.cost === 'number', 'Should have numeric cost');
    }
  });
});

describe('forecast', () => {
  test('returns complete forecast object', () => {
    const result = forecast('B');
    assert.ok(result.timestamp);
    assert.ok(result.sessionHistory);
    assert.ok(result.sessionHistory.byType);
    assert.ok(result.pendingQueue);
    assert.ok(typeof result.pendingQueue.count === 'number');
    assert.ok(result.nextSession);
    assert.equal(result.nextSession.type, 'B');
    assert.ok(typeof result.nextSession.predictedCost === 'number');
    assert.ok(['high', 'medium', 'low'].includes(result.nextSession.confidence));
  });

  test('respects type parameter', () => {
    const result = forecast('E');
    assert.equal(result.nextSession.type, 'E');
  });

  test('defaults to B type', () => {
    const result = forecast();
    assert.equal(result.nextSession.type, 'B');
  });

  test('predicted cost is positive', () => {
    const result = forecast('B');
    assert.ok(result.nextSession.predictedCost > 0, 'Cost should be positive');
  });

  test('queue items are classified', () => {
    const result = forecast();
    for (const item of result.pendingQueue.items) {
      assert.ok(['trivial', 'moderate', 'heavy'].includes(item.effort), `${item.id} should have valid effort`);
    }
  });
});

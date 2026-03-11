#!/usr/bin/env node
// truncation-recovery.test.mjs — Unit tests for truncation-recovery.mjs (d076, wq-932)
//
// Covers: computeDuration, findAssignedItem, getItemStatus, requeue, recoverTruncated
// Each function tested for happy path, malformed input, and edge cases.
//
// Usage: node --test hooks/lib/truncation-recovery.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeDuration, findAssignedItem, getItemStatus, requeue, recoverTruncated } from './truncation-recovery.mjs';

// --- Helpers ---

function jsonlLine(ts, extra = '') {
  return `{"timestamp":"${ts}","type":"assistant"${extra ? ',' + extra : ''}}\n`;
}

function makeWq(items) {
  return { queue: items };
}

function pendingItem(id, status = 'pending') {
  return { id, status, title: `Test item ${id}`, notes: '' };
}

// ---- computeDuration ----

describe('computeDuration: happy path', () => {
  test('computes correct duration from JSONL timestamps', () => {
    const log = jsonlLine('2026-03-10T10:00:00') + jsonlLine('2026-03-10T10:05:00');
    assert.strictEqual(computeDuration(log), 300);
  });

  test('handles multi-line log with timestamps spread across entries', () => {
    const lines = [
      jsonlLine('2026-03-10T08:00:00'),
      '{"type":"tool_use"}\n',
      jsonlLine('2026-03-10T08:02:30'),
      jsonlLine('2026-03-10T08:10:00'),
    ];
    assert.strictEqual(computeDuration(lines.join('')), 600);
  });
});

describe('computeDuration: malformed input', () => {
  test('returns 999 for null/undefined input', () => {
    assert.strictEqual(computeDuration(null), 999);
    assert.strictEqual(computeDuration(undefined), 999);
  });

  test('returns 999 for empty string', () => {
    assert.strictEqual(computeDuration(''), 999);
  });

  test('returns 999 for log with no timestamps', () => {
    assert.strictEqual(computeDuration('{"type":"text"}\n{"type":"tool"}\n'), 999);
  });
});

describe('computeDuration: edge cases', () => {
  test('single timestamp returns 0 (same first and last)', () => {
    const log = jsonlLine('2026-03-10T12:00:00');
    assert.strictEqual(computeDuration(log), 0);
  });

  test('timestamps only in first/last 50 lines of large log', () => {
    const start = jsonlLine('2026-03-10T10:00:00');
    const middle = Array(100).fill('{"no":"timestamp"}\n').join('');
    const end = jsonlLine('2026-03-10T10:15:00');
    // Only checks first 50 and last 50 lines, middle has none
    const result = computeDuration(start + middle + end);
    assert.strictEqual(result, 900);
  });
});

// ---- findAssignedItem ----

describe('findAssignedItem: happy path', () => {
  test('extracts wq-NNN from log content', () => {
    assert.strictEqual(findAssignedItem('Working on wq-123 now'), 'wq-123');
  });

  test('returns first match when multiple wq items present', () => {
    assert.strictEqual(findAssignedItem('wq-100 and wq-200'), 'wq-100');
  });
});

describe('findAssignedItem: malformed input', () => {
  test('returns null for null/undefined', () => {
    assert.strictEqual(findAssignedItem(null), null);
    assert.strictEqual(findAssignedItem(undefined), null);
  });

  test('returns null for empty string', () => {
    assert.strictEqual(findAssignedItem(''), null);
  });

  test('returns null for content with no wq reference', () => {
    assert.strictEqual(findAssignedItem('just some random log output'), null);
  });
});

// ---- getItemStatus ----

describe('getItemStatus: happy path', () => {
  test('returns status of matching item', () => {
    const wq = makeWq([pendingItem('wq-100'), pendingItem('wq-200', 'done')]);
    assert.strictEqual(getItemStatus(wq, 'wq-100'), 'pending');
    assert.strictEqual(getItemStatus(wq, 'wq-200'), 'done');
  });
});

describe('getItemStatus: malformed input', () => {
  test('returns not_found for null wqData', () => {
    assert.strictEqual(getItemStatus(null, 'wq-100'), 'not_found');
  });

  test('returns not_found for wqData without queue', () => {
    assert.strictEqual(getItemStatus({}, 'wq-100'), 'not_found');
  });

  test('returns not_found for missing item', () => {
    assert.strictEqual(getItemStatus(makeWq([]), 'wq-999'), 'not_found');
  });
});

describe('getItemStatus: edge cases', () => {
  test('returns unknown for item with no status field', () => {
    const wq = makeWq([{ id: 'wq-100' }]);
    assert.strictEqual(getItemStatus(wq, 'wq-100'), 'unknown');
  });
});

// ---- requeue ----

describe('requeue: happy path', () => {
  test('sets pending item back to pending with recovery note', () => {
    const wq = makeWq([pendingItem('wq-100', 'in_progress')]);
    const result = requeue(wq, 'wq-100', 1900, 45);
    assert.strictEqual(result, true);
    assert.strictEqual(wq.queue[0].status, 'pending');
    assert.ok(wq.queue[0].notes.includes('truncation-recovery s1900'));
    assert.ok(wq.queue[0].notes.includes('45s'));
  });
});

describe('requeue: malformed input', () => {
  test('returns false for null wqData', () => {
    assert.strictEqual(requeue(null, 'wq-100', 1900, 45), false);
  });

  test('returns false for missing queue', () => {
    assert.strictEqual(requeue({}, 'wq-100', 1900, 45), false);
  });
});

describe('requeue: edge cases', () => {
  test('does not requeue done items', () => {
    const wq = makeWq([pendingItem('wq-100', 'done')]);
    assert.strictEqual(requeue(wq, 'wq-100', 1900, 45), false);
    assert.strictEqual(wq.queue[0].status, 'done');
  });

  test('returns false for non-existent item', () => {
    const wq = makeWq([pendingItem('wq-100')]);
    assert.strictEqual(requeue(wq, 'wq-999', 1900, 45), false);
  });

  test('appends to existing notes', () => {
    const wq = makeWq([{ ...pendingItem('wq-100', 'in_progress'), notes: 'prev note' }]);
    requeue(wq, 'wq-100', 1900, 60);
    assert.ok(wq.queue[0].notes.startsWith('prev note'));
    assert.ok(wq.queue[0].notes.includes('truncation-recovery'));
  });
});

// ---- recoverTruncated (integration) ----

describe('recoverTruncated: happy path — recovery triggers', () => {
  test('recovers truncated session (short duration, 0 commits, pending item)', () => {
    const log = jsonlLine('2026-03-10T10:00:00') + 'working on wq-100\n' + jsonlLine('2026-03-10T10:01:00');
    const wq = makeWq([pendingItem('wq-100')]);
    const r = recoverTruncated({ sessionNum: 1900, logContent: log, wqData: wq });
    assert.strictEqual(r.action, 'recovered');
    assert.strictEqual(r.itemId, 'wq-100');
    assert.strictEqual(r.duration, 60);
    assert.strictEqual(wq.queue[0].status, 'pending');
  });
});

describe('recoverTruncated: skip conditions', () => {
  test('skips when duration exceeds minDuration', () => {
    const log = jsonlLine('2026-03-10T10:00:00') + 'wq-100\n' + jsonlLine('2026-03-10T10:10:00');
    const wq = makeWq([pendingItem('wq-100')]);
    const r = recoverTruncated({ sessionNum: 1901, logContent: log, wqData: wq });
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'duration_ok');
  });

  test('skips when commitCount > 0', () => {
    const log = jsonlLine('2026-03-10T10:00:00') + 'wq-100\n' + jsonlLine('2026-03-10T10:00:30');
    const wq = makeWq([pendingItem('wq-100')]);
    const r = recoverTruncated({ sessionNum: 1902, logContent: log, wqData: wq, commitCount: 1 });
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'has_commits');
  });

  test('skips when item is already done', () => {
    const log = jsonlLine('2026-03-10T10:00:00') + 'wq-100\n' + jsonlLine('2026-03-10T10:00:30');
    const wq = makeWq([pendingItem('wq-100', 'done')]);
    const r = recoverTruncated({ sessionNum: 1903, logContent: log, wqData: wq });
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'item_done');
  });

  test('returns no_item when log has no wq reference', () => {
    const log = jsonlLine('2026-03-10T10:00:00') + 'no task ref\n' + jsonlLine('2026-03-10T10:00:30');
    const wq = makeWq([pendingItem('wq-100')]);
    const r = recoverTruncated({ sessionNum: 1904, logContent: log, wqData: wq });
    assert.strictEqual(r.action, 'no_item');
  });
});

describe('recoverTruncated: edge cases', () => {
  test('custom minDuration threshold', () => {
    const log = jsonlLine('2026-03-10T10:00:00') + 'wq-100\n' + jsonlLine('2026-03-10T10:01:30');
    const wq = makeWq([pendingItem('wq-100')]);
    const r = recoverTruncated({ sessionNum: 1905, logContent: log, wqData: wq, minDuration: 60 });
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'duration_ok');
  });

  test('empty log content', () => {
    const wq = makeWq([pendingItem('wq-100')]);
    const r = recoverTruncated({ sessionNum: 1906, logContent: '', wqData: wq });
    // Empty log → duration=999 → skip
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'duration_ok');
  });

  test('item not found in queue', () => {
    const log = jsonlLine('2026-03-10T10:00:00') + 'wq-999\n' + jsonlLine('2026-03-10T10:00:30');
    const wq = makeWq([pendingItem('wq-100')]);
    const r = recoverTruncated({ sessionNum: 1907, logContent: log, wqData: wq });
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'item_not_found');
  });
});

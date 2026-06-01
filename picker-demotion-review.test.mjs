#!/usr/bin/env node
// picker-demotion-review.test.mjs — Tests for picker-demotion-review.mjs
//
// Covers: expired trial removal, stale demotion flagging, edge cases
// (empty arrays, no trial_until field, session 0, no demotions key).
//
// Usage: node --test picker-demotion-review.test.mjs
// Created: wq-1049

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createScratch } from './test-runner-utils.mjs';
import { reviewPickerDemotions } from './picker-demotion-review.mjs';

const scratch = createScratch('picker-demotion-test');

before(() => scratch.setup());
after(() => scratch.cleanup());

// Helper to write fixture and run review
function setup(data, sessionNum) {
  scratch.writeJSON('picker-demotions.json', data);
  return reviewPickerDemotions(sessionNum, scratch.dir);
}

// --- Expired trial removal ---

describe('expired trial removal', () => {
  it('removes weight overrides past trial_until', () => {
    const result = setup({
      weight_overrides: [
        { id: 'a', multiplier: 0.5, reason: 'test', trial_until: 100 },
        { id: 'b', multiplier: 0.3, reason: 'test', trial_until: 200 },
      ],
      demotions: [],
    }, 150);

    assert.equal(result.expiredTrials.length, 1);
    assert.equal(result.expiredTrials[0].id, 'a');
    assert.equal(result.expiredTrials[0].sessions_past, 50);
    assert.equal(result.cleaned, true);

    // Verify file was actually written with override removed
    const onDisk = JSON.parse(readFileSync(join(scratch.dir, 'picker-demotions.json'), 'utf8'));
    assert.equal(onDisk.weight_overrides.length, 1);
    assert.equal(onDisk.weight_overrides[0].id, 'b');
  });

  it('removes all overrides when all expired', () => {
    const result = setup({
      weight_overrides: [
        { id: 'x', multiplier: 0.5, reason: 'r1', trial_until: 10 },
        { id: 'y', multiplier: 0.3, reason: 'r2', trial_until: 20 },
      ],
      demotions: [],
    }, 100);

    assert.equal(result.expiredTrials.length, 2);
    assert.equal(result.cleaned, true);

    const onDisk = JSON.parse(readFileSync(join(scratch.dir, 'picker-demotions.json'), 'utf8'));
    assert.equal(onDisk.weight_overrides.length, 0);
  });

  it('keeps overrides not yet expired', () => {
    const result = setup({
      weight_overrides: [
        { id: 'a', multiplier: 0.5, reason: 'test', trial_until: 200 },
      ],
      demotions: [],
    }, 100);

    assert.equal(result.expiredTrials.length, 0);
    assert.equal(result.cleaned, false);
  });

  it('keeps overrides without trial_until field', () => {
    const result = setup({
      weight_overrides: [
        { id: 'permanent', multiplier: 0.5, reason: 'no expiry' },
      ],
      demotions: [],
    }, 9999);

    assert.equal(result.expiredTrials.length, 0);
    assert.equal(result.cleaned, false);
  });

  it('does not write file when nothing expired', () => {
    const data = {
      weight_overrides: [
        { id: 'a', multiplier: 0.5, reason: 'test', trial_until: 500 },
      ],
      demotions: [],
    };
    setup(data, 100);

    // Read back and verify it matches original (no rewrite)
    const onDisk = JSON.parse(readFileSync(join(scratch.dir, 'picker-demotions.json'), 'utf8'));
    assert.equal(onDisk.weight_overrides[0].trial_until, 500);
  });
});

// --- Stale demotion flagging ---

describe('stale demotion flagging', () => {
  it('flags demotions >100 sessions old (B# pattern)', () => {
    const result = setup({
      weight_overrides: [],
      demotions: [
        { id: 'old', reason: 'dead', demoted_at: '2026-01-01', demoted_by: 'wq-100 B#200' },
      ],
    }, 400);

    assert.equal(result.staleDemotions.length, 1);
    assert.equal(result.staleDemotions[0].id, 'old');
    assert.equal(result.staleDemotions[0].sessions_age, 200);
  });

  it('flags demotions >100 sessions old (s#### fallback pattern)', () => {
    const result = setup({
      weight_overrides: [],
      demotions: [
        { id: 'old2', reason: 'dead', demoted_at: '2026-02-01', demoted_by: 'wq-500 s1000' },
      ],
    }, 1200);

    assert.equal(result.staleDemotions.length, 1);
    assert.equal(result.staleDemotions[0].sessions_age, 200);
  });

  it('prefers B# over s#### when both present', () => {
    const result = setup({
      weight_overrides: [],
      demotions: [
        { id: 'both', reason: 'test', demoted_at: '2026-01-01', demoted_by: 'wq-100 B#300 s100' },
      ],
    }, 500);

    // B#300 is used → age = 500-300 = 200
    assert.equal(result.staleDemotions.length, 1);
    assert.equal(result.staleDemotions[0].sessions_age, 200);
  });

  it('does not flag recent demotions', () => {
    const result = setup({
      weight_overrides: [],
      demotions: [
        { id: 'recent', reason: 'new', demoted_at: '2026-05-01', demoted_by: 'wq-900 B#380' },
      ],
    }, 400);

    assert.equal(result.staleDemotions.length, 0);
  });

  it('skips demotions with no parseable session number', () => {
    const result = setup({
      weight_overrides: [],
      demotions: [
        { id: 'unknown', reason: 'mystery', demoted_at: '2026-01-01', demoted_by: 'manual' },
      ],
    }, 9999);

    assert.equal(result.staleDemotions.length, 0);
  });

  it('skips demotions with empty demoted_by', () => {
    const result = setup({
      weight_overrides: [],
      demotions: [
        { id: 'empty', reason: 'test', demoted_at: '2026-01-01', demoted_by: '' },
      ],
    }, 9999);

    assert.equal(result.staleDemotions.length, 0);
  });

  it('handles missing demoted_by field', () => {
    const result = setup({
      weight_overrides: [],
      demotions: [
        { id: 'nofield', reason: 'test', demoted_at: '2026-01-01' },
      ],
    }, 9999);

    assert.equal(result.staleDemotions.length, 0);
  });
});

// --- Edge cases ---

describe('edge cases', () => {
  it('handles empty weight_overrides and demotions arrays', () => {
    const result = setup({ weight_overrides: [], demotions: [] }, 100);

    assert.deepStrictEqual(result.expiredTrials, []);
    assert.deepStrictEqual(result.staleDemotions, []);
    assert.equal(result.cleaned, false);
  });

  it('handles missing weight_overrides key', () => {
    const result = setup({ demotions: [] }, 100);

    assert.deepStrictEqual(result.expiredTrials, []);
    assert.equal(result.cleaned, false);
  });

  it('handles missing demotions key', () => {
    const result = setup({ weight_overrides: [] }, 100);

    assert.deepStrictEqual(result.staleDemotions, []);
    assert.equal(result.cleaned, false);
  });

  it('handles session 0', () => {
    const result = setup({
      weight_overrides: [
        { id: 'a', multiplier: 0.5, reason: 'test', trial_until: 100 },
      ],
      demotions: [
        { id: 'b', reason: 'test', demoted_at: '2026-01-01', demoted_by: 'wq-1 B#0' },
      ],
    }, 0);

    // trial_until=100 > sessionNum=0, so not expired
    assert.equal(result.expiredTrials.length, 0);
    // B#0 at session 0 → age 0, not >100
    assert.equal(result.staleDemotions.length, 0);
    assert.equal(result.cleaned, false);
  });

  it('trial_until exactly equal to sessionNum is not expired', () => {
    // Code uses `<` not `<=`, so trial_until == sessionNum keeps the override
    const result = setup({
      weight_overrides: [
        { id: 'boundary', multiplier: 0.5, reason: 'test', trial_until: 100 },
      ],
      demotions: [],
    }, 100);

    assert.equal(result.expiredTrials.length, 0);
    assert.equal(result.cleaned, false);
  });

  it('demotion exactly 100 sessions old is not flagged', () => {
    // Code uses `> 100` not `>= 100`
    const result = setup({
      weight_overrides: [],
      demotions: [
        { id: 'edge', reason: 'test', demoted_at: '2026-01-01', demoted_by: 'wq-1 B#100' },
      ],
    }, 200);

    assert.equal(result.staleDemotions.length, 0);
  });

  it('demotion 101 sessions old is flagged', () => {
    const result = setup({
      weight_overrides: [],
      demotions: [
        { id: 'edge2', reason: 'test', demoted_at: '2026-01-01', demoted_by: 'wq-1 B#100' },
      ],
    }, 201);

    assert.equal(result.staleDemotions.length, 1);
    assert.equal(result.staleDemotions[0].sessions_age, 101);
  });
});

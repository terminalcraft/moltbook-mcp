#!/usr/bin/env node
// d071-baseline.test.mjs — Tests for d071-baseline.cjs coverage tool
// Run with: node --test d071-baseline.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'd071-baseline.cjs');

function run(...args) {
  const out = execFileSync('node', [SCRIPT, ...args], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
    timeout: 10000
  });
  return JSON.parse(out);
}

describe('d071-baseline.cjs --summary output structure', () => {
  test('returns valid JSON with required fields', () => {
    const result = run('--summary');
    assert.ok(result.d071_coverage, 'missing d071_coverage top-level key');
    const cov = result.d071_coverage;

    // Required scalar fields
    assert.equal(typeof cov.deadline_session, 'number');
    assert.equal(cov.deadline_session, 1725);
    assert.equal(typeof cov.target_pct, 'number');
    assert.equal(cov.target_pct, 80);

    // Coverage sub-objects
    for (const key of ['critical_path', 'hooks', 'combined']) {
      assert.ok(cov[key], `missing ${key}`);
      assert.equal(typeof cov[key].covered, 'number');
      assert.equal(typeof cov[key].total, 'number');
      assert.equal(typeof cov[key].pct, 'number');
      assert.ok(cov[key].covered <= cov[key].total, `${key}: covered > total`);
      assert.ok(cov[key].pct >= 0 && cov[key].pct <= 100, `${key}: pct out of range`);
    }

    // Verdict must be one of the valid values
    assert.ok(
      ['target_met', 'on_track', 'at_risk', 'behind'].includes(cov.verdict),
      `unexpected verdict: ${cov.verdict}`
    );

    // Gap and pace
    assert.equal(typeof cov.gap_to_target_pp, 'number');
    assert.ok(cov.gap_to_target_pp >= 0, 'gap should be non-negative');

    // Arrays
    assert.ok(Array.isArray(cov.top_uncovered), 'top_uncovered should be array');
    assert.ok(cov.top_uncovered.length <= 5, 'top_uncovered capped at 5');
    assert.ok(Array.isArray(cov.newly_covered), 'newly_covered should be array');
  });

  test('combined = critical_path + hooks', () => {
    const cov = run('--summary').d071_coverage;
    assert.equal(
      cov.combined.total,
      cov.critical_path.total + cov.hooks.total,
      'combined total != cp + hooks total'
    );
    assert.equal(
      cov.combined.covered,
      cov.critical_path.covered + cov.hooks.covered,
      'combined covered != cp + hooks covered'
    );
  });
});

describe('d071-baseline.cjs full output structure', () => {
  test('--dry-run returns full output without modifying baseline file', () => {
    const result = run('--dry-run');

    // Top-level fields
    assert.equal(typeof result.measured_at, 'string');
    assert.equal(result.directive, 'd071');
    assert.equal(result.target_coverage_pct, 80);
    assert.equal(result.deadline_session, 1725);

    // critical_path
    assert.ok(result.critical_path);
    assert.equal(typeof result.critical_path.total, 'number');
    assert.equal(typeof result.critical_path.covered, 'number');
    assert.equal(typeof result.critical_path.coverage_pct, 'number');
    assert.ok(Array.isArray(result.critical_path.uncovered));

    // by_category
    assert.ok(result.by_category);
    for (const cat of ['core_and_session', 'lib_modules', 'providers']) {
      assert.ok(result.by_category[cat], `missing category: ${cat}`);
      assert.equal(typeof result.by_category[cat].total, 'number');
      assert.equal(typeof result.by_category[cat].covered, 'number');
      assert.equal(typeof result.by_category[cat].coverage_pct, 'number');
      assert.ok(Array.isArray(result.by_category[cat].uncovered));
    }

    // hooks
    assert.ok(result.hooks);
    assert.ok(result.hooks.pre_session);
    assert.ok(result.hooks.post_session);
    assert.equal(typeof result.hooks.pre_session.total, 'number');
    assert.equal(typeof result.hooks.pre_session.covered, 'number');
    assert.equal(typeof result.hooks.post_session.total, 'number');
    assert.equal(typeof result.hooks.post_session.covered, 'number');

    // combined
    assert.ok(result.combined_critical_coverage);
    assert.equal(typeof result.combined_critical_coverage.gap_to_target, 'number');

    // verdict
    assert.ok(
      ['target_met', 'on_track', 'at_risk', 'behind'].includes(result.verdict),
      `unexpected verdict: ${result.verdict}`
    );
  });

  test('category totals sum to critical_path total', () => {
    const result = run('--dry-run');
    const catSum = result.by_category.core_and_session.total +
      result.by_category.lib_modules.total +
      result.by_category.providers.total;
    assert.equal(catSum, result.critical_path.total,
      `category sum (${catSum}) != critical_path total (${result.critical_path.total})`);
  });

  test('hook pre + post totals match hooks total', () => {
    const result = run('--dry-run');
    const hookSum = result.hooks.pre_session.total + result.hooks.post_session.total;
    assert.equal(hookSum, result.hooks.total,
      `pre+post (${hookSum}) != hooks total (${result.hooks.total})`);
  });
});

describe('verdict logic', () => {
  // We test this indirectly through the real output since the functions aren't exported.
  // The verdict depends on combinedPct, gap, and sessionsRemaining.

  test('verdict is a valid enum value', () => {
    const result = run('--summary');
    const valid = ['target_met', 'on_track', 'at_risk', 'behind'];
    assert.ok(valid.includes(result.d071_coverage.verdict));
  });

  test('gap_to_target is consistent with combined pct', () => {
    const cov = run('--summary').d071_coverage;
    const expectedGap = Math.max(0, 80 - cov.combined.pct);
    assert.equal(cov.gap_to_target_pp, expectedGap);
  });

  test('pace_needed is null or a number', () => {
    const cov = run('--summary').d071_coverage;
    assert.ok(
      cov.pace_needed_pp_per_session === null || typeof cov.pace_needed_pp_per_session === 'number',
      'pace should be null or number'
    );
  });
});

describe('trend data', () => {
  test('trend is null or object with expected shape', () => {
    const cov = run('--summary').d071_coverage;
    if (cov.trend !== null) {
      // If trend exists, it should have critical_path at minimum
      if (cov.trend.critical_path) {
        assert.equal(typeof cov.trend.critical_path.previous_pct, 'number');
        assert.equal(typeof cov.trend.critical_path.current_pct, 'number');
        assert.equal(typeof cov.trend.critical_path.delta, 'number');
      }
      if (cov.trend.combined) {
        assert.equal(typeof cov.trend.combined.previous_pct, 'number');
        assert.equal(typeof cov.trend.combined.current_pct, 'number');
        assert.equal(typeof cov.trend.combined.delta, 'number');
      }
    }
  });
});

describe('coverage sanity checks', () => {
  test('critical_path finds known source files', () => {
    const result = run('--dry-run');
    // index.js and api.mjs should always be in critical path
    const allFiles = [
      ...result.by_category.core_and_session.uncovered,
      ...result.by_category.lib_modules.uncovered,
      ...result.by_category.providers.uncovered,
      // covered files aren't listed in full output uncovered arrays,
      // but total count should be > 0
    ];
    assert.ok(result.critical_path.total >= 2,
      'critical path should contain at least index.js and api.mjs');
  });

  test('hooks directory is scanned', () => {
    const result = run('--dry-run');
    assert.ok(result.hooks.total > 0, 'should find at least 1 hook');
  });

  test('uncovered files are relative paths', () => {
    const result = run('--dry-run');
    for (const f of result.critical_path.uncovered) {
      assert.ok(!f.startsWith('/'), `uncovered file should be relative: ${f}`);
    }
  });
});

#!/usr/bin/env node
/**
 * audit-stats-demotion.test.mjs — Tests for computeDemotionProbeCoverage()
 *
 * Covers: cycle math, partial coverage, verdict thresholds,
 * no-demotions edge case, never-probed platforms.
 *
 * Usage: node --test audit-stats-demotion.test.mjs
 * Created: B#704 (wq-1061)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(tmpdir(), 'demotion-probe-test-' + Date.now());
const SRC = join(SCRATCH, 'src');
const STATE = join(SCRATCH, 'state');

function writeJSON(dir, name, data) {
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2) + '\n');
}

/** Scaffold files that audit-stats.mjs reads (other stat functions need these). */
function ensureScaffold() {
  if (!existsSync(join(SRC, 'work-queue.json')))
    writeJSON(SRC, 'work-queue.json', { queue: [] });
  if (!existsSync(join(SRC, 'work-queue-archive.json')))
    writeJSON(SRC, 'work-queue-archive.json', { archived: [] });
  if (!existsSync(join(SRC, 'BRAINSTORMING.md')))
    writeFileSync(join(SRC, 'BRAINSTORMING.md'), '# Brainstorming\n');
  if (!existsSync(join(SRC, 'directives.json')))
    writeJSON(SRC, 'directives.json', { directives: [] });
  if (!existsSync(join(SRC, 'services.json')))
    writeJSON(SRC, 'services.json', { services: [] });
  if (!existsSync(join(SRC, 'resurrect-history.json')))
    writeJSON(SRC, 'resurrect-history.json', []);
  if (!existsSync(join(SRC, 'picker-demotions.json')))
    writeJSON(SRC, 'picker-demotions.json', { demotions: [] });
  if (!existsSync(join(SRC, 'knowledge'))) {
    mkdirSync(join(SRC, 'knowledge'), { recursive: true });
    writeJSON(join(SRC, 'knowledge'), 'patterns.json', { patterns: [] });
  }
}

/**
 * Run patched audit-stats.mjs as subprocess, return demotion_probe_coverage.
 * SESSION_NUM env var controls the session number.
 */
function runStats(sessionNum) {
  let src = readFileSync(join(__dirname, 'audit-stats.mjs'), 'utf8');
  src = src.replace(
    "const STATE_DIR = join(homedir(), '.config/moltbook');",
    `const STATE_DIR = ${JSON.stringify(STATE)};`
  );
  src = src.replace(
    'const PROJECT_DIR = __dirname;',
    `const PROJECT_DIR = ${JSON.stringify(SRC)};`
  );
  const patchedPath = join(SRC, 'audit-stats-patched.mjs');
  writeFileSync(patchedPath, src);

  const output = execSync(
    `SESSION_NUM=${sessionNum} node "${patchedPath}"`,
    { encoding: 'utf8', timeout: 10000, cwd: SRC }
  );
  return JSON.parse(output).demotion_probe_coverage;
}

describe('computeDemotionProbeCoverage', () => {
  before(() => {
    mkdirSync(SRC, { recursive: true });
    mkdirSync(STATE, { recursive: true });
    ensureScaffold();
  });

  after(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('returns no_demotions when demotions list is empty', () => {
    writeJSON(SRC, 'picker-demotions.json', { demotions: [] });
    writeJSON(STATE, 'demotion-probe-cooldown.json', {});

    const result = runStats(100);
    assert.equal(result.total_demoted, 0);
    assert.equal(result.verdict, 'no_demotions');
    assert.equal(result.cycle_coverage_pct, 100);
  });

  it('returns no_probes_yet when cooldown file is empty', () => {
    writeJSON(SRC, 'picker-demotions.json', {
      demotions: [
        { id: 'alpha', reason: 'test', demoted_at: '2026-01-01' },
        { id: 'beta', reason: 'test', demoted_at: '2026-01-01' }
      ]
    });
    writeJSON(STATE, 'demotion-probe-cooldown.json', {});

    const result = runStats(100);
    assert.equal(result.total_demoted, 2);
    assert.equal(result.never_probed, 2);
    assert.equal(result.probed_in_cycle, 0);
    assert.equal(result.cycle_coverage_pct, 0);
    assert.equal(result.verdict, 'no_probes_yet');
  });

  it('computes cycle length as demotions * 5', () => {
    writeJSON(SRC, 'picker-demotions.json', {
      demotions: [
        { id: 'a', reason: 'r' },
        { id: 'b', reason: 'r' },
        { id: 'c', reason: 'r' },
        { id: 'd', reason: 'r' }
      ]
    });
    writeJSON(STATE, 'demotion-probe-cooldown.json', {});

    const result = runStats(100);
    assert.equal(result.cycle_length_sessions, 20);
  });

  it('returns healthy when >=80% probed within cycle', () => {
    // 5 demotions → cycle = 25. currentSession = 100. In-cycle: lastProbed >= 75
    writeJSON(SRC, 'picker-demotions.json', {
      demotions: [
        { id: 'a', reason: 'r' },
        { id: 'b', reason: 'r' },
        { id: 'c', reason: 'r' },
        { id: 'd', reason: 'r' },
        { id: 'e', reason: 'r' }
      ]
    });
    writeJSON(STATE, 'demotion-probe-cooldown.json', {
      a: 90, b: 85, c: 80, d: 76, e: 50
    });

    const result = runStats(100);
    assert.equal(result.total_demoted, 5);
    assert.equal(result.probed_in_cycle, 4);
    assert.equal(result.cycle_coverage_pct, 80);
    assert.equal(result.verdict, 'healthy');
  });

  it('returns partial when >=50% but <80% probed', () => {
    // 4 demotions → cycle = 20. currentSession = 100. In-cycle: lastProbed >= 80
    writeJSON(SRC, 'picker-demotions.json', {
      demotions: [
        { id: 'a', reason: 'r' },
        { id: 'b', reason: 'r' },
        { id: 'c', reason: 'r' },
        { id: 'd', reason: 'r' }
      ]
    });
    writeJSON(STATE, 'demotion-probe-cooldown.json', {
      a: 90, b: 85, c: 50, d: 40
    });

    const result = runStats(100);
    assert.equal(result.total_demoted, 4);
    assert.equal(result.probed_in_cycle, 2);
    assert.equal(result.cycle_coverage_pct, 50);
    assert.equal(result.verdict, 'partial');
  });

  it('returns low_coverage when <50% probed and some have been probed', () => {
    // 4 demotions → cycle = 20. currentSession = 100.
    writeJSON(SRC, 'picker-demotions.json', {
      demotions: [
        { id: 'a', reason: 'r' },
        { id: 'b', reason: 'r' },
        { id: 'c', reason: 'r' },
        { id: 'd', reason: 'r' }
      ]
    });
    // 1 in-cycle (a=95), 1 out-of-cycle (b=50), 2 never probed → 25%
    writeJSON(STATE, 'demotion-probe-cooldown.json', {
      a: 95, b: 50
    });

    const result = runStats(100);
    assert.equal(result.total_demoted, 4);
    assert.equal(result.probed_in_cycle, 1);
    assert.equal(result.cycle_coverage_pct, 25);
    assert.equal(result.never_probed, 2);
    assert.equal(result.verdict, 'low_coverage');
  });

  it('handles missing cooldown file gracefully', () => {
    writeJSON(SRC, 'picker-demotions.json', {
      demotions: [{ id: 'x', reason: 'r' }]
    });
    try { rmSync(join(STATE, 'demotion-probe-cooldown.json')); } catch {}

    const result = runStats(100);
    assert.equal(result.total_demoted, 1);
    assert.equal(result.never_probed, 1);
    assert.equal(result.verdict, 'no_probes_yet');
  });

  it('platform details include correct age and in_current_cycle', () => {
    writeJSON(SRC, 'picker-demotions.json', {
      demotions: [
        { id: 'alpha', reason: 'r' },
        { id: 'beta', reason: 'r' }
      ]
    });
    // cycle = 2*5 = 10. session = 50.
    // alpha: age=5 (in cycle), beta: age=20 (out of cycle)
    writeJSON(STATE, 'demotion-probe-cooldown.json', {
      alpha: 45, beta: 30
    });

    const result = runStats(50);
    const alpha = result.platforms.find(p => p.id === 'alpha');
    const beta = result.platforms.find(p => p.id === 'beta');

    assert.equal(alpha.last_probed_session, 45);
    assert.equal(alpha.age_sessions, 5);
    assert.equal(alpha.in_current_cycle, true);

    assert.equal(beta.last_probed_session, 30);
    assert.equal(beta.age_sessions, 20);
    assert.equal(beta.in_current_cycle, false);
  });
});

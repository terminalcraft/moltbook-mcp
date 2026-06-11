#!/usr/bin/env node
/**
 * audit-stats-resurrect.test.mjs — Tests for computeResurrectPassStats() and computeResurrectRate()
 *
 * Covers: defunct/recovery verdicts, flapping detection, no-data edge cases,
 * circuit-break thresholds, repeat offenders, time-windowed rate.
 *
 * Usage: node --test audit-stats-resurrect.test.mjs
 * Created: B#712 (wq-1068)
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
const SCRATCH = join(tmpdir(), 'resurrect-test-' + Date.now());
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
  if (!existsSync(join(SRC, 'platform-circuits.json')))
    writeJSON(SRC, 'platform-circuits.json', {});
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
 * Run patched audit-stats.mjs as subprocess, return the full stats object.
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
  return JSON.parse(output);
}

// ──────────────────────────────────────────────
// computeResurrectPassStats
// ──────────────────────────────────────────────

describe('computeResurrectPassStats', () => {
  before(() => {
    mkdirSync(SRC, { recursive: true });
    mkdirSync(STATE, { recursive: true });
    ensureScaffold();
  });

  after(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('returns no_defunct when no defunct services and no recoveries', () => {
    writeJSON(SRC, 'services.json', { services: [
      { id: 'alpha', name: 'Alpha', status: 'live' }
    ]});
    writeJSON(SRC, 'platform-circuits.json', {});

    const result = runStats(100).resurrect_pass;
    assert.equal(result.currently_defunct, 0);
    assert.equal(result.cumulative_resurrections, 0);
    assert.equal(result.verdict, 'no_defunct');
  });

  it('returns defunct_no_recovery when defunct services exist but no resurrections', () => {
    writeJSON(SRC, 'services.json', { services: [
      { id: 'bravo', name: 'Bravo', status: 'defunct', defunctAt: '2026-01-15', defunctReason: 'DNS failure' },
      { id: 'charlie', name: 'Charlie', status: 'live' }
    ]});
    writeJSON(SRC, 'platform-circuits.json', {});

    const result = runStats(100).resurrect_pass;
    assert.equal(result.currently_defunct, 1);
    assert.equal(result.defunct_platforms.length, 1);
    assert.equal(result.defunct_platforms[0].id, 'bravo');
    assert.equal(result.defunct_platforms[0].reason, 'DNS failure');
    assert.equal(result.cumulative_resurrections, 0);
    assert.equal(result.verdict, 'defunct_no_recovery');
  });

  it('returns has_recoveries when circuit resurrections exist', () => {
    writeJSON(SRC, 'services.json', { services: [
      { id: 'delta', name: 'Delta', status: 'live' }
    ]});
    writeJSON(SRC, 'platform-circuits.json', {
      delta: { resurrected_at: '2026-03-01', status: 'closed' },
      echo: { resurrected_at: '2026-02-15', status: 'closed' }
    });

    const result = runStats(100).resurrect_pass;
    assert.equal(result.currently_defunct, 0);
    assert.equal(result.cumulative_resurrections, 2);
    assert.equal(result.resurrected_circuits.length, 2);
    assert.equal(result.verdict, 'has_recoveries');
  });

  it('counts service-level resurrections from notes field', () => {
    writeJSON(SRC, 'services.json', { services: [
      { id: 'fox', name: 'Fox', status: 'live', notes: 'Auto-resurrected s1500' },
      { id: 'golf', name: 'Golf', status: 'live', notes: 'Resurrected manually' },
      { id: 'hotel', name: 'Hotel', status: 'live', notes: 'Normal service' }
    ]});
    writeJSON(SRC, 'platform-circuits.json', {});

    const result = runStats(100).resurrect_pass;
    assert.equal(result.cumulative_resurrections, 2);
    assert.deepEqual(result.resurrected_services, ['fox', 'golf']);
    assert.equal(result.verdict, 'has_recoveries');
  });

  it('combines circuit and service resurrections', () => {
    writeJSON(SRC, 'services.json', { services: [
      { id: 'india', name: 'India', status: 'defunct', defunctAt: '2026-04-01', defunctReason: 'timeout' },
      { id: 'juliet', name: 'Juliet', status: 'live', notes: 'Resurrected from DNS issue' }
    ]});
    writeJSON(SRC, 'platform-circuits.json', {
      kilo: { resurrected_at: '2026-03-10', status: 'closed' }
    });

    const result = runStats(100).resurrect_pass;
    assert.equal(result.currently_defunct, 1);
    assert.equal(result.cumulative_resurrections, 2);
    assert.equal(result.verdict, 'has_recoveries');
  });

  it('does not count defunct services with resurrect notes as resurrected', () => {
    // status === 'defunct' means still defunct — notes about resurrect don't count
    writeJSON(SRC, 'services.json', { services: [
      { id: 'lima', name: 'Lima', status: 'defunct', notes: 'Failed resurrect attempt' }
    ]});
    writeJSON(SRC, 'platform-circuits.json', {});

    const result = runStats(100).resurrect_pass;
    assert.equal(result.currently_defunct, 1);
    assert.equal(result.cumulative_resurrections, 0);
    assert.equal(result.verdict, 'defunct_no_recovery');
  });

  it('ignores circuits without resurrected_at', () => {
    writeJSON(SRC, 'services.json', { services: [] });
    writeJSON(SRC, 'platform-circuits.json', {
      mike: { status: 'open', trip_count: 3 },
      november: { resurrected_at: '2026-05-01', status: 'closed' }
    });

    const result = runStats(100).resurrect_pass;
    assert.equal(result.resurrected_circuits.length, 1);
    assert.equal(result.resurrected_circuits[0].platform, 'november');
    assert.equal(result.cumulative_resurrections, 1);
    assert.equal(result.verdict, 'has_recoveries');
  });
});

// ──────────────────────────────────────────────
// computeResurrectRate
// ──────────────────────────────────────────────

describe('computeResurrectRate', () => {
  before(() => {
    mkdirSync(SRC, { recursive: true });
    mkdirSync(STATE, { recursive: true });
    ensureScaffold();
  });

  after(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('returns no_data when resurrect-history.json is empty', () => {
    writeJSON(SRC, 'resurrect-history.json', []);

    const result = runStats(100).resurrect_rate;
    assert.equal(result.total_events, 0);
    assert.equal(result.unique_platforms, 0);
    assert.deepEqual(result.repeat_offenders, []);
    assert.equal(result.verdict, 'no_data');
  });

  it('returns no_data when resurrect-history.json is not an array', () => {
    writeJSON(SRC, 'resurrect-history.json', { broken: true });

    const result = runStats(100).resurrect_rate;
    assert.equal(result.verdict, 'no_data');
    assert.equal(result.total_events, 0);
  });

  it('returns healthy with single events per platform (no flapping)', () => {
    writeJSON(SRC, 'resurrect-history.json', [
      { name: 'Alpha', defunctAt: '2026-01-01', resurrectedAt: '2026-01-05', defunctReason: 'DNS' },
      { name: 'Bravo', defunctAt: '2026-02-01', resurrectedAt: '2026-02-03', defunctReason: 'timeout' }
    ]);

    const result = runStats(100).resurrect_rate;
    assert.equal(result.total_events, 2);
    assert.equal(result.unique_platforms, 2);
    assert.equal(result.repeat_offenders.length, 0);
    assert.equal(result.verdict, 'healthy');
    assert.equal(result.by_platform.Alpha, 1);
    assert.equal(result.by_platform.Bravo, 1);
  });

  it('detects some_flapping with 1-2 repeat offenders', () => {
    writeJSON(SRC, 'resurrect-history.json', [
      { name: 'FlappyBird', defunctAt: '2026-01-01', resurrectedAt: '2026-01-05' },
      { name: 'FlappyBird', defunctAt: '2026-02-01', resurrectedAt: '2026-02-05' },
      { name: 'Stable', defunctAt: '2026-03-01', resurrectedAt: '2026-03-02' }
    ]);

    const result = runStats(100).resurrect_rate;
    assert.equal(result.total_events, 3);
    assert.equal(result.unique_platforms, 2);
    assert.equal(result.repeat_offenders.length, 1);
    assert.equal(result.repeat_offenders[0].platform, 'FlappyBird');
    assert.equal(result.repeat_offenders[0].cycles, 2);
    assert.equal(result.verdict, 'some_flapping');
  });

  it('detects high_flapping with 3+ repeat offenders', () => {
    writeJSON(SRC, 'resurrect-history.json', [
      { name: 'A', defunctAt: '2026-01-01', resurrectedAt: '2026-01-02' },
      { name: 'A', defunctAt: '2026-02-01', resurrectedAt: '2026-02-02' },
      { name: 'B', defunctAt: '2026-01-01', resurrectedAt: '2026-01-02' },
      { name: 'B', defunctAt: '2026-02-01', resurrectedAt: '2026-02-02' },
      { name: 'C', defunctAt: '2026-01-01', resurrectedAt: '2026-01-02' },
      { name: 'C', defunctAt: '2026-02-01', resurrectedAt: '2026-02-02' }
    ]);

    const result = runStats(100).resurrect_rate;
    assert.equal(result.total_events, 6);
    assert.equal(result.unique_platforms, 3);
    assert.equal(result.repeat_offenders.length, 3);
    assert.equal(result.verdict, 'high_flapping');
  });

  it('sorts repeat offenders by cycle count descending', () => {
    writeJSON(SRC, 'resurrect-history.json', [
      { name: 'Few', defunctAt: '2026-01-01', resurrectedAt: '2026-01-02' },
      { name: 'Few', defunctAt: '2026-02-01', resurrectedAt: '2026-02-02' },
      { name: 'Many', defunctAt: '2026-01-01', resurrectedAt: '2026-01-02' },
      { name: 'Many', defunctAt: '2026-02-01', resurrectedAt: '2026-02-02' },
      { name: 'Many', defunctAt: '2026-03-01', resurrectedAt: '2026-03-02' },
      { name: 'Many', defunctAt: '2026-04-01', resurrectedAt: '2026-04-02' }
    ]);

    const result = runStats(100).resurrect_rate;
    assert.equal(result.repeat_offenders[0].platform, 'Many');
    assert.equal(result.repeat_offenders[0].cycles, 4);
    assert.equal(result.repeat_offenders[1].platform, 'Few');
    assert.equal(result.repeat_offenders[1].cycles, 2);
  });

  it('counts recent_30d events correctly', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

    writeJSON(SRC, 'resurrect-history.json', [
      { name: 'Recent1', defunctAt: '2026-01-01', resurrectedAt: recent },
      { name: 'Recent2', defunctAt: '2026-01-01', resurrectedAt: recent },
      { name: 'Old', defunctAt: '2025-01-01', resurrectedAt: old }
    ]);

    const result = runStats(100).resurrect_rate;
    assert.equal(result.total_events, 3);
    assert.equal(result.recent_30d, 2);
  });

  it('handles events with missing name field', () => {
    writeJSON(SRC, 'resurrect-history.json', [
      { defunctAt: '2026-01-01', resurrectedAt: '2026-01-05' }
    ]);

    const result = runStats(100).resurrect_rate;
    assert.equal(result.total_events, 1);
    assert.equal(result.by_platform.unknown, 1);
    assert.equal(result.verdict, 'healthy');
  });

  it('handles events with missing resurrectedAt for 30d window', () => {
    writeJSON(SRC, 'resurrect-history.json', [
      { name: 'NoDate', defunctAt: '2026-01-01' }
    ]);

    const result = runStats(100).resurrect_rate;
    assert.equal(result.total_events, 1);
    assert.equal(result.recent_30d, 0);
    assert.equal(result.verdict, 'healthy');
  });
});

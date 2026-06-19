#!/usr/bin/env node
/**
 * audit-stats-substitution-rate.test.mjs — Integration tests for computeBackupSubstitutionRate()
 *
 * Tests the function directly via stateDir override (wq-1080 pattern) with
 * synthetic engagement trace data. Covers: empty archives, all-substitution
 * sessions, platform distribution edge cases, archive+current merging.
 *
 * Usage: node --test audit-stats-substitution-rate.test.mjs
 * Created: B#728 (wq-1084)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeBackupSubstitutionRate } from './audit-stats.mjs';

const SCRATCH = join(tmpdir(), 'sub-rate-test-' + Date.now());

function writeJSON(dir, name, data) {
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2) + '\n');
}

function makeTrace(session, subs = []) {
  return {
    session,
    platforms_engaged: ['Moltchan'],
    backup_substitutions: subs
  };
}

function makeSub(original, replacement, reason = 'down') {
  return { original, replacement, reason };
}

describe('computeBackupSubstitutionRate (direct, wq-1084)', () => {
  before(() => {
    mkdirSync(SCRATCH, { recursive: true });
  });

  after(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  // ── Empty / missing data ──

  it('returns no_data when both trace files are empty arrays', () => {
    writeJSON(SCRATCH, 'engagement-trace.json', []);
    writeJSON(SCRATCH, 'engagement-trace-archive.json', []);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.sessions_checked, 0);
    assert.equal(r.total_substitutions, 0);
    assert.equal(r.verdict, 'no_data');
  });

  it('returns no_data when trace files do not exist', () => {
    const empty = join(tmpdir(), 'sub-rate-empty-' + Date.now());
    mkdirSync(empty, { recursive: true });

    const r = computeBackupSubstitutionRate({ stateDir: empty });
    assert.equal(r.sessions_checked, 0);
    assert.equal(r.verdict, 'no_data');

    rmSync(empty, { recursive: true, force: true });
  });

  it('returns no_data with empty archive and missing current trace', () => {
    const dir = join(tmpdir(), 'sub-rate-partial-' + Date.now());
    mkdirSync(dir, { recursive: true });
    writeJSON(dir, 'engagement-trace-archive.json', []);

    const r = computeBackupSubstitutionRate({ stateDir: dir });
    assert.equal(r.sessions_checked, 0);
    assert.equal(r.verdict, 'no_data');

    rmSync(dir, { recursive: true, force: true });
  });

  // ── Clean sessions ──

  it('returns clean when no substitutions exist', () => {
    writeJSON(SCRATCH, 'engagement-trace-archive.json', []);
    writeJSON(SCRATCH, 'engagement-trace.json', [
      makeTrace(100),
      makeTrace(101),
      makeTrace(102)
    ]);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.sessions_checked, 3);
    assert.equal(r.total_substitutions, 0);
    assert.equal(r.verdict, 'clean');
  });

  // ── All-substitution sessions ──

  it('counts correctly when every session has substitutions', () => {
    const traces = [];
    for (let i = 0; i < 5; i++) {
      traces.push(makeTrace(200 + i, [
        makeSub('Bluesky', '4claw', '403'),
        makeSub('Tulip', 'Chatr', 'timeout')
      ]));
    }
    writeJSON(SCRATCH, 'engagement-trace-archive.json', []);
    writeJSON(SCRATCH, 'engagement-trace.json', traces);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.sessions_checked, 5);
    assert.equal(r.total_substitutions, 10);
    assert.equal(r.by_platform.Bluesky, 5);
    assert.equal(r.by_platform.Tulip, 5);
    assert.equal(r.circuit_break_candidates.length, 2);
    assert.equal(r.verdict, 'circuit_break_recommended');
  });

  it('reports circuit break for 10 sessions all with same platform substituted', () => {
    const traces = [];
    for (let i = 0; i < 10; i++) {
      traces.push(makeTrace(300 + i, [makeSub('Pinchwork', 'Moltchan', 'auth')]));
    }
    writeJSON(SCRATCH, 'engagement-trace-archive.json', []);
    writeJSON(SCRATCH, 'engagement-trace.json', traces);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.sessions_checked, 10);
    assert.equal(r.total_substitutions, 10);
    assert.equal(r.circuit_break_candidates.length, 1);
    assert.equal(r.circuit_break_candidates[0].platform, 'Pinchwork');
    assert.equal(r.circuit_break_candidates[0].count, 10);
    assert.equal(r.circuit_break_candidates[0].rate, '10/10');
    assert.equal(r.verdict, 'circuit_break_recommended');
  });

  // ── Platform distribution edge cases ──

  it('ranks multiple platforms by substitution frequency', () => {
    writeJSON(SCRATCH, 'engagement-trace-archive.json', []);
    writeJSON(SCRATCH, 'engagement-trace.json', [
      makeTrace(400, [makeSub('Bluesky', '4claw'), makeSub('Tulip', 'Chatr')]),
      makeTrace(401, [makeSub('Bluesky', 'Moltchan')]),
      makeTrace(402, [makeSub('Tulip', '4claw'), makeSub('Pinchwork', 'Moltchan')]),
      makeTrace(403, [makeSub('Bluesky', 'Chatr')]),
      makeTrace(404, [])
    ]);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.sessions_checked, 5);
    assert.equal(r.total_substitutions, 6);
    // Bluesky: 3, Tulip: 2, Pinchwork: 1
    assert.equal(r.by_platform.Bluesky, 3);
    assert.equal(r.by_platform.Tulip, 2);
    assert.equal(r.by_platform.Pinchwork, 1);
    // Bluesky at 3/5 triggers circuit break
    assert.equal(r.circuit_break_candidates.length, 1);
    assert.equal(r.circuit_break_candidates[0].platform, 'Bluesky');
    assert.equal(r.verdict, 'circuit_break_recommended');
  });

  it('returns occasional when substitutions exist but below circuit-break threshold', () => {
    writeJSON(SCRATCH, 'engagement-trace-archive.json', []);
    const traces = [];
    for (let i = 0; i < 10; i++) {
      traces.push(makeTrace(500 + i, i < 2
        ? [makeSub('Tulip', 'Moltchan')]
        : []
      ));
    }
    writeJSON(SCRATCH, 'engagement-trace.json', traces);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.sessions_checked, 10);
    assert.equal(r.total_substitutions, 2);
    assert.equal(r.circuit_break_candidates.length, 0);
    assert.equal(r.verdict, 'occasional');
  });

  it('handles traces with missing backup_substitutions field', () => {
    writeJSON(SCRATCH, 'engagement-trace-archive.json', []);
    writeJSON(SCRATCH, 'engagement-trace.json', [
      { session: 600, platforms_engaged: ['Moltchan'] },
      { session: 601, platforms_engaged: ['4claw'], backup_substitutions: [makeSub('Bluesky', '4claw')] }
    ]);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.sessions_checked, 2);
    assert.equal(r.total_substitutions, 1);
    assert.equal(r.verdict, 'occasional');
  });

  // ── Archive + current merging ──

  it('merges archive and current, uses only last 10', () => {
    const archive = [];
    for (let i = 0; i < 12; i++) {
      archive.push(makeTrace(700 + i, [makeSub('OldPlatform', 'Moltchan')]));
    }
    const current = [];
    for (let i = 0; i < 3; i++) {
      current.push(makeTrace(720 + i));
    }
    writeJSON(SCRATCH, 'engagement-trace-archive.json', archive);
    writeJSON(SCRATCH, 'engagement-trace.json', current);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.sessions_checked, 10);
    // Last 10: archive[5..11] (7 subs) + current[0..2] (0 subs)
    assert.equal(r.total_substitutions, 7);
    assert.equal(r.by_platform.OldPlatform, 7);
    assert.equal(r.circuit_break_candidates.length, 1);
  });

  it('works with only archive data and no current trace', () => {
    writeJSON(SCRATCH, 'engagement-trace-archive.json', [
      makeTrace(800, [makeSub('Bluesky', '4claw')]),
      makeTrace(801)
    ]);
    writeJSON(SCRATCH, 'engagement-trace.json', []);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.sessions_checked, 2);
    assert.equal(r.total_substitutions, 1);
    assert.equal(r.verdict, 'occasional');
  });

  // ── Single session edge case ──

  it('handles exactly one session', () => {
    writeJSON(SCRATCH, 'engagement-trace-archive.json', []);
    writeJSON(SCRATCH, 'engagement-trace.json', [
      makeTrace(900, [makeSub('Tulip', 'Moltchan')])
    ]);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.sessions_checked, 1);
    assert.equal(r.total_substitutions, 1);
    assert.ok(r.summary.includes('1 substitutions'));
    assert.ok(r.summary.includes('Tulip'));
    assert.equal(r.verdict, 'occasional');
  });

  // ── Many platforms, even distribution ──

  it('handles many platforms with even substitution distribution', () => {
    const platforms = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
    const traces = [];
    for (let i = 0; i < 10; i++) {
      traces.push(makeTrace(1000 + i, [
        makeSub(platforms[i % platforms.length], 'Moltchan')
      ]));
    }
    writeJSON(SCRATCH, 'engagement-trace-archive.json', []);
    writeJSON(SCRATCH, 'engagement-trace.json', traces);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.sessions_checked, 10);
    assert.equal(r.total_substitutions, 10);
    // Each platform: 2 subs out of 10 — below threshold of 3
    for (const p of platforms) {
      assert.equal(r.by_platform[p], 2);
    }
    assert.equal(r.circuit_break_candidates.length, 0);
    assert.equal(r.verdict, 'occasional');
  });

  // ── Boundary: exactly 3 substitutions triggers circuit break ──

  it('triggers circuit break at exactly 3 substitutions for one platform', () => {
    const traces = [];
    for (let i = 0; i < 10; i++) {
      traces.push(makeTrace(1100 + i, i < 3
        ? [makeSub('Bluesky', '4claw')]
        : []
      ));
    }
    writeJSON(SCRATCH, 'engagement-trace-archive.json', []);
    writeJSON(SCRATCH, 'engagement-trace.json', traces);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.circuit_break_candidates.length, 1);
    assert.equal(r.circuit_break_candidates[0].platform, 'Bluesky');
    assert.equal(r.circuit_break_candidates[0].count, 3);
    assert.equal(r.circuit_break_candidates[0].rate, '3/10');
    assert.equal(r.verdict, 'circuit_break_recommended');
  });

  it('does not trigger circuit break at exactly 2 substitutions', () => {
    const traces = [];
    for (let i = 0; i < 10; i++) {
      traces.push(makeTrace(1200 + i, i < 2
        ? [makeSub('Bluesky', '4claw')]
        : []
      ));
    }
    writeJSON(SCRATCH, 'engagement-trace-archive.json', []);
    writeJSON(SCRATCH, 'engagement-trace.json', traces);

    const r = computeBackupSubstitutionRate({ stateDir: SCRATCH });
    assert.equal(r.circuit_break_candidates.length, 0);
    assert.equal(r.verdict, 'occasional');
  });
});

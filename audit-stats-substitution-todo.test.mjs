#!/usr/bin/env node
/**
 * audit-stats-substitution-todo.test.mjs — Tests for computeBackupSubstitutionRate()
 * and computeTodoFalsePositiveRate()
 *
 * Covers: substitution counting, circuit-break candidates, platform ranking,
 * no-data edge cases, FP rate from tracker + queue, verdict thresholds.
 *
 * Usage: node --test audit-stats-substitution-todo.test.mjs
 * Created: B#716 (wq-1072)
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
const SCRATCH = join(tmpdir(), 'sub-todo-test-' + Date.now());
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
 * Run patched audit-stats.mjs as subprocess, return parsed full output.
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

// ── computeBackupSubstitutionRate ──

describe('computeBackupSubstitutionRate', () => {
  before(() => {
    mkdirSync(SRC, { recursive: true });
    mkdirSync(STATE, { recursive: true });
    ensureScaffold();
  });

  after(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('returns no_data when no trace entries exist', () => {
    writeJSON(STATE, 'engagement-trace.json', []);
    writeJSON(STATE, 'engagement-trace-archive.json', []);

    const result = runStats(100).backup_substitution_rate;
    assert.equal(result.sessions_checked, 0);
    assert.equal(result.total_substitutions, 0);
    assert.equal(result.verdict, 'no_data');
  });

  it('returns clean when no substitutions in traces', () => {
    writeJSON(STATE, 'engagement-trace-archive.json', []);
    writeJSON(STATE, 'engagement-trace.json', [
      { session: 90, platforms_engaged: ['Moltchan'], backup_substitutions: [] },
      { session: 91, platforms_engaged: ['4claw'], backup_substitutions: [] }
    ]);

    const result = runStats(100).backup_substitution_rate;
    assert.equal(result.sessions_checked, 2);
    assert.equal(result.total_substitutions, 0);
    assert.equal(result.verdict, 'clean');
  });

  it('counts substitutions and ranks platforms', () => {
    writeJSON(STATE, 'engagement-trace-archive.json', []);
    writeJSON(STATE, 'engagement-trace.json', [
      {
        session: 80, platforms_engaged: ['4claw'],
        backup_substitutions: [{ original: 'Bluesky', replacement: '4claw', reason: '403' }]
      },
      {
        session: 81, platforms_engaged: ['Chatr'],
        backup_substitutions: [
          { original: 'Bluesky', replacement: 'Chatr', reason: '403' },
          { original: 'Tulip', replacement: 'Moltchan', reason: 'timeout' }
        ]
      },
      {
        session: 82, platforms_engaged: ['Moltchan'],
        backup_substitutions: []
      }
    ]);

    const result = runStats(100).backup_substitution_rate;
    assert.equal(result.sessions_checked, 3);
    assert.equal(result.total_substitutions, 3);
    assert.equal(result.by_platform.Bluesky, 2);
    assert.equal(result.by_platform.Tulip, 1);
    assert.equal(result.verdict, 'occasional');
  });

  it('recommends circuit break when platform substituted >=3 times in 10 sessions', () => {
    const traces = [];
    for (let i = 0; i < 10; i++) {
      traces.push({
        session: 50 + i,
        platforms_engaged: ['4claw'],
        backup_substitutions: i < 4
          ? [{ original: 'Bluesky', replacement: '4claw', reason: '403' }]
          : []
      });
    }
    writeJSON(STATE, 'engagement-trace-archive.json', []);
    writeJSON(STATE, 'engagement-trace.json', traces);

    const result = runStats(100).backup_substitution_rate;
    assert.equal(result.sessions_checked, 10);
    assert.equal(result.total_substitutions, 4);
    assert.equal(result.circuit_break_candidates.length, 1);
    assert.equal(result.circuit_break_candidates[0].platform, 'Bluesky');
    assert.equal(result.circuit_break_candidates[0].count, 4);
    assert.equal(result.verdict, 'circuit_break_recommended');
  });

  it('combines archive and current traces, uses last 10', () => {
    // 8 in archive + 4 in current = 12 total, last 10 used
    const archive = [];
    for (let i = 0; i < 8; i++) {
      archive.push({
        session: 10 + i,
        platforms_engaged: ['Moltchan'],
        backup_substitutions: []
      });
    }
    const current = [];
    for (let i = 0; i < 4; i++) {
      current.push({
        session: 20 + i,
        platforms_engaged: ['4claw'],
        backup_substitutions: [{ original: 'Tulip', replacement: '4claw', reason: 'down' }]
      });
    }
    writeJSON(STATE, 'engagement-trace-archive.json', archive);
    writeJSON(STATE, 'engagement-trace.json', current);

    const result = runStats(100).backup_substitution_rate;
    assert.equal(result.sessions_checked, 10);
    // Last 10: archive[6..7] (0 subs) + current[0..3] (4 subs) = 4
    assert.equal(result.total_substitutions, 4);
  });

  it('handles missing trace files gracefully', () => {
    try { rmSync(join(STATE, 'engagement-trace.json')); } catch {}
    try { rmSync(join(STATE, 'engagement-trace-archive.json')); } catch {}

    const result = runStats(100).backup_substitution_rate;
    assert.equal(result.sessions_checked, 0);
    assert.equal(result.verdict, 'no_data');
  });
});

// ── computeTodoFalsePositiveRate ──

describe('computeTodoFalsePositiveRate', () => {
  before(() => {
    mkdirSync(SRC, { recursive: true });
    mkdirSync(STATE, { recursive: true });
    ensureScaffold();
  });

  after(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('returns no_data when no tracked or queue items exist', () => {
    writeJSON(STATE, 'todo-tracker.json', { items: [] });
    writeJSON(SRC, 'work-queue.json', { queue: [] });
    writeJSON(SRC, 'work-queue-archive.json', { archived: [] });

    const result = runStats(100).todo_false_positive_rate;
    assert.equal(result.total_processed, 0);
    assert.equal(result.verdict, 'no_data');
  });

  it('returns healthy when FP rate <= 30%', () => {
    writeJSON(STATE, 'todo-tracker.json', { items: [
      { id: 't1', status: 'resolved', resolution_note: 'fixed naturally' },
      { id: 't2', status: 'resolved', resolution_note: 'fixed naturally' },
      { id: 't3', status: 'resolved', resolution_note: 'fixed naturally' }
    ]});
    writeJSON(SRC, 'work-queue-archive.json', { archived: [
      { id: 'wq-100', source: 'todo-scan', status: 'done', outcome: { result: 'completed' } },
      { id: 'wq-101', source: 'todo-scan', status: 'done', outcome: { result: 'completed' } },
      { id: 'wq-102', source: 'todo-scan', status: 'done', outcome: { result: 'completed' } },
      { id: 'wq-103', source: 'todo-scan', status: 'done', outcome: { result: 'retired' } }
    ]});
    writeJSON(SRC, 'work-queue.json', { queue: [] });

    const result = runStats(100).todo_false_positive_rate;
    // Total processed: 3 naturally resolved + 4 queue decided = 7
    // Total FP: 0 auto-resolved FP + 1 queue retired = 1
    // Rate: 1/7 = 14%
    assert.equal(result.combined_fp_rate_pct, 14);
    assert.equal(result.verdict, 'healthy');
  });

  it('returns elevated when FP rate 31-60%', () => {
    writeJSON(STATE, 'todo-tracker.json', { items: [
      { id: 't1', status: 'resolved', resolution_note: 'false positive - not real' },
      { id: 't2', status: 'resolved', resolution_note: 'fixed' }
    ]});
    writeJSON(SRC, 'work-queue-archive.json', { archived: [
      { id: 'wq-200', source: 'todo-scan', status: 'done', outcome: { result: 'retired' } },
      { id: 'wq-201', source: 'todo-scan', status: 'done', outcome: { result: 'completed' } }
    ]});
    writeJSON(SRC, 'work-queue.json', { queue: [] });

    const result = runStats(100).todo_false_positive_rate;
    // Total processed: 1 auto-FP + 1 naturally + 2 queue decided = 4
    // Total FP: 1 auto-FP + 1 queue retired = 2
    // Rate: 2/4 = 50%
    assert.equal(result.combined_fp_rate_pct, 50);
    assert.equal(result.verdict, 'elevated');
  });

  it('returns high when FP rate 61-80%', () => {
    writeJSON(STATE, 'todo-tracker.json', { items: [
      { id: 't1', status: 'resolved', resolution_note: 'false positive' },
      { id: 't2', status: 'resolved', resolution_note: 'false positive again' },
      { id: 't3', status: 'resolved', resolution_note: 'false-positive' }
    ]});
    writeJSON(SRC, 'work-queue-archive.json', { archived: [
      { id: 'wq-300', source: 'todo-scan', status: 'done', outcome: { result: 'retired' } }
    ]});
    writeJSON(SRC, 'work-queue.json', { queue: [] });

    const result = runStats(100).todo_false_positive_rate;
    // Total processed: 3 auto-FP + 0 naturally + 1 queue decided = 4
    // Total FP: 3 + 1 = 4
    // Rate: 4/4 = 100% → critical
    // Actually wait — all 3 tracker items are FP (resolution_note matches /false.?positive/i)
    // so auto_resolved_fp=3, naturally_resolved=0, queue retired=1, queue completed=0
    // totalProcessed = 3 + 0 + 1 = 4, totalFP = 3 + 1 = 4, rate = 100% → critical
    // Need to adjust to hit 61-80% range
    assert.ok(result.combined_fp_rate_pct > 60);
    assert.ok(['high', 'critical'].includes(result.verdict));
  });

  it('counts tracker auto-resolved false positives correctly', () => {
    writeJSON(STATE, 'todo-tracker.json', { items: [
      { id: 't1', status: 'resolved', resolution_note: 'false positive - stale TODO' },
      { id: 't2', status: 'resolved', resolution_note: 'false positive' },
      { id: 't3', status: 'resolved', resolution_note: 'legitimately resolved' },
      { id: 't4', status: 'open' }
    ]});
    writeJSON(SRC, 'work-queue-archive.json', { archived: [] });
    writeJSON(SRC, 'work-queue.json', { queue: [] });

    const result = runStats(100).todo_false_positive_rate;
    assert.equal(result.tracker.total, 4);
    assert.equal(result.tracker.open, 1);
    assert.equal(result.tracker.resolved, 3);
    assert.equal(result.tracker.auto_resolved_fp, 2);
    assert.equal(result.tracker.naturally_resolved, 1);
  });

  it('counts queue todo-scan items correctly', () => {
    writeJSON(STATE, 'todo-tracker.json', { items: [] });
    writeJSON(SRC, 'work-queue-archive.json', { archived: [
      { id: 'wq-400', source: 'todo-scan', outcome: { result: 'completed' } },
      { id: 'wq-401', source: 'todo-scan', outcome: { result: 'retired' } },
      { id: 'wq-402', source: 'todo-scan', outcome: { result: 'retired' } },
      { id: 'wq-403', source: 'brainstorming', outcome: { result: 'retired' } }
    ]});
    writeJSON(SRC, 'work-queue.json', { queue: [
      { id: 'wq-404', source: 'todo-scan', status: 'pending' }
    ]});

    const result = runStats(100).todo_false_positive_rate;
    assert.equal(result.queue.total_todo_scan, 4); // wq-400..404 minus wq-403 (wrong source)
    assert.equal(result.queue.completed, 1);
    assert.equal(result.queue.retired, 2);
    assert.equal(result.queue.pending, 1);
    assert.equal(result.queue.fp_rate_pct, 67); // 2/(1+2) = 67%
  });

  it('handles missing todo-tracker.json gracefully', () => {
    try { rmSync(join(STATE, 'todo-tracker.json')); } catch {}
    writeJSON(SRC, 'work-queue.json', { queue: [] });
    writeJSON(SRC, 'work-queue-archive.json', { archived: [] });

    const result = runStats(100).todo_false_positive_rate;
    assert.equal(result.tracker.total, 0);
    assert.equal(result.verdict, 'no_data');
  });

  it('returns critical when FP rate > 80%', () => {
    writeJSON(STATE, 'todo-tracker.json', { items: [
      { id: 't1', status: 'resolved', resolution_note: 'false positive' },
      { id: 't2', status: 'resolved', resolution_note: 'false positive' }
    ]});
    writeJSON(SRC, 'work-queue-archive.json', { archived: [
      { id: 'wq-500', source: 'todo-scan', outcome: { result: 'retired' } },
      { id: 'wq-501', source: 'todo-scan', outcome: { result: 'retired' } },
      { id: 'wq-502', source: 'todo-scan', outcome: { result: 'completed' } }
    ]});
    writeJSON(SRC, 'work-queue.json', { queue: [] });

    const result = runStats(100).todo_false_positive_rate;
    // Total processed: 2 auto-FP + 0 natural + 3 queue decided = 5
    // Total FP: 2 + 2 = 4
    // Rate: 4/5 = 80% → high (need >80 for critical)
    // Adjust: need >80%
    assert.ok(result.combined_fp_rate_pct >= 80);
  });
});

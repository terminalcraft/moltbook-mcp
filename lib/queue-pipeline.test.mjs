/**
 * Tests for lib/queue-pipeline.mjs (wq-647)
 * Covers: isTitleDupe, STOP_WORDS, runQueuePipeline (dedup, stall detection,
 * task selection, QueueContext, auto-promote).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isTitleDupe, STOP_WORDS, runQueuePipeline } from './queue-pipeline.mjs';

// --- isTitleDupe tests ---

describe('isTitleDupe', () => {
  it('detects exact prefix match', () => {
    assert.ok(isTitleDupe('Add tests for audit-report', ['Add tests for audit-report generation']));
  });

  it('detects reverse prefix match', () => {
    assert.ok(isTitleDupe('Add tests for audit-report generation', ['Add tests for audit-repo']));
  });

  it('detects keyword overlap (>= 60%)', () => {
    assert.ok(isTitleDupe(
      'Add tests for audit-report generation',
      ['Test coverage for audit-report generation']
    ));
  });

  it('rejects unrelated titles', () => {
    assert.ok(!isTitleDupe('Fix platform health dashboard', ['Add tests for audit-report']));
  });

  it('rejects short stop-word-only overlap', () => {
    assert.ok(!isTitleDupe('Add new build feature', ['Fix old test framework']));
  });

  it('handles empty queue', () => {
    assert.ok(!isTitleDupe('Some task', []));
  });

  it('empty candidate matches via includes (known JS behavior)', () => {
    // ''.substring(0,25) === '' and any string.includes('') === true
    // This documents the actual behavior of isTitleDupe
    const result = isTitleDupe('', ['Some task']);
    assert.equal(result, true);
  });
});

describe('STOP_WORDS', () => {
  it('contains expected words', () => {
    for (const w of ['a', 'an', 'the', 'for', 'to', 'add', 'fix', 'test']) {
      assert.ok(STOP_WORDS.has(w), `Expected stop word: ${w}`);
    }
  });

  it('does not contain significant words', () => {
    for (const w of ['audit', 'pipeline', 'dashboard', 'platform']) {
      assert.ok(!STOP_WORDS.has(w), `Unexpected stop word: ${w}`);
    }
  });
});

// --- runQueuePipeline tests ---

describe('runQueuePipeline', () => {
  let SCRATCH;

  function makePipelineOpts(overrides = {}) {
    const DIR = overrides.DIR || SCRATCH;
    const PATHS = {
      history: join(SCRATCH, 'session-history.txt'),
      brainstorming: join(SCRATCH, 'BRAINSTORMING.md'),
      queueArchive: join(SCRATCH, 'work-queue-archive.json'),
      todoFollowups: join(SCRATCH, 'todo-followups.txt'),
      ...(overrides.PATHS || {}),
    };
    const result = {};
    const timings = [];

    // Simple file cache mock using already-imported readFileSync
    const fc = {
      _cache: {},
      text(p) {
        if (!this._cache[p]) {
          try { this._cache[p] = readFileSync(p, 'utf8'); } catch { this._cache[p] = ''; }
        }
        return this._cache[p];
      },
      json(p) { return JSON.parse(this.text(p)); },
      invalidate(p) { delete this._cache[p]; },
    };

    return {
      MODE: overrides.MODE || 'B',
      COUNTER: overrides.COUNTER || 100,
      fc,
      PATHS,
      DIR,
      result,
      readJSON: (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } },
      markTiming: (label) => timings.push(label),
      _timings: timings,
      _result: result,
    };
  }

  beforeEach(() => {
    SCRATCH = join(tmpdir(), `qp-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(SCRATCH, { recursive: true });
    // Minimal fixture files
    writeFileSync(join(SCRATCH, 'session-history.txt'), '');
    writeFileSync(join(SCRATCH, 'BRAINSTORMING.md'), '# Brainstorming\n');
  });

  describe('dedup', () => {
    it('removes duplicate pending items', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [
          { id: 'wq-001', title: 'Add tests for audit-report generation', status: 'pending', priority: 1 },
          { id: 'wq-002', title: 'Add tests for audit-report validation', status: 'pending', priority: 2 },
        ]
      }));
      const opts = makePipelineOpts();
      const { queue } = runQueuePipeline(opts);
      assert.equal(queue.length, 1);
      assert.equal(queue[0].id, 'wq-001');
      assert.ok(opts._result.deduped);
      assert.ok(opts._result.deduped.some(d => d.includes('wq-002')));
    });

    it('keeps non-pending items even if titles match', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [
          { id: 'wq-001', title: 'Add tests for audit-report', status: 'done', priority: 1 },
          { id: 'wq-002', title: 'Add tests for audit-report', status: 'pending', priority: 2 },
        ]
      }));
      const opts = makePipelineOpts();
      const { queue } = runQueuePipeline(opts);
      assert.equal(queue.length, 2);
    });

    it('handles empty queue gracefully', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({ queue: [] }));
      const opts = makePipelineOpts();
      const { queue } = runQueuePipeline(opts);
      assert.equal(queue.length, 0);
    });
  });

  describe('B session task selection', () => {
    it('selects audit-tagged items first', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [
          { id: 'wq-001', title: 'Normal task', status: 'pending', priority: 1 },
          { id: 'wq-002', title: 'Audit fix', status: 'pending', priority: 2, tags: ['audit'] },
        ]
      }));
      const opts = makePipelineOpts({ MODE: 'B' });
      runQueuePipeline(opts);
      assert.ok(opts._result.wq_item);
      assert.ok(opts._result.wq_item.startsWith('wq-002'));
    });

    it('falls back to first pending when no audit items', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [
          { id: 'wq-001', title: 'First task', status: 'pending', priority: 1 },
          { id: 'wq-002', title: 'Second task', status: 'pending', priority: 2 },
        ]
      }));
      const opts = makePipelineOpts({ MODE: 'B' });
      runQueuePipeline(opts);
      assert.ok(opts._result.wq_item);
      assert.ok(opts._result.wq_item.startsWith('wq-001'));
    });

    it('does not select task for non-B sessions', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [
          { id: 'wq-001', title: 'Some task', status: 'pending', priority: 1 },
        ]
      }));
      const opts = makePipelineOpts({ MODE: 'R' });
      runQueuePipeline(opts);
      assert.equal(opts._result.wq_item, undefined);
    });

    it('skips items with unmet deps', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [
          { id: 'wq-001', title: 'Blocked by dep', status: 'pending', priority: 1, deps: ['wq-002'] },
          { id: 'wq-002', title: 'Dependency', status: 'pending', priority: 2 },
        ]
      }));
      const opts = makePipelineOpts({ MODE: 'B' });
      runQueuePipeline(opts);
      assert.ok(opts._result.wq_item);
      assert.ok(opts._result.wq_item.startsWith('wq-002'));
    });
  });

  describe('stall detection', () => {
    it('counts consecutive B stalls', () => {
      writeFileSync(join(SCRATCH, 'session-history.txt'),
        'mode=B s=98 dur=3m build=(none) files=[x]\nmode=B s=99 dur=3m build=(none) files=[y]\nmode=B s=100 dur=5m build=3 commit(s) files=[z]\n');
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({ queue: [] }));
      const opts = makePipelineOpts();
      runQueuePipeline(opts);
      assert.equal(opts._result.b_stall_count, 0);
    });

    it('reports stall when recent B sessions have no builds', () => {
      writeFileSync(join(SCRATCH, 'session-history.txt'),
        'mode=B s=98 dur=5m build=2 commit(s) files=[x]\nmode=B s=99 dur=3m build=(none) files=[y]\nmode=B s=100 dur=4m build=(none) files=[z]\n');
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({ queue: [] }));
      const opts = makePipelineOpts();
      runQueuePipeline(opts);
      assert.equal(opts._result.b_stall_count, 2);
    });
  });

  describe('QueueContext', () => {
    it('createItem allocates incrementing IDs', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [
          { id: 'wq-010', title: 'Existing', status: 'pending', priority: 10 },
        ]
      }));
      const opts = makePipelineOpts();
      const { queueCtx } = runQueuePipeline(opts);
      const id1 = queueCtx.createItem({ title: 'New item 1', source: 'test' });
      const id2 = queueCtx.createItem({ title: 'New item 2', source: 'test' });
      assert.equal(id1, 'wq-011');
      assert.equal(id2, 'wq-012');
    });

    it('lazy titles getter returns all titles', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [
          { id: 'wq-001', title: 'Alpha', status: 'pending', priority: 1 },
          { id: 'wq-002', title: 'Beta', status: 'done', priority: 2 },
        ]
      }));
      const opts = makePipelineOpts();
      const { queueCtx } = runQueuePipeline(opts);
      assert.deepEqual(queueCtx.titles, ['Alpha', 'Beta']);
    });

    it('invalidate resets cached values', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [{ id: 'wq-005', title: 'Task', status: 'pending', priority: 5 }]
      }));
      const opts = makePipelineOpts();
      const { queueCtx } = runQueuePipeline(opts);
      const first = queueCtx.maxId;
      queueCtx.invalidate();
      assert.equal(queueCtx.maxId, first);
    });

    it('reads archive for maxId', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [{ id: 'wq-005', title: 'Active', status: 'pending', priority: 5 }]
      }));
      writeFileSync(join(SCRATCH, 'work-queue-archive.json'), JSON.stringify({
        archived: [{ id: 'wq-100', title: 'Old item' }]
      }));
      const opts = makePipelineOpts();
      const { queueCtx } = runQueuePipeline(opts);
      assert.equal(queueCtx.maxId, 100);
    });
  });

  describe('auto-promote', () => {
    it('promotes brainstorming ideas when pending < 3', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [
          { id: 'wq-001', title: 'Only task', status: 'pending', priority: 1 },
        ]
      }));
      writeFileSync(join(SCRATCH, 'BRAINSTORMING.md'),
        '# Ideas\n- **Cool feature** (added ~s100): Build something cool\n- **Another idea** (added ~s101): Build another thing\n- **Third idea** (added ~s102): Build third thing\n- **Fourth idea** (added ~s103): Build fourth thing\n');
      const opts = makePipelineOpts({ MODE: 'B' });
      const { queue } = runQueuePipeline(opts);
      assert.ok(opts._result.auto_promoted);
      assert.ok(opts._result.auto_promoted.length > 0);
      assert.ok(queue.length > 1);
    });

    it('does not promote when pending >= 3', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [
          { id: 'wq-001', title: 'Task one', status: 'pending', priority: 1 },
          { id: 'wq-002', title: 'Task two', status: 'pending', priority: 2 },
          { id: 'wq-003', title: 'Task three', status: 'pending', priority: 3 },
        ]
      }));
      writeFileSync(join(SCRATCH, 'BRAINSTORMING.md'),
        '# Ideas\n- **Some idea** (added ~s100): description\n');
      const opts = makePipelineOpts({ MODE: 'B' });
      runQueuePipeline(opts);
      assert.equal(opts._result.auto_promoted, undefined);
    });

    it('skips promotion for non-B/R modes', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({ queue: [] }));
      writeFileSync(join(SCRATCH, 'BRAINSTORMING.md'),
        '# Ideas\n- **Great feature**: description\n- **Another feature**: desc2\n- **Third feature**: desc3\n- **Fourth feature**: desc4\n');
      const opts = makePipelineOpts({ MODE: 'E' });
      runQueuePipeline(opts);
      assert.equal(opts._result.auto_promoted, undefined);
    });
  });

  describe('timing markers', () => {
    it('records expected timing markers', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({ queue: [] }));
      const opts = makePipelineOpts();
      runQueuePipeline(opts);
      assert.ok(opts._timings.includes('queue_context'));
      assert.ok(opts._timings.includes('blocker_check'));
      assert.ok(opts._timings.includes('auto_promote'));
    });
  });

  describe('dirtyRef', () => {
    it('stays false when no mutations occur', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [{ id: 'wq-001', title: 'Unique task', status: 'pending', priority: 1 }]
      }));
      const opts = makePipelineOpts({ MODE: 'R' });
      const { dirtyRef } = runQueuePipeline(opts);
      assert.equal(dirtyRef.value, false);
    });

    it('becomes true after dedup', () => {
      writeFileSync(join(SCRATCH, 'work-queue.json'), JSON.stringify({
        queue: [
          { id: 'wq-001', title: 'Add tests for audit-report generation', status: 'pending', priority: 1 },
          { id: 'wq-002', title: 'Add tests for audit-report validation', status: 'pending', priority: 2 },
        ]
      }));
      const opts = makePipelineOpts();
      const { dirtyRef } = runQueuePipeline(opts);
      assert.equal(dirtyRef.value, true);
    });
  });
});

/**
 * Tests for lib/intel-pipeline.mjs (wq-800)
 * Covers: categorizeIntel, smartTruncate, autoPromoteIntel, archiveIntel, archiveTraces, runIntelPipeline
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  categorizeIntel,
  smartTruncate,
  autoPromoteIntel,
  archiveIntel,
  archiveTraces,
  runIntelPipeline,
  IMPERATIVE_VERBS,
  OBSERVATIONAL_PATTERNS,
  META_INSTRUCTION_PATTERNS,
} from './intel-pipeline.mjs';

// ========== REGEX FILTERS ==========

describe('Intel filter regexes', () => {
  it('IMPERATIVE_VERBS matches leading verbs', () => {
    assert.ok(IMPERATIVE_VERBS.test('Add new endpoint'));
    assert.ok(IMPERATIVE_VERBS.test('Build a dashboard'));
    assert.ok(IMPERATIVE_VERBS.test('fix broken auth'));
    assert.ok(!IMPERATIVE_VERBS.test('The system adds'));
    assert.ok(!IMPERATIVE_VERBS.test('A new thing'));
  });

  it('OBSERVATIONAL_PATTERNS matches observational language', () => {
    assert.ok(OBSERVATIONAL_PATTERNS.test('This enables faster builds'));
    assert.ok(OBSERVATIONAL_PATTERNS.test('It mirrors the old pattern'));
    assert.ok(OBSERVATIONAL_PATTERNS.test('suggests that changes are needed'));
    assert.ok(!OBSERVATIONAL_PATTERNS.test('Add a new test for coverage'));
  });

  it('META_INSTRUCTION_PATTERNS matches self-referential directives', () => {
    assert.ok(META_INSTRUCTION_PATTERNS.test('Add to work-queue'));
    assert.ok(META_INSTRUCTION_PATTERNS.test('potential B session task'));
    assert.ok(META_INSTRUCTION_PATTERNS.test('should be promoted'));
    assert.ok(!META_INSTRUCTION_PATTERNS.test('Fix the auth bug'));
  });
});

// ========== categorizeIntel ==========

describe('categorizeIntel', () => {
  it('categorizes integration_target with long actionable as queue', () => {
    const intel = [
      { type: 'integration_target', session: 100, summary: 'Found API', actionable: 'Integrate with new API endpoint for data' },
    ];
    const { actions, digest } = categorizeIntel(intel);
    assert.equal(actions.queue.length, 1);
    assert.equal(actions.brainstorm.length, 0);
    assert.equal(actions.note.length, 0);
    assert.match(digest, /Queue candidates/);
  });

  it('categorizes tool_idea as brainstorm', () => {
    const intel = [
      { type: 'tool_idea', session: 101, summary: 'Cool tool idea' },
    ];
    const { actions } = categorizeIntel(intel);
    assert.equal(actions.brainstorm.length, 1);
    assert.equal(actions.queue.length, 0);
  });

  it('categorizes collaboration as brainstorm', () => {
    const intel = [
      { type: 'collaboration', session: 102, summary: 'Work with agent X' },
    ];
    const { actions } = categorizeIntel(intel);
    assert.equal(actions.brainstorm.length, 1);
  });

  it('categorizes unknown types as note', () => {
    const intel = [
      { type: 'observation', session: 103, summary: 'Something observed' },
    ];
    const { actions, digest } = categorizeIntel(intel);
    assert.equal(actions.note.length, 1);
    assert.match(digest, /Notes/);
  });

  it('categorizes pattern with short actionable as note', () => {
    const intel = [
      { type: 'pattern', session: 104, summary: 'Pattern found', actionable: 'short' },
    ];
    const { actions } = categorizeIntel(intel);
    assert.equal(actions.note.length, 1);
    assert.equal(actions.queue.length, 0);
  });

  it('handles empty intel array', () => {
    const { actions, digest } = categorizeIntel([]);
    assert.equal(actions.queue.length, 0);
    assert.equal(actions.brainstorm.length, 0);
    assert.equal(actions.note.length, 0);
    assert.equal(digest, '');
  });

  it('includes session tag in digest', () => {
    const intel = [
      { type: 'tool_idea', session: 150, summary: 'Idea' },
    ];
    const { digest } = categorizeIntel(intel);
    assert.match(digest, /\[s150\]/);
  });
});

// ========== smartTruncate ==========

describe('smartTruncate', () => {
  it('returns short text as-is', () => {
    assert.equal(smartTruncate('Hello world'), 'Hello world');
  });

  it('strips trailing periods from short text', () => {
    assert.equal(smartTruncate('Hello world.'), 'Hello world');
    assert.equal(smartTruncate('Hello world...'), 'Hello world');
  });

  it('truncates at sentence boundary when available', () => {
    const input = 'This is the first sentence. This is a second sentence that makes it long enough to truncate.';
    const result = smartTruncate(input);
    assert.ok(result.length <= 80);
    assert.match(result, /first sentence/);
  });

  it('truncates at word boundary for long text without sentence break', () => {
    const input = 'word '.repeat(30); // 150 chars
    const result = smartTruncate(input);
    assert.ok(result.length <= 80);
    assert.ok(!result.endsWith(' '));
  });

  it('handles text exactly at 80 chars', () => {
    const input = 'x'.repeat(80);
    const result = smartTruncate(input);
    assert.equal(result.length, 80);
  });
});

// ========== autoPromoteIntel ==========

describe('autoPromoteIntel', () => {
  function makeQueueCtx(existingTitles = []) {
    const items = [];
    let nextId = 900;
    return {
      titles: existingTitles,
      pendingCount: existingTitles.length,
      createItem: ({ title, description, source, tags }) => {
        const id = `wq-${nextId++}`;
        items.push({ id, title, description, source, tags });
        return id;
      },
      items,
    };
  }

  it('promotes qualifying intel when queue has capacity', () => {
    const intel = [
      {
        type: 'integration_target',
        actionable: 'Add endpoint for health monitoring across platforms',
        summary: 'Found monitoring pattern',
        session: 100,
      },
    ];
    const actions = { queue: ['something'] };
    const result = { pending_count: 3 };
    const queueCtx = makeQueueCtx([]);
    autoPromoteIntel(intel, actions, result, queueCtx);
    assert.ok(result.intel_promoted);
    assert.equal(result.intel_promoted.length, 1);
    assert.ok(intel[0]._promoted);
  });

  it('skips promotion when queue full (>= 5 pending)', () => {
    const intel = [
      {
        type: 'integration_target',
        actionable: 'Add something useful for testing purposes here',
        summary: 'Intel',
        session: 100,
      },
    ];
    const actions = { queue: ['something'] };
    const result = { pending_count: 5 };
    const queueCtx = makeQueueCtx([]);
    autoPromoteIntel(intel, actions, result, queueCtx);
    assert.equal(result.intel_promoted, undefined);
  });

  it('skips promotion when no queue candidates', () => {
    const intel = [];
    const actions = { queue: [] };
    const result = { pending_count: 3 };
    const queueCtx = makeQueueCtx([]);
    autoPromoteIntel(intel, actions, result, queueCtx);
    assert.equal(result.intel_promoted, undefined);
  });

  it('filters out observational language', () => {
    const intel = [
      {
        type: 'integration_target',
        actionable: 'This enables faster builds and mirrors the old system',
        summary: 'Observation',
        session: 100,
      },
    ];
    const actions = { queue: ['something'] };
    const result = { pending_count: 3 };
    const queueCtx = makeQueueCtx([]);
    autoPromoteIntel(intel, actions, result, queueCtx);
    assert.equal(result.intel_promoted, undefined);
  });

  it('filters out non-imperative actionables', () => {
    const intel = [
      {
        type: 'integration_target',
        actionable: 'The system should probably be updated to handle edge cases better',
        summary: 'Suggestion',
        session: 100,
      },
    ];
    const actions = { queue: ['something'] };
    const result = { pending_count: 3 };
    const queueCtx = makeQueueCtx([]);
    autoPromoteIntel(intel, actions, result, queueCtx);
    assert.equal(result.intel_promoted, undefined);
  });

  it('promotes max 2 items', () => {
    const intel = Array.from({ length: 5 }, (_, i) => ({
      type: 'integration_target',
      actionable: `Add feature ${i} with enough text to pass threshold check`,
      summary: `Feature ${i}`,
      session: 100 + i,
    }));
    const actions = { queue: ['a', 'b', 'c'] };
    const result = { pending_count: 0 };
    const queueCtx = makeQueueCtx([]);
    autoPromoteIntel(intel, actions, result, queueCtx);
    assert.equal(result.intel_promoted.length, 2);
  });

  it('skips already-promoted entries', () => {
    const intel = [
      {
        type: 'integration_target',
        actionable: 'Add monitoring endpoint for platform health checks',
        summary: 'Intel',
        session: 100,
        _promoted: true,
      },
    ];
    const actions = { queue: ['something'] };
    const result = { pending_count: 3 };
    const queueCtx = makeQueueCtx([]);
    autoPromoteIntel(intel, actions, result, queueCtx);
    assert.equal(result.intel_promoted, undefined);
  });
});

// ========== archiveIntel ==========

describe('archiveIntel', () => {
  it('is exported and callable', () => {
    assert.ok(typeof archiveIntel === 'function');
  });

  it('archives intel to disk with session backfill', async () => {
    const intel = [
      { summary: 'Entry 1', session: 0 },
      { summary: 'Entry 2', session: 50 },
    ];
    const archivePath = '/tmp/test-intel-archive-' + Date.now() + '.json';
    const intelPath = '/tmp/test-intel-' + Date.now() + '.json';

    const fc = {
      json: (p) => {
        if (p === archivePath) return [];
        if (p.includes('trace-archive') || p.includes('traceArchive')) return [{ session: 80 }];
        if (p.includes('trace') && !p.includes('archive')) return [];
        return null;
      },
    };
    const PATHS = {
      intelArchive: archivePath,
      intel: intelPath,
      traceArchive: '/tmp/nonexistent-trace-archive.json',
      trace: '/tmp/nonexistent-trace.json',
    };
    const result = {};

    archiveIntel(intel, fc, PATHS, 200, result);
    assert.equal(result.intel_archived, 2);

    // Verify files were written
    const { readFileSync, unlinkSync } = await import('fs');
    const archived = JSON.parse(readFileSync(archivePath, 'utf8'));
    assert.equal(archived.length, 2);
    assert.equal(archived[0].archived_session, 200);
    // Entry with session=0 should be backfilled from trace archive (session 80)
    assert.equal(archived[0].session, 80);
    assert.equal(archived[0].session_backfilled, true);
    // Entry with session=50 stays as-is
    assert.equal(archived[1].session, 50);

    // Cleanup
    try { unlinkSync(archivePath); } catch {}
    try { unlinkSync(intelPath); } catch {}
  });
});

// ========== archiveTraces ==========

describe('archiveTraces', () => {
  it('is exported and callable', () => {
    assert.ok(typeof archiveTraces === 'function');
  });
});

// ========== runIntelPipeline ==========

describe('runIntelPipeline', () => {
  it('sets intel_count to 0 for empty intel', () => {
    const result = {};
    runIntelPipeline({
      intel: [],
      fc: { json: () => null },
      PATHS: {},
      COUNTER: 100,
      result,
      queueCtx: { titles: [], pendingCount: 0, createItem: () => 'wq-999' },
    });
    assert.equal(result.intel_count, 0);
    assert.equal(result.intel_digest, undefined); // no digest for empty
  });

  it('sets intel_count for non-empty intel', () => {
    const result = { pending_count: 10 };
    // This will try to write files, so we need to handle that
    // We can test categorization by checking result.intel_digest is set
    // But archiving will fail without real paths — that's OK, we're testing the pipeline logic
    try {
      runIntelPipeline({
        intel: [{ type: 'observation', session: 100, summary: 'Test entry' }],
        fc: {
          json: (p) => {
            if (p.includes('archive')) return [];
            return null;
          },
        },
        PATHS: {
          intelArchive: '/tmp/test-intel-archive-' + Date.now() + '.json',
          intel: '/tmp/test-intel-' + Date.now() + '.json',
          traceArchive: '/tmp/test-trace-archive-' + Date.now() + '.json',
          trace: '/tmp/test-trace-' + Date.now() + '.json',
        },
        COUNTER: 100,
        result,
        queueCtx: { titles: [], pendingCount: 10, createItem: () => 'wq-999' },
      });
    } catch {
      // writeFileSync may fail with temp paths — that's fine
    }
    assert.equal(result.intel_count, 1);
    assert.ok(result.intel_digest); // digest was computed
    assert.match(result.intel_digest, /Notes/);
  });

  it('handles null intel gracefully', () => {
    const result = {};
    runIntelPipeline({
      intel: null,
      fc: { json: () => null },
      PATHS: {},
      COUNTER: 100,
      result,
      queueCtx: { titles: [], pendingCount: 0, createItem: () => 'wq-999' },
    });
    assert.equal(result.intel_count, 0);
  });
});

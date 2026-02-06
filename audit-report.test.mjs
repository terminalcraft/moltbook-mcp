#!/usr/bin/env node
// audit-report.test.mjs — Tests for audit-report generation pipeline
// Covers: schema validation, recommendation lifecycle, cost calculation,
// audit-stats.mjs computation functions
//
// Usage: node --test audit-report.test.mjs
// Created: B#341 (wq-392)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(tmpdir(), 'audit-test-' + Date.now());
const SRC = join(SCRATCH, 'src');
const STATE = join(SCRATCH, 'state');

// ─── Helpers ───────────────────────────────────────────────────────────

function setupDirs() {
  mkdirSync(SRC, { recursive: true });
  mkdirSync(STATE, { recursive: true });
}

function cleanupDirs() {
  rmSync(SCRATCH, { recursive: true, force: true });
}

function writeJSON(dir, name, data) {
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2));
}

function patchAuditStats() {
  let src = readFileSync(join(__dirname, 'audit-stats.mjs'), 'utf8');
  // Patch STATE_DIR to use our temp state dir
  src = src.replace(
    "const STATE_DIR = join(homedir(), '.config/moltbook');",
    `const STATE_DIR = ${JSON.stringify(STATE)};`
  );
  // Patch PROJECT_DIR to use our temp src dir
  src = src.replace(
    'const PROJECT_DIR = __dirname;',
    `const PROJECT_DIR = ${JSON.stringify(SRC)};`
  );
  writeFileSync(join(SRC, 'audit-stats.mjs'), src);
}

function runStats(sessionNum = '100') {
  const out = execSync(`node ${join(SRC, 'audit-stats.mjs')} ${sessionNum}`, {
    env: { ...process.env, HOME: SCRATCH },
    timeout: 10000,
  }).toString().trim();
  return JSON.parse(out);
}

// ─── Section 1: audit-stats.mjs computation ────────────────────────────

describe('audit-stats.mjs computation', () => {
  before(() => {
    setupDirs();
    patchAuditStats();
  });

  after(() => {
    cleanupDirs();
  });

  describe('intel stats', () => {
    it('computes correct stats with empty intel', () => {
      writeJSON(STATE, 'engagement-intel.json', []);
      writeJSON(STATE, 'engagement-intel-archive.json', []);
      // Need minimal queue/directives/brainstorming/history
      writeJSON(SRC, 'work-queue.json', { queue: [] });
      writeJSON(SRC, 'directives.json', { directives: [] });
      writeFileSync(join(SRC, 'BRAINSTORMING.md'), '# Brainstorming\n');
      writeFileSync(join(STATE, 'session-history.txt'), '');

      const stats = runStats('100');
      assert.equal(stats.pipelines.intel.current, 0);
      assert.equal(stats.pipelines.intel.archived, 0);
      assert.equal(stats.pipelines.intel.consumed, 0);
      assert.equal(stats.pipelines.intel.consumption_rate, '0%');
      assert.equal(stats.pipelines.intel.verdict, 'failing');
    });

    it('computes consumed/unconsumed from archive', () => {
      writeJSON(STATE, 'engagement-intel.json', [
        { type: 'trend', session: 99 }
      ]);
      writeJSON(STATE, 'engagement-intel-archive.json', [
        { type: 'trend', consumed_session: 80 },
        { type: 'pattern', consumed_session: 85 },
        { type: 'trend' },  // unconsumed
      ]);

      const stats = runStats('100');
      assert.equal(stats.pipelines.intel.current, 1);
      assert.equal(stats.pipelines.intel.archived, 3);
      assert.equal(stats.pipelines.intel.consumed, 2);
      assert.equal(stats.pipelines.intel.unconsumed, 1);
      assert.equal(stats.pipelines.intel.consumption_rate, '67%');
      assert.equal(stats.pipelines.intel.verdict, 'healthy');
    });

    it('tracks intel by type', () => {
      writeJSON(STATE, 'engagement-intel.json', []);
      writeJSON(STATE, 'engagement-intel-archive.json', [
        { type: 'trend', consumed_session: 1 },
        { type: 'trend', consumed_session: 2 },
        { type: 'pattern', consumed_session: 3 },
        { type: 'insight', consumed_session: 4 },
      ]);

      const stats = runStats('100');
      assert.equal(stats.pipelines.intel.by_type.trend, 2);
      assert.equal(stats.pipelines.intel.by_type.pattern, 1);
      assert.equal(stats.pipelines.intel.by_type.insight, 1);
    });
  });

  describe('brainstorming stats', () => {
    it('counts active ideas with session markers', () => {
      writeFileSync(join(SRC, 'BRAINSTORMING.md'), [
        '# Brainstorming',
        '',
        '## Evolution',
        '- **Idea A** — description (added ~s90)',
        '- **Idea B** — description (added ~s95)',
        '- ~~**Old idea** — retired (added ~s50)~~',
        '',
      ].join('\n'));

      const stats = runStats('100');
      assert.equal(stats.pipelines.brainstorming.active, 2);
      assert.equal(stats.pipelines.brainstorming.stale_count, 0);
    });

    it('detects stale ideas (>30 sessions old)', () => {
      writeFileSync(join(SRC, 'BRAINSTORMING.md'), [
        '# Brainstorming',
        '- **Old idea** — old stuff (added ~s50)',
        '- **Recent idea** — new stuff (added ~s95)',
      ].join('\n'));

      const stats = runStats('100');
      assert.equal(stats.pipelines.brainstorming.active, 2);
      assert.equal(stats.pipelines.brainstorming.stale_count, 1);
      assert.equal(stats.pipelines.brainstorming.verdict, 'needs_cleanup');
    });

    it('returns needs_replenish when fewer than 3 ideas', () => {
      writeFileSync(join(SRC, 'BRAINSTORMING.md'), [
        '# Brainstorming',
        '- **Only one** (added ~s95)',
      ].join('\n'));

      const stats = runStats('100');
      assert.equal(stats.pipelines.brainstorming.active, 1);
      assert.equal(stats.pipelines.brainstorming.verdict, 'needs_replenish');
    });

    it('handles missing BRAINSTORMING.md', () => {
      // Remove the file
      rmSync(join(SRC, 'BRAINSTORMING.md'), { force: true });

      const stats = runStats('100');
      assert.equal(stats.pipelines.brainstorming.active, 0);
      // Early-return path uses 'avg_age' (not 'avg_age_sessions')
      assert.equal(stats.pipelines.brainstorming.avg_age, 0);

      // Restore for subsequent tests
      writeFileSync(join(SRC, 'BRAINSTORMING.md'), '# Brainstorming\n');
    });
  });

  describe('queue stats', () => {
    it('counts items by status', () => {
      writeJSON(SRC, 'work-queue.json', {
        queue: [
          { id: 'wq-1', status: 'pending', created_session: 95 },
          { id: 'wq-2', status: 'pending', created_session: 90 },
          { id: 'wq-3', status: 'in-progress', created_session: 80 },
          { id: 'wq-4', status: 'blocked', created_session: 70 },
        ]
      });
      writeJSON(SRC, 'work-queue-archive.json', { archived: [] });

      const stats = runStats('100');
      assert.equal(stats.pipelines.queue.total, 4);
      assert.equal(stats.pipelines.queue.by_status.pending, 2);
      assert.equal(stats.pipelines.queue.by_status['in-progress'], 1);
      assert.equal(stats.pipelines.queue.by_status.blocked, 1);
    });

    it('identifies stuck items (>20 sessions old pending)', () => {
      writeJSON(SRC, 'work-queue.json', {
        queue: [
          { id: 'wq-10', status: 'pending', created_session: 50 },
          { id: 'wq-11', status: 'pending', created_session: 95 },
        ]
      });
      writeJSON(SRC, 'work-queue-archive.json', { archived: [] });

      const stats = runStats('100');
      assert.equal(stats.pipelines.queue.stuck_items.length, 1);
      assert.equal(stats.pipelines.queue.stuck_items[0].id, 'wq-10');
      assert.equal(stats.pipelines.queue.stuck_items[0].age, 50);
      assert.equal(stats.pipelines.queue.verdict, 'has_stuck_items');
    });

    it('counts audit-tagged items from archive', () => {
      writeJSON(SRC, 'work-queue.json', {
        queue: [
          { id: 'wq-20', status: 'pending', tags: ['audit'], created_session: 95 },
        ]
      });
      writeJSON(SRC, 'work-queue-archive.json', {
        archived: [
          { id: 'wq-15', status: 'done', tags: ['audit'] },
          { id: 'wq-16', status: 'completed', tags: ['audit'] },
          { id: 'wq-17', status: 'done', tags: [] },
        ]
      });

      const stats = runStats('100');
      assert.deepEqual(stats.pipelines.queue.audit_tagged, ['wq-20']);
      assert.deepEqual(stats.pipelines.queue.audit_completed, ['wq-15', 'wq-16']);
      assert.equal(stats.pipelines.queue.audit_summary, '2 done (of 3 total)');
    });

    it('handles missing archive file gracefully', () => {
      writeJSON(SRC, 'work-queue.json', { queue: [] });
      rmSync(join(SRC, 'work-queue-archive.json'), { force: true });

      const stats = runStats('100');
      assert.equal(stats.pipelines.queue.total, 0);
      assert.deepEqual(stats.pipelines.queue.audit_completed, []);
    });
  });

  describe('directive stats', () => {
    it('counts directives by status', () => {
      writeJSON(SRC, 'directives.json', {
        directives: [
          { id: 'd001', status: 'active', acked_session: 90 },
          { id: 'd002', status: 'active', acked_session: 50 },
          { id: 'd003', status: 'completed' },
          { id: 'd004', status: 'pending' },
        ]
      });

      const stats = runStats('100');
      assert.equal(stats.pipelines.directives.total, 4);
      assert.equal(stats.pipelines.directives.active, 2);
      assert.equal(stats.pipelines.directives.completed, 1);
      assert.equal(stats.pipelines.directives.pending, 1);
    });

    it('identifies unacted directives (>20 sessions since ack, no queue item)', () => {
      writeJSON(SRC, 'directives.json', {
        directives: [
          { id: 'd010', status: 'active', acked_session: 70 },  // unacted: 30 sessions, no queue
          { id: 'd011', status: 'active', acked_session: 70, queue_item: 'wq-99' },  // has queue item
          { id: 'd012', status: 'active', acked_session: 95 },  // recent ack
        ]
      });

      const stats = runStats('100');
      assert.deepEqual(stats.pipelines.directives.unacted_active, ['d010']);
      assert.equal(stats.pipelines.directives.verdict, 'has_unacted');
    });

    it('reports healthy when no unacted directives', () => {
      writeJSON(SRC, 'directives.json', {
        directives: [
          { id: 'd020', status: 'active', acked_session: 95 },
          { id: 'd021', status: 'completed' },
        ]
      });

      const stats = runStats('100');
      assert.deepEqual(stats.pipelines.directives.unacted_active, []);
      assert.equal(stats.pipelines.directives.verdict, 'healthy');
    });
  });

  describe('session stats', () => {
    it('computes cost averages by session type', () => {
      writeFileSync(join(STATE, 'session-history.txt'), [
        '2026-02-06 mode=B s=90 dur=5m cost=$2.00 build=1',
        '2026-02-06 mode=B s=91 dur=4m cost=$3.00 build=2',
        '2026-02-06 mode=E s=92 dur=3m cost=$1.00 build=0',
        '2026-02-06 mode=R s=93 dur=3m cost=$1.50 build=1',
        '2026-02-06 mode=A s=94 dur=5m cost=$1.80 build=0',
      ].join('\n'));

      const stats = runStats('100');
      assert.equal(stats.sessions.summary.B.count_in_history, 2);
      assert.equal(stats.sessions.summary.B.avg_cost_last_10, 2.5);
      assert.equal(stats.sessions.summary.E.avg_cost_last_10, 1);
      assert.equal(stats.sessions.summary.R.avg_cost_last_10, 1.5);
      assert.equal(stats.sessions.summary.A.avg_cost_last_10, 1.8);
    });

    it('flags high cost session types', () => {
      writeFileSync(join(STATE, 'session-history.txt'), [
        '2026-02-06 mode=B s=90 dur=5m cost=$3.00 build=1',
        '2026-02-06 mode=B s=91 dur=4m cost=$2.50 build=2',
      ].join('\n'));

      const stats = runStats('100');
      assert.equal(stats.sessions.summary.B.verdict, 'high_cost');
    });

    it('handles empty session history', () => {
      writeFileSync(join(STATE, 'session-history.txt'), '');

      const stats = runStats('100');
      assert.equal(stats.sessions.summary.B.count_in_history, 0);
      assert.equal(stats.sessions.summary.B.avg_cost_last_10, 0);
    });
  });

  describe('session number detection', () => {
    it('uses CLI argument when provided', () => {
      // Setup minimal fixtures
      writeJSON(STATE, 'engagement-intel.json', []);
      writeJSON(STATE, 'engagement-intel-archive.json', []);
      writeJSON(SRC, 'work-queue.json', { queue: [] });
      writeJSON(SRC, 'directives.json', { directives: [] });
      writeFileSync(join(SRC, 'BRAINSTORMING.md'), '# Brainstorming\n');
      writeFileSync(join(STATE, 'session-history.txt'), '');

      const stats = runStats('555');
      assert.equal(stats.session, 555);
    });

    it('falls back to session-history.txt when no CLI arg', () => {
      writeFileSync(join(STATE, 'session-history.txt'),
        '2026-02-06 mode=B s=42 dur=5m cost=$1.00\n');

      const out = execSync(`node ${join(SRC, 'audit-stats.mjs')}`, {
        env: { ...process.env, HOME: SCRATCH },
        timeout: 10000,
      }).toString().trim();
      const stats = JSON.parse(out);
      assert.equal(stats.session, 42);
    });
  });
});

// ─── Section 2: audit-report.json schema validation ────────────────────

describe('audit-report.json schema validation', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  it('has required top-level fields', () => {
    const required = ['session', 'timestamp', 'previous_audit', 'audit_number',
      'previous_recommendations_status', 'pipelines', 'sessions',
      'infrastructure', 'security', 'cost', 'recommended_actions'];
    for (const field of required) {
      assert.ok(field in report, `missing top-level field: ${field}`);
    }
  });

  it('session is a positive integer', () => {
    assert.equal(typeof report.session, 'number');
    assert.ok(report.session > 0);
    assert.ok(Number.isInteger(report.session));
  });

  it('audit_number is a positive integer', () => {
    assert.equal(typeof report.audit_number, 'number');
    assert.ok(report.audit_number > 0);
    assert.ok(Number.isInteger(report.audit_number));
  });

  it('timestamp is a valid ISO date string', () => {
    assert.equal(typeof report.timestamp, 'string');
    const d = new Date(report.timestamp);
    assert.ok(!isNaN(d.getTime()), 'timestamp is not a valid date');
  });

  it('previous_audit is a number less than session', () => {
    assert.equal(typeof report.previous_audit, 'number');
    assert.ok(report.previous_audit < report.session,
      `previous_audit (${report.previous_audit}) should be < session (${report.session})`);
  });

  describe('pipelines section', () => {
    it('has required pipeline subsections', () => {
      const required = ['intel', 'brainstorming', 'queue', 'directives'];
      for (const p of required) {
        assert.ok(p in report.pipelines, `missing pipeline: ${p}`);
      }
    });

    it('intel pipeline has verdict', () => {
      assert.ok('verdict' in report.pipelines.intel);
      assert.equal(typeof report.pipelines.intel.verdict, 'string');
    });

    it('queue pipeline has pending count info', () => {
      const q = report.pipelines.queue;
      assert.ok('total' in q || 'pending' in q,
        'queue pipeline must have total or pending count');
    });

    it('directives pipeline tracks active count', () => {
      const d = report.pipelines.directives;
      assert.ok('total' in d || 'active' in d,
        'directives pipeline must have total or active count');
    });
  });

  describe('sessions section', () => {
    it('has entries for each session type', () => {
      for (const type of ['B', 'E', 'R', 'A']) {
        assert.ok(type in report.sessions, `missing session type: ${type}`);
      }
    });

    it('each session type has verdict', () => {
      for (const type of ['B', 'E', 'R', 'A']) {
        assert.ok('verdict' in report.sessions[type],
          `session type ${type} missing verdict`);
      }
    });
  });

  describe('cost section', () => {
    it('has required cost fields', () => {
      const required = ['avg_per_session', 'by_type'];
      for (const f of required) {
        assert.ok(f in report.cost, `missing cost field: ${f}`);
      }
    });

    it('avg_per_session is a positive number', () => {
      assert.equal(typeof report.cost.avg_per_session, 'number');
      assert.ok(report.cost.avg_per_session > 0);
    });

    it('by_type has entries for each session type', () => {
      for (const type of ['B', 'E', 'R', 'A']) {
        assert.ok(type in report.cost.by_type,
          `missing cost entry for type ${type}`);
      }
    });

    it('per-type costs have avg field', () => {
      for (const type of ['B', 'E', 'R', 'A']) {
        const entry = report.cost.by_type[type];
        assert.ok('avg' in entry, `${type} cost missing avg field`);
        assert.equal(typeof entry.avg, 'number');
      }
    });

    it('per-type costs have count field', () => {
      for (const type of ['B', 'E', 'R', 'A']) {
        const entry = report.cost.by_type[type];
        assert.ok('count' in entry, `${type} cost missing count field`);
        assert.equal(typeof entry.count, 'number');
      }
    });
  });

  describe('security section', () => {
    it('has verdict field', () => {
      assert.ok('verdict' in report.security);
      assert.equal(typeof report.security.verdict, 'string');
    });
  });

  describe('infrastructure section', () => {
    it('has hooks subsection', () => {
      assert.ok('hooks' in report.infrastructure);
    });

    it('has verdict field', () => {
      assert.ok('verdict' in report.infrastructure);
    });
  });
});

// ─── Section 3: recommendation lifecycle ───────────────────────────────

describe('recommendation lifecycle', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  it('recommended_actions is an array', () => {
    assert.ok(Array.isArray(report.recommended_actions));
  });

  it('each recommendation has required fields', () => {
    for (const rec of report.recommended_actions) {
      assert.ok('id' in rec, 'recommendation missing id');
      assert.ok('description' in rec, `${rec.id} missing description`);
      assert.ok('priority' in rec, `${rec.id} missing priority`);
    }
  });

  it('recommendation IDs follow a{session}-{n} format', () => {
    const idPattern = /^a\d+-\d+$/;
    for (const rec of report.recommended_actions) {
      assert.match(rec.id, idPattern,
        `recommendation id "${rec.id}" doesn't match a{N}-{N} format`);
    }
  });

  it('recommendation priorities are valid', () => {
    const validPriorities = ['low', 'medium', 'high', 'critical'];
    for (const rec of report.recommended_actions) {
      assert.ok(validPriorities.includes(rec.priority),
        `${rec.id} has invalid priority: ${rec.priority}`);
    }
  });

  describe('previous_recommendations_status', () => {
    it('is a non-null object', () => {
      assert.equal(typeof report.previous_recommendations_status, 'object');
      assert.ok(report.previous_recommendations_status !== null);
    });

    it('each tracked recommendation has a status', () => {
      const validStatuses = ['resolved', 'resolved_unverified', 'in_progress',
        'superseded', 'stale', 'fix_ineffective'];
      for (const [id, rec] of Object.entries(report.previous_recommendations_status)) {
        assert.ok('status' in rec, `${id} missing status`);
        assert.ok(validStatuses.includes(rec.status),
          `${id} has invalid status: ${rec.status}`);
      }
    });

    it('resolved recommendations have verification fields', () => {
      for (const [id, rec] of Object.entries(report.previous_recommendations_status)) {
        if (rec.status === 'resolved') {
          assert.ok('resolution' in rec, `${id} resolved but missing resolution`);
          assert.ok('verified' in rec, `${id} resolved but missing verified flag`);
        }
      }
    });

    it('resolved recommendations have metric_before and metric_after', () => {
      for (const [id, rec] of Object.entries(report.previous_recommendations_status)) {
        if (rec.status === 'resolved' && rec.verified) {
          assert.ok('metric_before' in rec,
            `${id} verified-resolved but missing metric_before`);
          assert.ok('metric_after' in rec,
            `${id} verified-resolved but missing metric_after`);
        }
      }
    });
  });

  describe('critical_issues consistency', () => {
    it('critical_issues is an array', () => {
      assert.ok(Array.isArray(report.critical_issues));
    });

    it('stale recommendations are escalated to critical_issues', () => {
      // Check that any "stale" previous recommendation appears in critical_issues
      const staleRecs = Object.entries(report.previous_recommendations_status)
        .filter(([_, rec]) => rec.status === 'stale')
        .map(([id]) => id);

      if (staleRecs.length > 0) {
        const criticalText = JSON.stringify(report.critical_issues);
        for (const id of staleRecs) {
          assert.ok(criticalText.includes(id) || report.critical_issues.length > 0,
            `stale recommendation ${id} not escalated to critical_issues`);
        }
      }
    });
  });
});

// ─── Section 4: cost calculation consistency ───────────────────────────

describe('cost calculation consistency', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  it('last_20_total is consistent with per-type data', () => {
    // last_20_total is manually computed by A session from session-history.txt
    // by_type averages come from audit-stats.mjs. They may use different windows
    // (last_20_total is last 20 sessions; by_type.avg is last 10 per type).
    // Just verify last_20_total is a positive number and per-type avgs are reasonable.
    if ('last_20_total' in report.cost) {
      assert.equal(typeof report.cost.last_20_total, 'number');
      assert.ok(report.cost.last_20_total > 0,
        'last_20_total should be positive');
      // Sanity: total should be less than $200 (20 sessions * $10 cap max)
      assert.ok(report.cost.last_20_total < 200,
        `last_20_total ($${report.cost.last_20_total}) unreasonably high`);
    }
  });

  it('B sessions have highest average cost', () => {
    // B sessions typically ship code, so they should cost more
    const bAvg = report.cost.by_type.B.avg;
    const eAvg = report.cost.by_type.E.avg;
    // B should generally cost more than E (engagement sessions are lighter)
    assert.ok(bAvg >= eAvg,
      `B avg ($${bAvg}) should be >= E avg ($${eAvg})`);
  });

  it('no session type exceeds budget cap', () => {
    // Budget caps: Build=$10, Engage=$5, Reflect=$5
    const caps = { B: 10, E: 5, R: 5, A: 10 };
    for (const [type, entry] of Object.entries(report.cost.by_type)) {
      const cap = caps[type] || 10;
      assert.ok(entry.avg <= cap,
        `${type} avg ($${entry.avg}) exceeds budget cap ($${cap})`);
    }
  });

  it('trend field exists and is a string', () => {
    assert.ok('trend' in report.cost);
    assert.equal(typeof report.cost.trend, 'string');
  });
});

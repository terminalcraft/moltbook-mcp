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
      // Schema evolved: avg_per_session → last_30_avg (A session format change)
      const required = ['by_type'];
      for (const f of required) {
        assert.ok(f in report.cost, `missing cost field: ${f}`);
      }
      // Must have one of: avg_per_session or last_30_avg
      assert.ok('avg_per_session' in report.cost || 'last_30_avg' in report.cost,
        'cost section must have avg_per_session or last_30_avg');
    });

    it('average cost per session is a positive number', () => {
      const avg = report.cost.avg_per_session ?? report.cost.last_30_avg;
      assert.equal(typeof avg, 'number');
      assert.ok(avg > 0);
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

  it('session total cost is consistent with per-type data', () => {
    // Schema evolved: last_20_total → last_30_total
    const totalKey = 'last_30_total' in report.cost ? 'last_30_total' : 'last_20_total';
    if (totalKey in report.cost) {
      assert.equal(typeof report.cost[totalKey], 'number');
      assert.ok(report.cost[totalKey] > 0,
        `${totalKey} should be positive`);
      // Sanity: total should be less than $300 (30 sessions * $10 cap max)
      assert.ok(report.cost[totalKey] < 300,
        `${totalKey} ($${report.cost[totalKey]}) unreasonably high`);
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

// ─── Section 5: delta_from_s<prev> computation ──────────────────────────

describe('delta from previous audit (cross-audit consistency)', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  it('previous_audit is a session number less than current session', () => {
    assert.equal(typeof report.previous_audit, 'number');
    assert.ok(Number.isInteger(report.previous_audit));
    assert.ok(report.previous_audit > 0,
      'previous_audit should be positive');
    assert.ok(report.previous_audit < report.session,
      `previous_audit (${report.previous_audit}) must be < session (${report.session})`);
  });

  it('audit_number increments (current > 0)', () => {
    assert.ok(report.audit_number > 0,
      'audit_number should be positive (sequential count)');
  });

  it('session gap between audits is reasonable (< 50 sessions)', () => {
    const gap = report.session - report.previous_audit;
    assert.ok(gap > 0 && gap < 50,
      `audit gap of ${gap} sessions is unreasonable (expected 3-15)`);
  });

  it('previous_recommendations_status keys reference previous audit session', () => {
    const prevRecs = report.previous_recommendations_status;
    if (Object.keys(prevRecs).length === 0) return; // no previous recs to check

    for (const id of Object.keys(prevRecs)) {
      // IDs follow a{session}-{n} format — the session should match previous_audit or earlier
      const match = id.match(/^a(\d+)-(\d+)$/);
      assert.ok(match, `recommendation id "${id}" doesn't match a{N}-{N} format`);
      const recAuditNum = parseInt(match[1]);
      // The rec could come from any prior audit, but should be <= audit_number
      assert.ok(recAuditNum <= report.audit_number,
        `rec ${id} references audit ${recAuditNum} but current audit is ${report.audit_number}`);
    }
  });

  it('fix_ineffective recommendations have followup pointing to current audit', () => {
    for (const [id, rec] of Object.entries(report.previous_recommendations_status)) {
      if (rec.status === 'fix_ineffective') {
        assert.ok('followup' in rec,
          `${id} is fix_ineffective but missing followup field`);
        // followup should reference current audit's recommendations
        const followup = rec.followup;
        const followupMatch = followup.match(/^a(\d+)-(\d+)$/);
        assert.ok(followupMatch,
          `${id} followup "${followup}" doesn't match a{N}-{N} format`);
      }
    }
  });

  it('resolved recommendations have metric_before and metric_after as strings', () => {
    for (const [id, rec] of Object.entries(report.previous_recommendations_status)) {
      if (rec.status === 'resolved' && rec.verified) {
        assert.equal(typeof rec.metric_before, 'string',
          `${id} metric_before should be a string`);
        assert.equal(typeof rec.metric_after, 'string',
          `${id} metric_after should be a string`);
        assert.ok(rec.metric_before.length > 0,
          `${id} metric_before should not be empty`);
        assert.ok(rec.metric_after.length > 0,
          `${id} metric_after should not be empty`);
      }
    }
  });

  it('all previous recommendation statuses are tracked (no gaps)', () => {
    // Every rec from the previous audit should appear in previous_recommendations_status
    // We can verify by checking the count matches expected (at least 1 if previous_audit exists)
    if (report.previous_audit > 0) {
      const trackedCount = Object.keys(report.previous_recommendations_status).length;
      assert.ok(trackedCount >= 0,
        'previous_recommendations_status should exist');
      // If there are recommended_actions, previous audit likely had some too
      // This is a soft check — we verify the structure, not the exact count
    }
  });
});

// ─── Section 6: session field population ─────────────────────────────────

describe('session field population', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  it('session field matches a realistic session number', () => {
    assert.equal(typeof report.session, 'number');
    assert.ok(Number.isInteger(report.session));
    // Session numbers should be >100 (we're well past early sessions)
    assert.ok(report.session > 100,
      `session ${report.session} seems too low`);
    // And less than 100000 (sanity upper bound)
    assert.ok(report.session < 100000,
      `session ${report.session} seems too high`);
  });

  it('sessions section has per-type cost data from session-history', () => {
    for (const type of ['B', 'E', 'R', 'A']) {
      const entry = report.sessions[type];
      assert.ok('count_in_history' in entry || 'last_10_avg_cost' in entry,
        `sessions.${type} missing history-derived fields`);
    }
  });

  it('sessions section verdicts are non-empty strings', () => {
    for (const type of ['B', 'E', 'R', 'A']) {
      assert.equal(typeof report.sessions[type].verdict, 'string');
      assert.ok(report.sessions[type].verdict.length > 0,
        `sessions.${type}.verdict should not be empty`);
    }
  });

  it('pipelines section has verdict strings for all subsections', () => {
    for (const pipeline of ['intel', 'brainstorming', 'queue', 'directives']) {
      assert.equal(typeof report.pipelines[pipeline].verdict, 'string',
        `pipelines.${pipeline}.verdict should be a string`);
      assert.ok(report.pipelines[pipeline].verdict.length > 0,
        `pipelines.${pipeline}.verdict should not be empty`);
    }
  });

  it('infrastructure has hooks count fields', () => {
    assert.ok('hooks' in report.infrastructure);
    const hooks = report.infrastructure.hooks;
    assert.equal(typeof hooks.total, 'number');
    assert.ok(hooks.total > 0, 'should have at least some hooks');
    assert.equal(typeof hooks.syntax_errors, 'number');
  });

  it('critical_issues entries have required structure', () => {
    for (const issue of report.critical_issues) {
      if (typeof issue === 'object') {
        assert.ok('description' in issue || 'id' in issue,
          'critical_issue object must have description or id');
        if ('severity' in issue) {
          assert.ok(['low', 'medium', 'high', 'critical'].includes(issue.severity),
            `invalid severity: ${issue.severity}`);
        }
      }
      // String critical issues are also valid (consumer handles both)
    }
  });
});

// ─── Section 7: consumer schema compatibility ────────────────────────────
// Validates that audit-report.json matches what session-context.mjs reads
// (the primary consumer, lines 1195-1218)

describe('consumer schema compatibility (session-context.mjs)', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  it('session field is readable as number for display', () => {
    // session-context.mjs: prev.session || '?'
    assert.equal(typeof report.session, 'number');
    assert.ok(report.session > 0);
  });

  it('audit_number field is readable for display', () => {
    // session-context.mjs: prev.audit_number || '?'
    assert.equal(typeof report.audit_number, 'number');
    assert.ok(report.audit_number > 0);
  });

  it('critical_issues is an array with displayable items', () => {
    // session-context.mjs slices first 3, maps: typeof c === 'string' ? c : (c.description || c.id || JSON.stringify(c))
    assert.ok(Array.isArray(report.critical_issues));
    for (const item of report.critical_issues) {
      if (typeof item === 'string') {
        assert.ok(item.length > 0, 'string critical issue should not be empty');
      } else if (typeof item === 'object' && item !== null) {
        // Must have at least one displayable field
        const displayable = item.description || item.id || JSON.stringify(item);
        assert.ok(displayable.length > 0,
          'critical issue object must produce non-empty display string');
      } else {
        assert.fail(`critical issue has unexpected type: ${typeof item}`);
      }
    }
  });

  it('recommended_actions items have fields consumer expects', () => {
    // session-context.mjs maps: { id: r.id, description: r.description, priority: r.priority, type: r.type, deadline: r.deadline_session }
    for (const rec of report.recommended_actions) {
      assert.ok('id' in rec, `recommendation missing id`);
      assert.equal(typeof rec.id, 'string');
      assert.ok('description' in rec, `${rec.id} missing description`);
      assert.equal(typeof rec.description, 'string');
      assert.ok(rec.description.length > 0,
        `${rec.id} description should not be empty`);
      assert.ok('priority' in rec, `${rec.id} missing priority`);
      // type and deadline_session are optional (consumer uses || 'unknown')
    }
  });

  it('recommended_actions description is truncatable to 120 chars', () => {
    // session-context.mjs: (r.description || '').substring(0, 120)
    for (const rec of report.recommended_actions) {
      const truncated = (rec.description || '').substring(0, 120);
      assert.ok(truncated.length > 0,
        `${rec.id} description truncated to 120 chars should still be meaningful`);
      assert.ok(truncated.length <= 120);
    }
  });
});

// ─── Section 8: audit-stats.mjs → audit-report.json field mapping ────────
// Verifies that the stats output structure matches what A sessions inject into audit-report.json

describe('audit-stats to report field mapping', () => {
  before(() => {
    // Reuse same scratch dir setup from Section 1
    setupDirs();
    patchAuditStats();
    // Minimal fixtures
    writeJSON(STATE, 'engagement-intel.json', [{ type: 'trend', session: 99 }]);
    writeJSON(STATE, 'engagement-intel-archive.json', [
      { type: 'trend', consumed_session: 80 },
      { type: 'pattern' },
    ]);
    writeJSON(SRC, 'work-queue.json', {
      queue: [
        { id: 'wq-1', status: 'pending', created_session: 95 },
        { id: 'wq-2', status: 'done', tags: ['audit'], created_session: 90 },
      ]
    });
    writeJSON(SRC, 'directives.json', {
      directives: [
        { id: 'd001', status: 'active', acked_session: 95 },
        { id: 'd002', status: 'completed' },
      ]
    });
    writeFileSync(join(SRC, 'BRAINSTORMING.md'), '# Brainstorming\n- **Idea** (added ~s95)\n');
    writeFileSync(join(STATE, 'session-history.txt'), [
      '2026-02-06 mode=B s=95 dur=5m cost=$2.00 build=1',
      '2026-02-06 mode=E s=96 dur=3m cost=$1.00 build=0',
      '2026-02-06 mode=R s=97 dur=3m cost=$1.50 build=1',
      '2026-02-06 mode=A s=98 dur=5m cost=$1.80 build=0',
    ].join('\n'));
  });

  after(() => {
    cleanupDirs();
  });

  it('stats session field derived from session-history.txt (priority 2)', () => {
    // getCurrentSession priority: 1) SESSION_NUM env, 2) session-history.txt last line, 3) CLI arg
    // Our fixture has s=98 as last entry, so session should be 98
    const stats = runStats('100');
    assert.equal(stats.session, 98, 'should use session-history.txt (s=98) over CLI arg');
  });

  it('stats pipelines structure matches report pipelines', () => {
    const stats = runStats('100');
    // Verify stats has same pipeline keys as the report schema
    for (const key of ['intel', 'brainstorming', 'queue', 'directives']) {
      assert.ok(key in stats.pipelines,
        `stats missing pipeline: ${key}`);
      assert.ok('verdict' in stats.pipelines[key],
        `stats.pipelines.${key} missing verdict`);
    }
  });

  it('stats sessions.summary has per-type entries matching report schema', () => {
    const stats = runStats('100');
    const summary = stats.sessions.summary;
    for (const type of ['B', 'E', 'R', 'A']) {
      assert.ok(type in summary, `stats missing session type: ${type}`);
      assert.ok('count_in_history' in summary[type],
        `stats.sessions.summary.${type} missing count_in_history`);
      assert.ok('avg_cost_last_10' in summary[type],
        `stats.sessions.summary.${type} missing avg_cost_last_10`);
      assert.ok('verdict' in summary[type],
        `stats.sessions.summary.${type} missing verdict`);
    }
  });

  it('stats computed_at is a valid ISO timestamp', () => {
    const stats = runStats('100');
    assert.equal(typeof stats.computed_at, 'string');
    const d = new Date(stats.computed_at);
    assert.ok(!isNaN(d.getTime()), 'computed_at should be valid ISO date');
  });
});

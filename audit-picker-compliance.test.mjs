#!/usr/bin/env node
// audit-picker-compliance.test.mjs — Tests for picker compliance checker
//
// Covers: platform extraction from various trace formats, compliance calculation,
// violation tracking, escalation logic, and state persistence.
//
// Usage: node --test audit-picker-compliance.test.mjs
// Created: B#442 (wq-629)

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(tmpdir(), 'picker-compliance-test-' + Date.now());
const CONFIG_DIR = join(SCRATCH, '.config', 'moltbook');
const LOGS_DIR = join(CONFIG_DIR, 'logs');

// ─── Helpers ───────────────────────────────────────────────────────────

function setupDirs() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
}

function cleanupDirs() {
  rmSync(SCRATCH, { recursive: true, force: true });
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runCompliance(session = '100') {
  const result = execSync(
    `node ${join(__dirname, 'audit-picker-compliance.mjs')} ${session}`,
    {
      env: { ...process.env, HOME: SCRATCH },
      timeout: 10000,
    }
  ).toString().trim();
  return result;
}

function getComplianceState() {
  const statePath = join(CONFIG_DIR, 'picker-compliance-state.json');
  if (!existsSync(statePath)) return null;
  return readJSON(statePath);
}

// ─── Section 1: extractEngagedPlatforms logic ───────────────────────────

describe('platform extraction from trace formats', () => {
  before(setupDirs);
  after(cleanupDirs);

  beforeEach(() => {
    // Fresh mandate for each test
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky', 'chatr', 'moltbook'],
    });
  });

  it('extracts from platforms_engaged array', () => {
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: ['Bluesky', 'Chatr', 'Moltbook'],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('100%'), `Expected 100% compliance, got: ${output}`);
    assert.ok(output.includes('Compliant'), output);
  });

  it('extracts from interactions array', () => {
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      interactions: [
        { platform: 'bluesky', action: 'post' },
        { platform: 'chatr', action: 'message' },
        { platform: 'moltbook', action: 'reply' },
      ],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('100%'), `Expected 100%, got: ${output}`);
  });

  it('extracts from platforms object with engaged flag', () => {
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms: {
        bluesky: { engaged: true },
        chatr: { engaged: true },
        moltbook: { engaged: true },
      },
    });

    const output = runCompliance('100');
    assert.ok(output.includes('100%'), `Expected 100%, got: ${output}`);
  });

  it('extracts from platforms object with posts count', () => {
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms: {
        bluesky: { posts: 2 },
        chatr: { posts: 1 },
        moltbook: { posts: 0, engaged: false },
      },
    });

    const output = runCompliance('100');
    // moltbook has 0 posts and not engaged, so 2/3 = 67%
    assert.ok(output.includes('67%'), `Expected 67%, got: ${output}`);
  });

  it('extracts from posts array', () => {
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      posts: [
        { platform: 'bluesky', content: 'test' },
        { platform: 'chatr', content: 'test' },
        { platform: 'moltbook', content: 'test' },
      ],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('100%'), `Expected 100%, got: ${output}`);
  });

  it('extracts from engagement array', () => {
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      engagement: [
        { platform: 'bluesky' },
        { platform: 'chatr' },
        { platform: 'moltbook' },
      ],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('100%'), `Expected 100%, got: ${output}`);
  });

  it('extracts from threads_contributed array', () => {
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      threads_contributed: [
        { platform: 'bluesky', thread_id: '1' },
        { platform: 'chatr', thread_id: '2' },
        { platform: 'moltbook', thread_id: '3' },
      ],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('100%'), `Expected 100%, got: ${output}`);
  });

  it('handles array-wrapped trace (finds matching session)', () => {
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), [
      { session: 99, platforms_engaged: ['old-platform'] },
      { session: 100, platforms_engaged: ['Bluesky', 'Chatr', 'Moltbook'] },
    ]);

    const output = runCompliance('100');
    assert.ok(output.includes('100%'), `Expected 100%, got: ${output}`);
  });

  it('falls back to most recent entry in array when no session match', () => {
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), [
      { session: 95, platforms_engaged: ['Bluesky'] },
      { session: 98, platforms_engaged: ['Bluesky', 'Chatr', 'Moltbook'] },
    ]);

    const output = runCompliance('100');
    // Should use session 98 entry (most recent)
    assert.ok(output.includes('session 98'), `Expected fallback note, got: ${output}`);
    assert.ok(output.includes('100%'), `Expected 100%, got: ${output}`);
  });

  it('is case-insensitive for platform matching', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['Bluesky', 'CHATR', 'MoltBook'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: ['bluesky', 'chatr', 'moltbook'],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('100%'), `Expected 100%, got: ${output}`);
  });
});

// ─── Section 2: compliance calculation ──────────────────────────────────

describe('compliance calculation', () => {
  before(setupDirs);
  after(cleanupDirs);

  it('reports 0% when no platforms engaged', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky', 'chatr', 'moltbook'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: [],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('0%'), `Expected 0%, got: ${output}`);
    assert.ok(output.includes('VIOLATION'), output);
  });

  it('reports partial compliance correctly', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky', 'chatr', 'moltbook'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: ['Bluesky'],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('33%'), `Expected 33%, got: ${output}`);
    assert.ok(output.includes('VIOLATION'), output);
  });

  it('counts legitimately skipped platforms as compliant', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky', 'chatr', 'moltbook'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: ['Bluesky', 'Chatr'],
      skipped_platforms: [{ platform: 'moltbook', reason: 'site down' }],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('100%'), `Expected 100% (skip counted), got: ${output}`);
    assert.ok(output.includes('Compliant'), output);
  });

  it('treats 66% as non-violation (threshold is < 66)', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky', 'chatr', 'moltbook'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: ['Bluesky', 'Chatr'],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('67%'), `Expected 67%, got: ${output}`);
    assert.ok(output.includes('Compliant'), output);
  });
});

// ─── Section 3: missing files / edge cases ──────────────────────────────

describe('missing files and edge cases', () => {
  before(setupDirs);
  after(cleanupDirs);

  it('handles missing mandate gracefully', () => {
    rmSync(join(CONFIG_DIR, 'picker-mandate.json'), { force: true });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: ['bluesky'],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('No picker mandate found'), output);
  });

  it('handles missing trace gracefully', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky'],
    });
    rmSync(join(CONFIG_DIR, 'engagement-trace.json'), { force: true });

    const output = runCompliance('100');
    assert.ok(output.includes('No engagement trace found'), output);
  });

  it('skips stale mandate (session gap > 5)', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 50,
      selected: ['bluesky'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: ['bluesky'],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('stale mandate'), output);
  });

  it('accepts mandate within 5 sessions', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 97,
      selected: ['bluesky'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: ['Bluesky'],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('100%'), `Expected 100%, got: ${output}`);
  });

  it('handles empty selected array', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: [],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: [],
    });

    const output = runCompliance('100');
    // 0 selected → complianceRate = 1 (100%)
    assert.ok(output.includes('100%'), `Expected 100% for empty selection, got: ${output}`);
  });
});

// ─── Section 4: violation state tracking ────────────────────────────────

describe('violation state tracking', () => {
  before(setupDirs);
  after(cleanupDirs);

  beforeEach(() => {
    // Clean state for each test
    rmSync(join(CONFIG_DIR, 'picker-compliance-state.json'), { force: true });
    rmSync(join(LOGS_DIR, 'picker-violations.log'), { force: true });
  });

  it('increments consecutive_violations on violation', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky', 'chatr', 'moltbook'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: [],
    });

    runCompliance('100');
    const state = getComplianceState();
    assert.ok(state, 'compliance state should be written');
    assert.equal(state.consecutive_violations, 1);
    assert.equal(state.last_violation_session, 100);
  });

  it('resets consecutive_violations on success', () => {
    // Pre-seed state with violations
    writeJSON(join(CONFIG_DIR, 'picker-compliance-state.json'), {
      consecutive_violations: 2,
      last_violation_session: 95,
      history: [],
    });
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: ['Bluesky'],
    });

    runCompliance('100');
    const state = getComplianceState();
    assert.equal(state.consecutive_violations, 0);
  });

  it('keeps history limited to 10 entries', () => {
    // Pre-seed with 10 history entries
    writeJSON(join(CONFIG_DIR, 'picker-compliance-state.json'), {
      consecutive_violations: 0,
      last_violation_session: null,
      history: Array.from({ length: 10 }, (_, i) => ({
        session: 80 + i,
        compliance_pct: 100,
      })),
    });
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: ['Bluesky'],
    });

    runCompliance('100');
    const state = getComplianceState();
    assert.equal(state.history.length, 10, 'history should be capped at 10');
    assert.equal(state.history[0].session, 100, 'most recent should be first');
  });

  it('logs violations to picker-violations.log', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky', 'chatr', 'moltbook'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: [],
    });

    runCompliance('100');
    const logPath = join(LOGS_DIR, 'picker-violations.log');
    assert.ok(existsSync(logPath), 'violations log should be created');
    const content = readFileSync(logPath, 'utf8');
    assert.ok(content.includes('s100'), 'log should contain session number');
    assert.ok(content.includes('VIOLATION'), 'log should contain VIOLATION marker');
  });
});

// ─── Section 5: escalation after 3 consecutive violations ───────────────

describe('escalation logic', () => {
  before(setupDirs);
  after(cleanupDirs);

  beforeEach(() => {
    rmSync(join(CONFIG_DIR, 'picker-compliance-state.json'), { force: true });
  });

  it('does not escalate on first violation', () => {
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky', 'chatr', 'moltbook'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: [],
    });

    const output = runCompliance('100');
    assert.ok(!output.includes('ESCALATION'), `Should not escalate on first violation: ${output}`);
  });

  it('escalates after 3 consecutive violations', () => {
    // Pre-seed with 2 consecutive violations
    writeJSON(join(CONFIG_DIR, 'picker-compliance-state.json'), {
      consecutive_violations: 2,
      last_violation_session: 95,
      history: [],
    });
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky', 'chatr', 'moltbook'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: [],
    });

    const output = runCompliance('100');
    assert.ok(output.includes('ESCALATION'), `Should escalate after 3 violations: ${output}`);
    assert.ok(output.includes('3 consecutive'), output);

    // Check that follow_up was added to trace
    const trace = readJSON(join(CONFIG_DIR, 'engagement-trace.json'));
    assert.ok(trace.follow_ups, 'follow_ups should be added to trace');
    assert.equal(trace.follow_ups.length, 1);
    assert.equal(trace.follow_ups[0].type, 'picker_compliance_alert');
  });

  it('resets violation counter after gap > 10 sessions', () => {
    writeJSON(join(CONFIG_DIR, 'picker-compliance-state.json'), {
      consecutive_violations: 2,
      last_violation_session: 70,  // 30 sessions ago — should reset
      history: [],
    });
    writeJSON(join(CONFIG_DIR, 'picker-mandate.json'), {
      session: 100,
      selected: ['bluesky', 'chatr', 'moltbook'],
    });
    writeJSON(join(CONFIG_DIR, 'engagement-trace.json'), {
      session: 100,
      platforms_engaged: [],
    });

    runCompliance('100');
    const state = getComplianceState();
    assert.equal(state.consecutive_violations, 1, 'should reset to 1 after gap');
  });
});

// ─── Section 6: audit-report.json infrastructure deep validation ────────
// Tests fields that exist in audit-report.json but weren't previously covered

describe('audit-report.json infrastructure deep fields', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  describe('stale_references', () => {
    it('has stale_references in infrastructure', () => {
      assert.ok('stale_references' in report.infrastructure,
        'infrastructure should have stale_references');
    });

    it('stale_references has total_found count', () => {
      const sr = report.infrastructure.stale_references;
      assert.equal(typeof sr.total_found, 'number');
      assert.ok(sr.total_found >= 0);
    });

    it('stale_references details is an array', () => {
      const sr = report.infrastructure.stale_references;
      assert.ok(Array.isArray(sr.details), 'details should be an array');
    });

    it('stale_reference details have required fields', () => {
      const sr = report.infrastructure.stale_references;
      for (const detail of sr.details) {
        assert.ok('deleted_file' in detail || 'file' in detail,
          'detail should have deleted_file or file');
        assert.ok('referenced_in' in detail,
          'detail should have referenced_in');
      }
    });
  });

  describe('covenant_health', () => {
    it('has covenant_health in infrastructure', () => {
      assert.ok('covenant_health' in report.infrastructure);
    });

    it('covenant_health has a note', () => {
      assert.equal(typeof report.infrastructure.covenant_health.note, 'string');
      assert.ok(report.infrastructure.covenant_health.note.length > 0);
    });
  });

  describe('human_review_items', () => {
    it('has human_review_items in infrastructure', () => {
      assert.ok('human_review_items' in report.infrastructure);
    });

    it('human_review_items has total count', () => {
      const hr = report.infrastructure.human_review_items;
      assert.equal(typeof hr.total, 'number');
      assert.ok(hr.total >= 0);
    });
  });

  describe('state_file_consistency', () => {
    it('has state_file_consistency in infrastructure', () => {
      assert.ok('state_file_consistency' in report.infrastructure);
    });

    it('state_file_consistency has a note', () => {
      const sfc = report.infrastructure.state_file_consistency;
      assert.equal(typeof sfc.note, 'string');
      assert.ok(sfc.note.length > 0);
    });
  });
});

// ─── Section 7: pipeline intel deep fields ──────────────────────────────
// d049_compliance and e_artifact_gate are report-level structures

describe('audit-report.json pipeline intel deep fields', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  describe('d049_compliance', () => {
    it('has d049_compliance in pipelines.intel', () => {
      assert.ok('d049_compliance' in report.pipelines.intel);
    });

    it('d049_compliance has sessions_checked array', () => {
      const d = report.pipelines.intel.d049_compliance;
      assert.ok(Array.isArray(d.sessions_checked));
      assert.ok(d.sessions_checked.length > 0, 'should check at least 1 session');
    });

    it('d049_compliance sessions follow s{N} format', () => {
      const d = report.pipelines.intel.d049_compliance;
      for (const s of d.sessions_checked) {
        assert.match(s, /^s\d+$/, `session "${s}" should match s{N} format`);
      }
    });

    it('d049_compliance has violations count', () => {
      const d = report.pipelines.intel.d049_compliance;
      assert.equal(typeof d.violations, 'number');
      assert.ok(d.violations >= 0);
    });

    it('d049_compliance has compliant count', () => {
      const d = report.pipelines.intel.d049_compliance;
      assert.equal(typeof d.compliant, 'number');
      assert.ok(d.compliant >= 0);
    });

    it('violations + compliant = sessions_checked length', () => {
      const d = report.pipelines.intel.d049_compliance;
      assert.equal(d.violations + d.compliant, d.sessions_checked.length,
        `violations (${d.violations}) + compliant (${d.compliant}) should equal checked (${d.sessions_checked.length})`);
    });

    it('compliance_rate is a percentage string', () => {
      const d = report.pipelines.intel.d049_compliance;
      assert.equal(typeof d.compliance_rate, 'string');
      assert.ok(d.compliance_rate.includes('%'), 'should contain %');
    });
  });

  describe('e_artifact_gate', () => {
    it('has e_artifact_gate in pipelines.intel', () => {
      assert.ok('e_artifact_gate' in report.pipelines.intel);
    });

    it('e_artifact_gate has sessions_checked array', () => {
      const e = report.pipelines.intel.e_artifact_gate;
      assert.ok(Array.isArray(e.sessions_checked));
    });

    it('e_artifact_gate has pass and fail counts', () => {
      const e = report.pipelines.intel.e_artifact_gate;
      assert.equal(typeof e.pass, 'number');
      assert.equal(typeof e.fail, 'number');
      assert.ok(e.pass >= 0);
      assert.ok(e.fail >= 0);
    });

    it('pass + fail = sessions_checked length', () => {
      const e = report.pipelines.intel.e_artifact_gate;
      assert.equal(e.pass + e.fail, e.sessions_checked.length,
        `pass (${e.pass}) + fail (${e.fail}) should equal checked (${e.sessions_checked.length})`);
    });

    it('pass_rate is a percentage string', () => {
      const e = report.pipelines.intel.e_artifact_gate;
      assert.equal(typeof e.pass_rate, 'string');
      assert.ok(e.pass_rate.includes('%'), 'should contain %');
    });
  });
});

// ─── Section 8: pipeline queue deep fields ──────────────────────────────

describe('audit-report.json pipeline queue deep fields', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  it('queue has pending count', () => {
    assert.equal(typeof report.pipelines.queue.pending, 'number');
    assert.ok(report.pipelines.queue.pending >= 0);
  });

  it('queue has stuck_items array', () => {
    assert.ok(Array.isArray(report.pipelines.queue.stuck_items));
  });

  it('queue has audit_tagged_pending count', () => {
    assert.equal(typeof report.pipelines.queue.audit_tagged_pending, 'number');
  });

  it('queue has audit_tagged_done_since_last count', () => {
    assert.equal(typeof report.pipelines.queue.audit_tagged_done_since_last, 'number');
  });
});

// ─── Section 9: pipeline directives deep fields ─────────────────────────

describe('audit-report.json pipeline directives deep fields', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  it('directives has active_list array', () => {
    assert.ok(Array.isArray(report.pipelines.directives.active_list));
  });

  it('active_list entries follow d{NNN} format', () => {
    for (const id of report.pipelines.directives.active_list) {
      assert.match(id, /^d\d+$/, `directive "${id}" should match d{N} format`);
    }
  });

  it('has staleness_validation object', () => {
    assert.equal(typeof report.pipelines.directives.staleness_validation, 'object');
    assert.ok(report.pipelines.directives.staleness_validation !== null);
  });

  it('each active directive has staleness entry', () => {
    const sv = report.pipelines.directives.staleness_validation;
    for (const id of report.pipelines.directives.active_list) {
      assert.ok(id in sv, `active directive ${id} should have staleness validation entry`);
    }
  });

  it('staleness entries have truly_stale boolean', () => {
    const sv = report.pipelines.directives.staleness_validation;
    for (const [id, entry] of Object.entries(sv)) {
      assert.equal(typeof entry.truly_stale, 'boolean',
        `${id}.truly_stale should be boolean`);
    }
  });

  it('staleness entries have note string', () => {
    const sv = report.pipelines.directives.staleness_validation;
    for (const [id, entry] of Object.entries(sv)) {
      assert.equal(typeof entry.note, 'string',
        `${id}.note should be string`);
      assert.ok(entry.note.length > 0,
        `${id}.note should not be empty`);
    }
  });
});

// ─── Section 10: sessions deep fields ───────────────────────────────────

describe('audit-report.json sessions deep fields', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  it('B sessions have queue_items_completed count', () => {
    assert.equal(typeof report.sessions.B.queue_items_completed, 'number');
    assert.ok(report.sessions.B.queue_items_completed >= 0);
  });

  it('E sessions have d049_compliance rate', () => {
    assert.equal(typeof report.sessions.E.d049_compliance, 'string');
    assert.ok(report.sessions.E.d049_compliance.includes('%'));
  });

  it('E sessions have artifact_gate_compliance rate', () => {
    assert.equal(typeof report.sessions.E.artifact_gate_compliance, 'string');
    assert.ok(report.sessions.E.artifact_gate_compliance.includes('%'));
  });

  it('R sessions have directive_maintenance_compliance', () => {
    const dmc = report.sessions.R.directive_maintenance_compliance;
    assert.ok(dmc, 'R sessions should have directive_maintenance_compliance');
    assert.ok(Array.isArray(dmc.sessions_checked));
    assert.equal(typeof dmc.compliant, 'number');
    assert.equal(typeof dmc.violations, 'number');
    assert.equal(typeof dmc.rate, 'string');
  });

  it('each session type has count_in_history', () => {
    for (const type of ['B', 'E', 'R', 'A']) {
      assert.equal(typeof report.sessions[type].count_in_history, 'number',
        `sessions.${type}.count_in_history should be number`);
    }
  });

  it('each session type has avg_cost', () => {
    for (const type of ['B', 'E', 'R', 'A']) {
      assert.equal(typeof report.sessions[type].avg_cost, 'number',
        `sessions.${type}.avg_cost should be number`);
    }
  });
});

// ─── Section 11: cost deep fields ──────────────────────────────────────

describe('audit-report.json cost deep fields', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  it('has last_5_avg cost', () => {
    assert.equal(typeof report.cost.last_5_avg, 'number');
    assert.ok(report.cost.last_5_avg > 0);
  });

  it('has highest_cost_sessions array', () => {
    assert.ok(Array.isArray(report.cost.highest_cost_sessions));
  });

  it('highest_cost_sessions entries have required fields', () => {
    for (const entry of report.cost.highest_cost_sessions) {
      assert.equal(typeof entry.session, 'number', 'session should be number');
      assert.equal(typeof entry.type, 'string', 'type should be string');
      assert.equal(typeof entry.cost, 'number', 'cost should be number');
      assert.ok(entry.cost > 0, 'cost should be positive');
    }
  });

  it('highest_cost_sessions are sorted by cost descending', () => {
    const costs = report.cost.highest_cost_sessions.map(e => e.cost);
    for (let i = 1; i < costs.length; i++) {
      assert.ok(costs[i - 1] >= costs[i],
        `highest_cost_sessions not sorted: ${costs[i - 1]} < ${costs[i]}`);
    }
  });

  it('by_type entries have trend string', () => {
    for (const [type, entry] of Object.entries(report.cost.by_type)) {
      assert.equal(typeof entry.trend, 'string',
        `cost.by_type.${type}.trend should be string`);
      assert.ok(entry.trend.length > 0,
        `cost.by_type.${type}.trend should not be empty`);
    }
  });

  it('by_type entries have total', () => {
    for (const [type, entry] of Object.entries(report.cost.by_type)) {
      assert.equal(typeof entry.total, 'number',
        `cost.by_type.${type}.total should be number`);
      assert.ok(entry.total >= 0);
    }
  });
});

// ─── Section 12: security deep fields ──────────────────────────────────

describe('audit-report.json security deep fields', () => {
  let report;

  before(() => {
    report = JSON.parse(readFileSync(join(__dirname, 'audit-report.json'), 'utf8'));
  });

  it('has active_incidents section', () => {
    assert.ok('active_incidents' in report.security);
  });

  it('has unknown_registry_agents array', () => {
    assert.ok(Array.isArray(report.security.unknown_registry_agents));
  });

  it('has suspicious_crons array', () => {
    assert.ok(Array.isArray(report.security.suspicious_crons));
  });

  it('has external_webhooks array', () => {
    assert.ok(Array.isArray(report.security.external_webhooks));
  });

  it('has cron_webhook_monitor_status', () => {
    const cwm = report.security.cron_webhook_monitor_status;
    assert.ok(cwm, 'should have cron_webhook_monitor_status');
    assert.equal(typeof cwm, 'object');
  });

  it('has inbox section', () => {
    assert.ok('inbox' in report.security);
  });
});

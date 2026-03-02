// Tests for providers/directive-outcome.js — directive outcome tracking (wq-778, d071)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_HOME = '/tmp/directive-outcome-test-' + Date.now();
const TEST_BASE = join(TEST_HOME, 'moltbook-mcp');
const TEST_CONFIG = join(TEST_HOME, '.config', 'moltbook');

// Set HOME before import
process.env.HOME = TEST_HOME;

function setup() {
  mkdirSync(TEST_BASE, { recursive: true });
  mkdirSync(TEST_CONFIG, { recursive: true });
  // Minimal directives.json
  writeFileSync(join(TEST_BASE, 'directives.json'), JSON.stringify({
    directives: [
      { id: 'd001', status: 'active', tags: ['testing'], updated: '2026-03-01T00:00:00Z' },
      { id: 'd002', status: 'active', tags: ['infra'], queue_item: 'wq-100' },
      { id: 'd003', status: 'completed', completed_session: 500, tags: [] },
    ]
  }));
  // Minimal work-queue.json
  writeFileSync(join(TEST_BASE, 'work-queue.json'), JSON.stringify({
    queue: [
      { id: 'wq-100', status: 'done', tags: ['infra'], notes: 'completed s500 B#100' },
      { id: 'wq-101', status: 'pending', tags: ['testing'], notes: 'created s499' },
    ]
  }));
  // Empty work-queue-archive
  writeFileSync(join(TEST_BASE, 'work-queue-archive.json'), JSON.stringify({ archived: [] }));
  // Empty engagement files
  writeFileSync(join(TEST_CONFIG, 'engagement-intel.json'), '[]');
  writeFileSync(join(TEST_CONFIG, 'engagement-trace.json'), '{}');
  // Account registry
  writeFileSync(join(TEST_BASE, 'account-registry.json'), JSON.stringify({ accounts: [] }));
}

function cleanup() {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* */ }
}

const { createDirectiveAssignments, computeDirectiveOutcome, saveDirectiveOutcome } = await import('./directive-outcome.js');

describe('providers/directive-outcome.js', () => {
  beforeEach(() => setup());
  afterEach(() => cleanup());

  describe('createDirectiveAssignments', () => {
    it('creates assignment record with correct fields', () => {
      const health = { urgent: [{ id: 'd001' }, { id: 'd002' }], active: [{ id: 'd001' }, { id: 'd002' }, { id: 'd003' }] };
      const result = createDirectiveAssignments(500, 'B', health);
      assert.strictEqual(result.sessionNum, 500);
      assert.strictEqual(result.sessionType, 'B');
      assert.deepStrictEqual(result.urgentDirectives, ['d001', 'd002']);
      assert.strictEqual(result.outcome, null);
      assert.ok(result.assignedAt);
    });

    it('uses urgent directives for B/E/A sessions', () => {
      const health = { urgent: [{ id: 'd001' }], active: [{ id: 'd001' }, { id: 'd002' }] };
      for (const mode of ['B', 'E', 'A']) {
        const result = createDirectiveAssignments(100, mode, health);
        assert.deepStrictEqual(result.urgentDirectives, ['d001'], `${mode} should use urgent`);
      }
    });

    it('uses ALL active directives for R sessions (wq-477 fix)', () => {
      const health = { urgent: [{ id: 'd001' }], active: [{ id: 'd001' }, { id: 'd002' }, { id: 'd003' }] };
      const result = createDirectiveAssignments(100, 'R', health);
      assert.deepStrictEqual(result.urgentDirectives, ['d001', 'd002', 'd003']);
    });

    it('handles empty/missing directive health gracefully', () => {
      const result = createDirectiveAssignments(100, 'B', {});
      assert.deepStrictEqual(result.urgentDirectives, []);

      const result2 = createDirectiveAssignments(100, 'B', null);
      assert.deepStrictEqual(result2.urgentDirectives, []);
    });
  });

  describe('computeDirectiveOutcome', () => {
    it('detects directive-updated evidence', () => {
      const now = new Date();
      // Update directive timestamp to be after assignment
      const directives = JSON.parse(readFileSync(join(TEST_BASE, 'directives.json'), 'utf8'));
      directives.directives[0].updated = new Date(now.getTime() + 60000).toISOString();
      writeFileSync(join(TEST_BASE, 'directives.json'), JSON.stringify(directives));

      const assignments = {
        sessionNum: 500,
        sessionType: 'B',
        assignedAt: now.toISOString(),
        urgentDirectives: ['d001']
      };

      const outcome = computeDirectiveOutcome(assignments, TEST_BASE);
      assert.ok(outcome.addressed.includes('d001'));
      assert.ok(outcome.evidence['d001'].includes('directive-updated'));
    });

    it('detects queue-item-done evidence', () => {
      const assignments = {
        sessionNum: 500,
        sessionType: 'B',
        assignedAt: '2026-01-01T00:00:00Z',
        urgentDirectives: ['d002']
      };
      const outcome = computeDirectiveOutcome(assignments, TEST_BASE);
      assert.ok(outcome.addressed.includes('d002'));
      assert.ok(outcome.evidence['d002'].some(e => e.startsWith('queue-item-done')));
    });

    it('marks directive as ignored when no evidence found', () => {
      // d001 with old timestamp, no queue item link
      const directives = JSON.parse(readFileSync(join(TEST_BASE, 'directives.json'), 'utf8'));
      directives.directives[0].updated = '2025-01-01T00:00:00Z';
      writeFileSync(join(TEST_BASE, 'directives.json'), JSON.stringify(directives));

      const assignments = {
        sessionNum: 999,
        sessionType: 'B',
        assignedAt: new Date().toISOString(),
        urgentDirectives: ['d001']
      };
      const outcome = computeDirectiveOutcome(assignments, TEST_BASE);
      assert.ok(outcome.ignored.includes('d001'));
      assert.strictEqual(outcome.evidence['d001'].length, 0);
    });

    it('detects B session tagged-work evidence', () => {
      // Create a completed queue item with matching tag and session reference
      const wq = JSON.parse(readFileSync(join(TEST_BASE, 'work-queue.json'), 'utf8'));
      wq.queue.push({ id: 'wq-200', status: 'done', tags: ['testing'], notes: 'completed s600 B#200' });
      writeFileSync(join(TEST_BASE, 'work-queue.json'), JSON.stringify(wq));

      const assignments = {
        sessionNum: 600,
        sessionType: 'B',
        assignedAt: '2026-01-01T00:00:00Z',
        urgentDirectives: ['d001']
      };
      const outcome = computeDirectiveOutcome(assignments, TEST_BASE);
      assert.ok(outcome.addressed.includes('d001'));
      assert.ok(outcome.evidence['d001'].some(e => e.startsWith('tagged-work') || e.startsWith('b-session-completions')));
    });

    it('detects E session intel evidence', () => {
      const now = new Date();
      writeFileSync(join(TEST_CONFIG, 'engagement-intel.json'), JSON.stringify([
        { timestamp: new Date(now.getTime() + 60000).toISOString(), content: 'testing intel' }
      ]));

      const assignments = {
        sessionNum: 600,
        sessionType: 'E',
        assignedAt: now.toISOString(),
        urgentDirectives: ['d001']
      };
      const outcome = computeDirectiveOutcome(assignments, TEST_BASE);
      assert.ok(outcome.addressed.includes('d001'));
      assert.ok(outcome.evidence['d001'].some(e => e.startsWith('intel-captured')));
    });

    it('detects R session directive-notes-updated evidence', () => {
      const directives = JSON.parse(readFileSync(join(TEST_BASE, 'directives.json'), 'utf8'));
      directives.directives[0].notes = 'Updated by R#100 s700';
      writeFileSync(join(TEST_BASE, 'directives.json'), JSON.stringify(directives));

      const assignments = {
        sessionNum: 700,
        sessionType: 'R',
        assignedAt: '2026-01-01T00:00:00Z',
        urgentDirectives: ['d001']
      };
      const outcome = computeDirectiveOutcome(assignments, TEST_BASE);
      assert.ok(outcome.addressed.includes('d001'));
      assert.ok(outcome.evidence['d001'].includes('directive-notes-updated'));
    });

    it('detects A session audit-tracking-active evidence', () => {
      const assignments = {
        sessionNum: 700,
        sessionType: 'A',
        assignedAt: '2026-01-01T00:00:00Z',
        urgentDirectives: ['d001']
      };
      const outcome = computeDirectiveOutcome(assignments, TEST_BASE);
      assert.ok(outcome.addressed.includes('d001'));
      assert.ok(outcome.evidence['d001'].includes('audit-tracking-active'));
    });

    it('handles missing data files gracefully', () => {
      // Remove all files
      rmSync(TEST_BASE, { recursive: true, force: true });
      mkdirSync(TEST_BASE, { recursive: true });

      const assignments = {
        sessionNum: 100,
        sessionType: 'B',
        assignedAt: new Date().toISOString(),
        urgentDirectives: ['d099']
      };
      const outcome = computeDirectiveOutcome(assignments, TEST_BASE);
      assert.ok(outcome.ignored.includes('d099'));
    });
  });

  describe('saveDirectiveOutcome', () => {
    it('creates new outcome file when none exists', () => {
      const outcomePath = join(TEST_BASE, 'directive-outcomes.json');
      const assignments = { sessionNum: 500, sessionType: 'B', assignedAt: new Date().toISOString(), urgentDirectives: ['d001'] };
      const outcome = { addressed: ['d001'], ignored: [], evidence: { d001: ['test'] }, completedAt: new Date().toISOString() };
      saveDirectiveOutcome(assignments, outcome, TEST_BASE);

      assert.ok(existsSync(outcomePath));
      const data = JSON.parse(readFileSync(outcomePath, 'utf8'));
      assert.strictEqual(data.outcomes.length, 1);
      assert.strictEqual(data.outcomes[0].session, 500);
      assert.strictEqual(data.outcomes[0].mode, 'B');
      assert.deepStrictEqual(data.outcomes[0].addressed, ['d001']);
    });

    it('deduplicates by session number (wq-435 fix)', () => {
      const outcomePath = join(TEST_BASE, 'directive-outcomes.json');
      const assignments = { sessionNum: 500, sessionType: 'E', assignedAt: new Date().toISOString(), urgentDirectives: ['d001'] };

      // Save twice for same session
      saveDirectiveOutcome(assignments, { addressed: [], ignored: ['d001'], evidence: {} }, TEST_BASE);
      saveDirectiveOutcome(assignments, { addressed: ['d001'], ignored: [], evidence: { d001: ['intel-captured:2'] } }, TEST_BASE);

      const data = JSON.parse(readFileSync(outcomePath, 'utf8'));
      assert.strictEqual(data.outcomes.length, 1, 'Should deduplicate same-session entries');
      assert.deepStrictEqual(data.outcomes[0].addressed, ['d001'], 'Should keep latest (most complete) entry');
    });

    it('keeps at most 50 entries', () => {
      const outcomePath = join(TEST_BASE, 'directive-outcomes.json');
      // Write 55 entries
      for (let i = 0; i < 55; i++) {
        const a = { sessionNum: i, sessionType: 'B', assignedAt: new Date().toISOString(), urgentDirectives: [] };
        saveDirectiveOutcome(a, { addressed: [], ignored: [], evidence: {} }, TEST_BASE);
      }
      const data = JSON.parse(readFileSync(outcomePath, 'utf8'));
      assert.ok(data.outcomes.length <= 50, `Should cap at 50, got ${data.outcomes.length}`);
    });

    it('flattens schema with mode and addressed at top level (wq-411)', () => {
      const outcomePath = join(TEST_BASE, 'directive-outcomes.json');
      const assignments = { sessionNum: 500, sessionType: 'B', assignedAt: new Date().toISOString(), urgentDirectives: ['d001'] };
      const outcome = { addressed: ['d001'], ignored: [], evidence: {} };
      saveDirectiveOutcome(assignments, outcome, TEST_BASE);

      const data = JSON.parse(readFileSync(outcomePath, 'utf8'));
      const entry = data.outcomes[0];
      assert.strictEqual(entry.mode, 'B');
      assert.strictEqual(entry.session, 500);
      assert.deepStrictEqual(entry.addressed, ['d001']);
    });
  });
});

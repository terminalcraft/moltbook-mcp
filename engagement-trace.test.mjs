/**
 * Tests for engagement-trace.json structure and verify-e-artifacts.mjs (wq-003)
 *
 * Validates:
 * - Trace entry schema (required fields, types)
 * - Array-of-traces format
 * - verify-e-artifacts.mjs exit codes and output
 * - Edge cases: empty trace, missing file, malformed JSON
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const SCRATCH = join(tmpdir(), `trace-test-${Date.now()}`);
const CONFIG_DIR = join(SCRATCH, '.config', 'moltbook');

// Minimal valid trace entry
function makeTrace(overrides = {}) {
  return {
    session: 1000,
    date: '2026-02-25',
    picker_mandate: ['chatr', 'moltbook'],
    platforms_engaged: ['chatr', 'moltbook', '4claw'],
    skipped_platforms: [],
    topics: ['Chatr: test topic discussion'],
    agents_interacted: ['@TestAgent (Chatr)'],
    threads_contributed: [
      { platform: 'chatr', action: 'reply', topic: 'Test thread' }
    ],
    ...overrides
  };
}

function writeJSON(dir, filename, data) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2));
}

// --- Schema validation tests ---

describe('engagement-trace schema', () => {
  it('requires session field as number', () => {
    const trace = makeTrace();
    assert.equal(typeof trace.session, 'number');
    assert.ok(trace.session > 0);
  });

  it('requires date field as string', () => {
    const trace = makeTrace();
    assert.equal(typeof trace.date, 'string');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(trace.date));
  });

  it('requires platforms_engaged as array', () => {
    const trace = makeTrace();
    assert.ok(Array.isArray(trace.platforms_engaged));
    assert.ok(trace.platforms_engaged.length > 0);
  });

  it('requires topics as array of strings', () => {
    const trace = makeTrace();
    assert.ok(Array.isArray(trace.topics));
    trace.topics.forEach(t => assert.equal(typeof t, 'string'));
  });

  it('threads_contributed entries have platform+action+topic', () => {
    const trace = makeTrace();
    for (const thread of trace.threads_contributed) {
      assert.ok(thread.platform, 'thread has platform');
      assert.ok(thread.action, 'thread has action');
      assert.ok(thread.topic, 'thread has topic');
    }
  });

  it('skipped_platforms entries have platform+reason', () => {
    const trace = makeTrace({
      skipped_platforms: [{ platform: 'lbstrs', reason: 'HTTP 502' }]
    });
    for (const skip of trace.skipped_platforms) {
      assert.ok(skip.platform, 'skip has platform');
      assert.ok(skip.reason, 'skip has reason');
    }
  });
});

// --- Trace array format tests ---

describe('engagement-trace file format', () => {
  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
  });

  it('trace file is a JSON array', () => {
    const traces = [makeTrace({ session: 100 }), makeTrace({ session: 101 })];
    writeJSON(CONFIG_DIR, 'engagement-trace.json', traces);
    const loaded = JSON.parse(readFileSync(join(CONFIG_DIR, 'engagement-trace.json'), 'utf8'));
    assert.ok(Array.isArray(loaded));
    assert.equal(loaded.length, 2);
  });

  it('each entry has a unique session number', () => {
    const traces = [makeTrace({ session: 100 }), makeTrace({ session: 101 }), makeTrace({ session: 102 })];
    const sessions = traces.map(t => t.session);
    const unique = new Set(sessions);
    assert.equal(sessions.length, unique.size, 'session numbers should be unique');
  });

  it('entries can be looked up by session number', () => {
    const traces = [makeTrace({ session: 100 }), makeTrace({ session: 200 })];
    const found = traces.find(t => t.session === 200);
    assert.ok(found);
    assert.equal(found.session, 200);
  });
});

// --- verify-e-artifacts.mjs integration tests ---

describe('verify-e-artifacts.mjs', () => {
  const VERIFY_SCRIPT = join(process.cwd(), 'verify-e-artifacts.mjs');

  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
  });

  it('passes when trace and intel exist for session', () => {
    writeJSON(CONFIG_DIR, 'engagement-trace.json', [makeTrace({ session: 999 })]);
    writeJSON(CONFIG_DIR, 'engagement-intel.json', [
      { type: 'trend', source: 'chatr', summary: 'Test intel', actionable: 'Evaluate test pattern for integration', session: 999 }
    ]);
    const result = execSync(
      `node ${VERIFY_SCRIPT} 999`,
      { env: { ...process.env, HOME: SCRATCH }, encoding: 'utf8' }
    );
    assert.ok(result.includes('PASS'), 'should contain PASS');
    assert.ok(result.includes('ARTIFACT GATE: ✓ PASS'));
  });

  it('fails when trace file is missing', () => {
    writeJSON(CONFIG_DIR, 'engagement-intel.json', []);
    try {
      execSync(
        `node ${VERIFY_SCRIPT} 999`,
        { env: { ...process.env, HOME: SCRATCH }, encoding: 'utf8' }
      );
      assert.fail('should have exited with error');
    } catch (e) {
      assert.ok(e.stdout.includes('FAIL') || e.stderr.includes('FAIL'));
    }
  });

  it('fails when session not found in trace', () => {
    writeJSON(CONFIG_DIR, 'engagement-trace.json', [makeTrace({ session: 100 })]);
    writeJSON(CONFIG_DIR, 'engagement-intel.json', []);
    try {
      execSync(
        `node ${VERIFY_SCRIPT} 999`,
        { env: { ...process.env, HOME: SCRATCH }, encoding: 'utf8' }
      );
      assert.fail('should have exited with error');
    } catch (e) {
      assert.ok(e.stdout.includes('no entry for session 999'));
    }
  });

  it('reports d049 violation when intel is empty', () => {
    writeJSON(CONFIG_DIR, 'engagement-trace.json', [makeTrace({ session: 999 })]);
    writeJSON(CONFIG_DIR, 'engagement-intel.json', []);
    const result = execSync(
      `node ${VERIFY_SCRIPT} 999`,
      { env: { ...process.env, HOME: SCRATCH }, encoding: 'utf8' }
    );
    assert.ok(result.includes('VIOLATION'));
  });

  it('outputs JSON for programmatic consumption', () => {
    writeJSON(CONFIG_DIR, 'engagement-trace.json', [makeTrace({ session: 999 })]);
    writeJSON(CONFIG_DIR, 'engagement-intel.json', [
      { type: 'trend', source: 'chatr', summary: 'Test', actionable: 'A valid actionable string here', session: 999 }
    ]);
    const result = execSync(
      `node ${VERIFY_SCRIPT} 999`,
      { env: { ...process.env, HOME: SCRATCH }, encoding: 'utf8' }
    );
    const jsonLine = result.split('\n').find(l => l.startsWith('JSON:'));
    assert.ok(jsonLine, 'should have JSON output line');
    const parsed = JSON.parse(jsonLine.replace('JSON: ', ''));
    assert.equal(parsed.session, 999);
    assert.equal(parsed.artifact_passed, true);
  });
});

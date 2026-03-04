#!/usr/bin/env node
// d049-tracking-update.test.mjs — Unit tests for d049-tracking-update.mjs (wq-821)
//
// Covers: new session insertion, existing session update, failure mode labeling,
// missing tracking file creation, e_number calculation with gaps, DI deps.
//
// Usage: node --test hooks/lib/d049-tracking-update.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { updateTracking } from './d049-tracking-update.mjs';

// Mock FS that stores data in memory
function mockFs(initialData = null) {
  let stored = initialData ? JSON.stringify(initialData) : null;
  return {
    readFileSync(path, enc) {
      if (stored === null) throw new Error('ENOENT: no such file');
      return stored;
    },
    writeFileSync(path, data) {
      stored = data;
    },
    getStored() {
      return stored ? JSON.parse(stored) : null;
    },
  };
}

const silentLog = () => {};

describe('d049-tracking-update', () => {

  // ---- NEW SESSION INSERTION ----

  describe('new session insertion', () => {
    test('compliant session (intel > 0) inserts with d049_compliant=true', () => {
      const fs = mockFs({ sessions: [] });
      const result = updateTracking({
        session: 100, trackingFile: '/tmp/t.json',
        intelCount: 3, failureMode: 'none',
        deps: { ...fs, log: silentLog },
      });

      assert.strictEqual(result.compliant, true);
      const data = fs.getStored();
      assert.strictEqual(data.sessions.length, 1);
      assert.strictEqual(data.sessions[0].session, 100);
      assert.strictEqual(data.sessions[0].d049_compliant, true);
      assert.strictEqual(data.sessions[0].intel_count, 3);
      assert.strictEqual(data.sessions[0].enforcement, 'post-hook');
      assert.ok(!data.sessions[0].failure_mode, 'should not have failure_mode for compliant');
    });

    test('non-compliant session (intel=0) inserts with d049_compliant=false', () => {
      const fs = mockFs({ sessions: [] });
      const result = updateTracking({
        session: 101, trackingFile: '/tmp/t.json',
        intelCount: 0, failureMode: 'truncated_early',
        deps: { ...fs, log: silentLog },
      });

      assert.strictEqual(result.compliant, false);
      const data = fs.getStored();
      assert.strictEqual(data.sessions[0].d049_compliant, false);
      assert.strictEqual(data.sessions[0].failure_mode, 'truncated_early');
      assert.ok(data.sessions[0].notes.includes('d049 violation'));
      assert.ok(data.sessions[0].notes.includes('Truncated before Phase 2'));
    });

    test('compliant session notes include intel count', () => {
      const fs = mockFs({ sessions: [] });
      updateTracking({
        session: 102, trackingFile: '/tmp/t.json',
        intelCount: 5, failureMode: 'none',
        deps: { ...fs, log: silentLog },
      });

      const data = fs.getStored();
      assert.ok(data.sessions[0].notes.includes('5 intel'));
    });
  });

  // ---- EXISTING SESSION UPDATE ----

  describe('existing session update', () => {
    test('updates existing session entry instead of duplicating', () => {
      const initial = {
        sessions: [{
          session: 200, e_number: 50, d049_compliant: false,
          intel_count: 0, enforcement: 'post-hook',
          failure_mode: 'truncated_early', notes: 'old notes',
        }],
      };
      const fs = mockFs(initial);
      updateTracking({
        session: 200, trackingFile: '/tmp/t.json',
        intelCount: 3, failureMode: 'none',
        deps: { ...fs, log: silentLog },
      });

      const data = fs.getStored();
      assert.strictEqual(data.sessions.length, 1, 'should not duplicate');
      assert.strictEqual(data.sessions[0].d049_compliant, true);
      assert.strictEqual(data.sessions[0].intel_count, 3);
      assert.strictEqual(data.sessions[0].enforcement, 'post-hook');
    });

    test('existing session update preserves e_number and notes', () => {
      const initial = {
        sessions: [{
          session: 201, e_number: 51, d049_compliant: false,
          intel_count: 0, notes: 'should remain',
        }],
      };
      const fs = mockFs(initial);
      updateTracking({
        session: 201, trackingFile: '/tmp/t.json',
        intelCount: 2, failureMode: 'none',
        deps: { ...fs, log: silentLog },
      });

      const data = fs.getStored();
      assert.strictEqual(data.sessions[0].e_number, 51);
      assert.strictEqual(data.sessions[0].notes, 'should remain');
    });

    test('existing session update adds failure_mode when non-none', () => {
      const initial = {
        sessions: [{
          session: 202, e_number: 52, d049_compliant: true,
          intel_count: 3,
        }],
      };
      const fs = mockFs(initial);
      updateTracking({
        session: 202, trackingFile: '/tmp/t.json',
        intelCount: 0, failureMode: 'agent_skip',
        deps: { ...fs, log: silentLog },
      });

      const data = fs.getStored();
      assert.strictEqual(data.sessions[0].failure_mode, 'agent_skip');
    });
  });

  // ---- FAILURE MODE LABELING ----

  describe('failure mode labeling', () => {
    const modes = [
      ['rate_limit', 'Rate-limited'],
      ['truncated_early', 'Truncated before Phase 2'],
      ['platform_unavailable', 'All picker platforms returned errors'],
      ['trace_without_intel', 'Trace written'],
      ['agent_skip', 'Agent reached Phase 2'],
      ['unknown', 'could not be determined'],
    ];

    for (const [mode, expectedSubstr] of modes) {
      test(`failure mode "${mode}" produces correct label`, () => {
        const fs = mockFs({ sessions: [] });
        updateTracking({
          session: 300, trackingFile: '/tmp/t.json',
          intelCount: 0, failureMode: mode,
          deps: { ...fs, log: silentLog },
        });

        const data = fs.getStored();
        assert.ok(data.sessions[0].notes.includes(expectedSubstr),
          `Expected "${expectedSubstr}" in notes: ${data.sessions[0].notes}`);
        assert.strictEqual(data.sessions[0].failure_mode, mode);
      });
    }

    test('custom/unknown failure mode uses raw string', () => {
      const fs = mockFs({ sessions: [] });
      updateTracking({
        session: 301, trackingFile: '/tmp/t.json',
        intelCount: 0, failureMode: 'custom_weird_thing',
        deps: { ...fs, log: silentLog },
      });

      const data = fs.getStored();
      assert.ok(data.sessions[0].notes.includes('custom_weird_thing'));
    });
  });

  // ---- MISSING TRACKING FILE ----

  describe('missing tracking file', () => {
    test('creates new tracking structure when file does not exist', () => {
      const fs = mockFs(null); // null = file doesn't exist
      const result = updateTracking({
        session: 400, trackingFile: '/tmp/t.json',
        intelCount: 2, failureMode: 'none',
        deps: { ...fs, log: silentLog },
      });

      assert.strictEqual(result.compliant, true);
      const data = fs.getStored();
      assert.ok(Array.isArray(data.sessions));
      assert.strictEqual(data.sessions.length, 1);
      assert.strictEqual(data.sessions[0].session, 400);
    });
  });

  // ---- E_NUMBER CALCULATION ----

  describe('e_number calculation', () => {
    test('first session gets e_number=1', () => {
      const fs = mockFs({ sessions: [] });
      updateTracking({
        session: 500, trackingFile: '/tmp/t.json',
        intelCount: 1, failureMode: 'none',
        deps: { ...fs, log: silentLog },
      });

      const data = fs.getStored();
      assert.strictEqual(data.sessions[0].e_number, 1);
    });

    test('sequential sessions get incrementing e_numbers', () => {
      const initial = {
        sessions: [
          { session: 500, e_number: 1, d049_compliant: true },
          { session: 510, e_number: 2, d049_compliant: true },
        ],
      };
      const fs = mockFs(initial);
      updateTracking({
        session: 520, trackingFile: '/tmp/t.json',
        intelCount: 1, failureMode: 'none',
        deps: { ...fs, log: silentLog },
      });

      const data = fs.getStored();
      assert.strictEqual(data.sessions[2].e_number, 3);
    });

    test('handles e_number gaps — takes max+1', () => {
      // Simulate a gap where e_number jumped (maybe a session was manually inserted)
      const initial = {
        sessions: [
          { session: 500, e_number: 1, d049_compliant: true },
          { session: 510, e_number: 5, d049_compliant: true }, // gap: 2,3,4 skipped
        ],
      };
      const fs = mockFs(initial);
      updateTracking({
        session: 520, trackingFile: '/tmp/t.json',
        intelCount: 1, failureMode: 'none',
        deps: { ...fs, log: silentLog },
      });

      const data = fs.getStored();
      // e_number should be max(existing) + 1 = 6, not count+1=3
      assert.strictEqual(data.sessions[2].e_number, 6);
    });

    test('out-of-order session insertion still gets correct e_number', () => {
      const initial = {
        sessions: [
          { session: 500, e_number: 1, d049_compliant: true },
          { session: 520, e_number: 3, d049_compliant: true },
        ],
      };
      const fs = mockFs(initial);
      // Insert session 510 (between existing 500 and 520)
      updateTracking({
        session: 510, trackingFile: '/tmp/t.json',
        intelCount: 1, failureMode: 'none',
        deps: { ...fs, log: silentLog },
      });

      const data = fs.getStored();
      // count of sessions < 510 = 1 (session 500) → base eNum = 2
      // but session 520 has e_number=3 which is >= 2 → eNum = 4
      assert.strictEqual(data.sessions[2].e_number, 4);
    });
  });

  // ---- RETURN VALUE ----

  describe('return value', () => {
    test('returns compliant boolean and tracking object', () => {
      const fs = mockFs({ sessions: [] });
      const result = updateTracking({
        session: 600, trackingFile: '/tmp/t.json',
        intelCount: 2, failureMode: 'none',
        deps: { ...fs, log: silentLog },
      });

      assert.strictEqual(typeof result.compliant, 'boolean');
      assert.ok(result.tracking);
      assert.ok(Array.isArray(result.tracking.sessions));
    });
  });

  // ---- LOG OUTPUT ----

  describe('log output', () => {
    test('logs tracking update with session details', () => {
      const logs = [];
      const fs = mockFs({ sessions: [] });
      updateTracking({
        session: 700, trackingFile: '/tmp/t.json',
        intelCount: 3, failureMode: 'none',
        deps: { ...fs, log: (msg) => logs.push(msg) },
      });

      assert.strictEqual(logs.length, 1);
      assert.ok(logs[0].includes('s700'));
      assert.ok(logs[0].includes('compliant=true'));
      assert.ok(logs[0].includes('count=3'));
    });
  });
});

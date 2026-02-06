#!/usr/bin/env node
/**
 * engagement-variety.test.mjs — Tests for engagement-variety.mjs (wq-382)
 *
 * Tests the analyzeVariety function with various trace data scenarios.
 * Uses a temp HOME dir to isolate from real engagement-trace.json.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const TEMP_HOME = join(tmpdir(), `ev-test-${Date.now()}`);
const CONFIG_DIR = join(TEMP_HOME, '.config/moltbook');
const TRACE_PATH = join(CONFIG_DIR, 'engagement-trace.json');

function writeTrace(data) {
  writeFileSync(TRACE_PATH, JSON.stringify(data, null, 2));
}

function runVariety(args = '') {
  const cmd = `HOME=${TEMP_HOME} node engagement-variety.mjs --json ${args}`;
  try {
    const out = execSync(cmd, { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
    return JSON.parse(out.trim());
  } catch (e) {
    if (e.stdout) {
      try { return JSON.parse(e.stdout.trim()); } catch { /* */ }
    }
    throw new Error(`Command failed: ${e.message}\nstdout: ${e.stdout}\nstderr: ${e.stderr}`);
  }
}

describe('engagement-variety', () => {
  before(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
  });

  after(() => {
    rmSync(TEMP_HOME, { recursive: true, force: true });
  });

  describe('no data scenarios', () => {
    it('returns NO_DATA when trace file missing', () => {
      // Use a home with no trace file
      const emptyHome = join(tmpdir(), `ev-empty-${Date.now()}`);
      mkdirSync(join(emptyHome, '.config/moltbook'), { recursive: true });
      try {
        const cmd = `HOME=${emptyHome} node engagement-variety.mjs --json`;
        const out = execSync(cmd, { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
        const result = JSON.parse(out.trim());
        assert.equal(result.status, 'NO_DATA');
        assert.equal(result.sessions_analyzed, 0);
        assert.equal(result.concentration_alert, false);
      } finally {
        rmSync(emptyHome, { recursive: true, force: true });
      }
    });

    it('returns NO_DATA for empty array', () => {
      writeTrace([]);
      const result = runVariety();
      assert.equal(result.status, 'NO_DATA');
      assert.equal(result.sessions_analyzed, 0);
    });

    it('returns NO_ACTIONS when traces have no engagement data', () => {
      writeTrace([
        { session: 100 },
        { session: 101 }
      ]);
      const result = runVariety();
      assert.equal(result.status, 'NO_ACTIONS');
      assert.equal(result.sessions_analyzed, 2);
      assert.equal(result.concentration_alert, false);
    });
  });

  describe('healthy distribution', () => {
    it('detects healthy multi-platform engagement', () => {
      writeTrace([
        {
          session: 200,
          threads_contributed: [
            { platform: 'chatr', thread: 't1' },
            { platform: 'moltbook', thread: 't2' },
            { platform: '4claw', thread: 't3' }
          ]
        },
        {
          session: 201,
          threads_contributed: [
            { platform: 'chatr', thread: 't4' },
            { platform: '4claw', thread: 't5' }
          ]
        }
      ]);
      const result = runVariety();
      assert.equal(result.status, 'HEALTHY');
      assert.equal(result.sessions_analyzed, 2);
      assert.equal(result.total_actions, 5);
      assert.equal(result.concentration_alert, false);
      assert.ok(result.platform_distribution.chatr);
      assert.ok(result.platform_distribution['4claw']);
      assert.ok(result.platform_distribution.moltbook);
    });

    it('uses platforms_engaged as fallback when no threads_contributed', () => {
      writeTrace([
        {
          session: 300,
          platforms_engaged: ['chatr', 'moltbook', '4claw']
        }
      ]);
      const result = runVariety();
      assert.equal(result.status, 'HEALTHY');
      assert.equal(result.total_actions, 3);
      assert.equal(result.sessions_analyzed, 1);
    });
  });

  describe('concentration detection', () => {
    it('alerts when one platform dominates (>60%)', () => {
      writeTrace([
        {
          session: 400,
          threads_contributed: [
            { platform: 'chatr', thread: 't1' },
            { platform: 'chatr', thread: 't2' },
            { platform: 'chatr', thread: 't3' },
            { platform: 'chatr', thread: 't4' },
            { platform: 'moltbook', thread: 't5' }
          ]
        }
      ]);
      const result = runVariety();
      assert.equal(result.status, 'CONCENTRATED');
      assert.equal(result.concentration_alert, true);
      assert.equal(result.most_engaged, 'chatr');
      assert.equal(result.most_engaged_pct, 80); // 4/5 = 80%
    });

    it('respects custom threshold', () => {
      writeTrace([
        {
          session: 500,
          threads_contributed: [
            { platform: 'chatr', thread: 't1' },
            { platform: 'chatr', thread: 't2' },
            { platform: 'moltbook', thread: 't3' }
          ]
        }
      ]);
      // 67% chatr — above 60 default but below 70
      const result60 = runVariety('--threshold 60');
      assert.equal(result60.concentration_alert, true);

      const result70 = runVariety('--threshold 70');
      assert.equal(result70.concentration_alert, false);
    });
  });

  describe('session windowing', () => {
    it('only analyzes last N sessions', () => {
      writeTrace([
        { session: 600, threads_contributed: [{ platform: 'old_platform', thread: 't1' }] },
        { session: 601, threads_contributed: [{ platform: 'old_platform', thread: 't2' }] },
        { session: 602, threads_contributed: [{ platform: 'chatr', thread: 't3' }] },
        { session: 603, threads_contributed: [{ platform: 'moltbook', thread: 't4' }] },
        { session: 604, threads_contributed: [{ platform: '4claw', thread: 't5' }] }
      ]);
      // Only look at last 3 sessions
      const result = runVariety('--sessions 3');
      assert.equal(result.sessions_analyzed, 3);
      assert.ok(result.session_numbers.includes(602));
      assert.ok(result.session_numbers.includes(603));
      assert.ok(result.session_numbers.includes(604));
      // old_platform should not appear
      assert.equal(result.platform_distribution.old_platform, undefined);
    });

    it('handles fewer traces than requested sessions', () => {
      writeTrace([
        { session: 700, threads_contributed: [{ platform: 'chatr', thread: 't1' }] }
      ]);
      const result = runVariety('--sessions 10');
      assert.equal(result.sessions_analyzed, 1);
    });
  });

  describe('edge cases', () => {
    it('handles malformed JSON in trace file gracefully', () => {
      writeFileSync(TRACE_PATH, 'not-valid-json{{{');
      const result = runVariety();
      assert.equal(result.status, 'NO_DATA');
    });

    it('handles unknown platform gracefully', () => {
      writeTrace([
        {
          session: 800,
          threads_contributed: [
            { thread: 't1' }, // no platform field → defaults to 'unknown'
            { platform: 'chatr', thread: 't2' }
          ]
        }
      ]);
      const result = runVariety();
      assert.ok(result.platform_distribution.unknown, 'missing platform defaults to unknown');
      assert.equal(result.platform_distribution.unknown.count, 1);
      assert.equal(result.total_actions, 2);
    });
  });
});

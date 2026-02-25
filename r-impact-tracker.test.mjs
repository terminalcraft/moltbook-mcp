#!/usr/bin/env node
// r-impact-tracker.test.mjs — Tests for R session impact tracker
// Usage: node --test r-impact-tracker.test.mjs

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We override HOME so the module's hardcoded paths resolve to temp dirs
const originalHome = process.env.HOME;
let tempDir;
let configDir;

async function freshImport() {
  // Dynamic import with cache-bust to get fresh module state
  const mod = await import(`./lib/r-impact-tracker.mjs?t=${Date.now()}-${Math.random()}`);
  return mod;
}

describe('r-impact-tracker', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'r-impact-test-'));
    configDir = join(tempDir, '.config', 'moltbook');
    mkdirSync(configDir, { recursive: true });
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('trackImpact recording', () => {
    it('creates impact file on first run', async () => {
      const { trackImpact } = await freshImport();
      const result = trackImpact(1500, 'SESSION_BUILD.md', 'prompt');
      assert.equal(result.category, 'prompt');
      assert.equal(result.analysisCount, 0);

      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes.length, 1);
      assert.equal(data.changes[0].session, 1500);
      assert.equal(data.changes[0].file, 'SESSION_BUILD.md');
      assert.equal(data.changes[0].category, 'prompt');
      assert.equal(data.changes[0].analyzed, false);
    });

    it('records intent when provided', async () => {
      const { trackImpact } = await freshImport();
      trackImpact(1500, 'heartbeat.sh', 'tooling', 'cost_decrease');

      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes[0].intent, 'cost_decrease');
    });

    it('skips recording when no category provided', async () => {
      const { trackImpact } = await freshImport();
      trackImpact(1500, 'some-file.mjs', null);

      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes.length, 0);
    });

    it('caps changes at 50 entries', async () => {
      const { trackImpact } = await freshImport();
      // Pre-seed with 49 changes
      const seed = { version: 1, changes: [], analysis: [] };
      for (let i = 0; i < 49; i++) {
        seed.changes.push({ session: 1000 + i, file: `f${i}`, category: 'test', analyzed: false });
      }
      writeFileSync(join(configDir, 'r-session-impact.json'), JSON.stringify(seed));

      trackImpact(1500, 'new-file.mjs', 'tooling');

      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes.length, 50);
      assert.equal(data.changes[49].session, 1500);
    });

    it('returns category none when no category', async () => {
      const { trackImpact } = await freshImport();
      const result = trackImpact(1500, null, null);
      assert.equal(result.category, 'none');
    });
  });

  describe('assessImpact thresholds', () => {
    // We test impact assessment indirectly by providing outcomes data
    // that produces known cost/success deltas, then checking the analysis

    it('detects positive impact (default: cost decreased)', async () => {
      const { trackImpact } = await freshImport();
      // Seed a change at session 100 (already old enough to analyze)
      const seed = {
        version: 1,
        changes: [{
          session: 100, file: 'SESSION_BUILD.md', category: 'prompt', analyzed: false,
        }],
        analysis: [],
      };
      writeFileSync(join(configDir, 'r-session-impact.json'), JSON.stringify(seed));

      // Outcomes: before=expensive, after=cheap (>10% decrease = positive)
      const outcomes = [];
      for (let i = 90; i < 100; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 3.00, outcome: 'success' });
      }
      for (let i = 101; i <= 110; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 2.00, outcome: 'success' });
      }
      writeFileSync(join(configDir, 'session-outcomes.json'), JSON.stringify(outcomes));

      const result = trackImpact(115, null, null);
      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes[0].analyzed, true);
      assert.equal(data.changes[0].impact, 'positive');
      assert.ok(data.changes[0].metrics.cost_delta_pct < 0);
      assert.equal(result.analysisCount, 1);
    });

    it('detects negative impact (default: cost increased)', async () => {
      const { trackImpact } = await freshImport();
      const seed = {
        version: 1,
        changes: [{
          session: 100, file: 'index.js', category: 'tooling', analyzed: false,
        }],
        analysis: [],
      };
      writeFileSync(join(configDir, 'r-session-impact.json'), JSON.stringify(seed));

      const outcomes = [];
      for (let i = 90; i < 100; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 2.00, outcome: 'success' });
      }
      for (let i = 101; i <= 110; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 2.50, outcome: 'success' }); // +25% cost
      }
      writeFileSync(join(configDir, 'session-outcomes.json'), JSON.stringify(outcomes));

      trackImpact(115, null, null);
      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes[0].impact, 'negative');
    });

    it('detects neutral impact (small changes)', async () => {
      const { trackImpact } = await freshImport();
      const seed = {
        version: 1,
        changes: [{
          session: 100, file: 'SESSION_BUILD.md', category: 'prompt', analyzed: false,
        }],
        analysis: [],
      };
      writeFileSync(join(configDir, 'r-session-impact.json'), JSON.stringify(seed));

      const outcomes = [];
      for (let i = 90; i < 100; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 2.00, outcome: 'success' });
      }
      for (let i = 101; i <= 110; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 2.05, outcome: 'success' }); // +2.5%
      }
      writeFileSync(join(configDir, 'session-outcomes.json'), JSON.stringify(outcomes));

      trackImpact(115, null, null);
      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes[0].impact, 'neutral');
    });
  });

  describe('intent-aware cost logic', () => {
    it('cost_increase intent: rising cost is positive', async () => {
      const { trackImpact } = await freshImport();
      const seed = {
        version: 1,
        changes: [{
          session: 100, file: 'SESSION_BUILD.md', category: 'prompt',
          analyzed: false, intent: 'cost_increase',
        }],
        analysis: [],
      };
      writeFileSync(join(configDir, 'r-session-impact.json'), JSON.stringify(seed));

      const outcomes = [];
      for (let i = 90; i < 100; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 2.00, outcome: 'success' });
      }
      for (let i = 101; i <= 110; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 2.50, outcome: 'success' }); // +25%
      }
      writeFileSync(join(configDir, 'session-outcomes.json'), JSON.stringify(outcomes));

      trackImpact(115, null, null);
      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes[0].impact, 'positive');
    });

    it('cost_decrease intent: rising cost is negative', async () => {
      const { trackImpact } = await freshImport();
      const seed = {
        version: 1,
        changes: [{
          session: 100, file: 'heartbeat.sh', category: 'tooling',
          analyzed: false, intent: 'cost_decrease',
        }],
        analysis: [],
      };
      writeFileSync(join(configDir, 'r-session-impact.json'), JSON.stringify(seed));

      const outcomes = [];
      for (let i = 90; i < 100; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 2.00, outcome: 'success' });
      }
      for (let i = 101; i <= 110; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 2.30, outcome: 'success' }); // +15%
      }
      writeFileSync(join(configDir, 'session-outcomes.json'), JSON.stringify(outcomes));

      trackImpact(115, null, null);
      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes[0].impact, 'negative');
    });
  });

  describe('target type detection', () => {
    it('filters outcomes by BUILD session type', async () => {
      const { trackImpact } = await freshImport();
      const seed = {
        version: 1,
        changes: [{
          session: 100, file: 'SESSION_BUILD.md', category: 'prompt', analyzed: false,
        }],
        analysis: [],
      };
      writeFileSync(join(configDir, 'r-session-impact.json'), JSON.stringify(seed));

      // Mix of B and E sessions — only B should be compared
      const outcomes = [];
      for (let i = 90; i < 100; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 3.00, outcome: 'success' });
        outcomes.push({ session: i, mode: 'E', cost_usd: 1.00, outcome: 'success' });
      }
      for (let i = 101; i <= 110; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 2.00, outcome: 'success' });
        outcomes.push({ session: i, mode: 'E', cost_usd: 5.00, outcome: 'success' }); // E got expensive
      }
      writeFileSync(join(configDir, 'session-outcomes.json'), JSON.stringify(outcomes));

      trackImpact(115, null, null);
      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes[0].metrics.target_type, 'B');
      // Cost went from 3.00 to 2.00 for B sessions = -33% = positive
      assert.equal(data.changes[0].impact, 'positive');
    });
  });

  describe('digest generation', () => {
    it('generates digest file after analysis', async () => {
      const { trackImpact } = await freshImport();
      const seed = {
        version: 1,
        changes: [{
          session: 100, file: 'SESSION_BUILD.md', category: 'prompt', analyzed: false,
        }],
        analysis: [],
      };
      writeFileSync(join(configDir, 'r-session-impact.json'), JSON.stringify(seed));

      const outcomes = [];
      for (let i = 90; i < 100; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 3.00, outcome: 'success' });
      }
      for (let i = 101; i <= 110; i++) {
        outcomes.push({ session: i, mode: 'B', cost_usd: 2.00, outcome: 'success' });
      }
      writeFileSync(join(configDir, 'session-outcomes.json'), JSON.stringify(outcomes));

      trackImpact(115, null, null);

      const digestPath = join(configDir, 'r-session-impact-digest.txt');
      const digest = readFileSync(digestPath, 'utf8');
      assert.ok(digest.includes('# R Session Impact Digest'));
      assert.ok(digest.includes('## Category Performance'));
      assert.ok(digest.includes('prompt'));
    });

    it('shows pending analysis count in digest', async () => {
      const { trackImpact } = await freshImport();
      // Record a change but don't provide enough sessions to analyze it
      trackImpact(100, 'SESSION_ENGAGE.md', 'prompt');

      // Seed some existing analysis so digest is generated
      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      data.analysis.push({
        session: 50, file: 'old.md', category: 'tooling',
        impact: 'positive', cost_delta_pct: -15, success_delta: 0.05, analyzed_at: 80,
      });
      writeFileSync(join(configDir, 'r-session-impact.json'), JSON.stringify(data));

      // Run again to trigger digest with pending
      trackImpact(105, null, null);

      const digestPath = join(configDir, 'r-session-impact-digest.txt');
      const digest = readFileSync(digestPath, 'utf8');
      assert.ok(digest.includes('Pending Analysis'));
      assert.ok(digest.includes('SESSION_ENGAGE.md'));
    });
  });

  describe('skips analysis when insufficient data', () => {
    it('does not analyze changes with < 10 sessions elapsed', async () => {
      const { trackImpact } = await freshImport();
      trackImpact(100, 'SESSION_BUILD.md', 'prompt');
      trackImpact(105, null, null); // Only 5 sessions later

      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes[0].analyzed, false);
      assert.equal(data.analysis.length, 0);
    });

    it('does not analyze with fewer than 2 before/after samples', async () => {
      const { trackImpact } = await freshImport();
      const seed = {
        version: 1,
        changes: [{
          session: 100, file: 'SESSION_BUILD.md', category: 'prompt', analyzed: false,
        }],
        analysis: [],
      };
      writeFileSync(join(configDir, 'r-session-impact.json'), JSON.stringify(seed));

      // Only 1 outcome before and after
      const outcomes = [
        { session: 95, mode: 'B', cost_usd: 3.00, outcome: 'success' },
        { session: 105, mode: 'B', cost_usd: 2.00, outcome: 'success' },
      ];
      writeFileSync(join(configDir, 'session-outcomes.json'), JSON.stringify(outcomes));

      trackImpact(115, null, null);
      const data = JSON.parse(readFileSync(join(configDir, 'r-session-impact.json'), 'utf8'));
      assert.equal(data.changes[0].analyzed, false);
    });
  });
});

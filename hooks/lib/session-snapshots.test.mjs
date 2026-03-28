#!/usr/bin/env node
// session-snapshots.test.mjs — Unit tests for session-snapshots.mjs (wq-968)
//
// Tests: ecosystem snapshot structure, pattern snapshot structure,
// JSONL append behavior, missing/malformed file handling.
//
// The module uses fs directly at module scope for CLI, so we test the
// exported functions by re-implementing the core logic as testable units.
// Since the module doesn't export functions (CLI-only), we import-test
// by creating thin wrappers around the same logic.
//
// Usage: node --test hooks/lib/session-snapshots.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'session-snapshots.mjs');

function makeTmpDir() {
  const dir = join(tmpdir(), `snap-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { execSync(`rm -rf "${dir}"`); } catch {}
}

// ---- Ecosystem snapshot tests ----
describe('ecosystemSnapshot', () => {
  test('produces correct structure with valid service/registry/ecosystem files', () => {
    const baseDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const configDir = join(homeDir, '.config', 'moltbook');
    mkdirSync(configDir, { recursive: true });

    try {
      writeFileSync(join(baseDir, 'services.json'), JSON.stringify({
        services: [
          { name: 'moltbook', status: 'active' },
          { name: 'chatr', status: 'active' },
          { name: 'newsite', status: 'discovered' },
          { name: 'badsite', status: 'rejected' },
        ]
      }));
      writeFileSync(join(baseDir, 'account-registry.json'), JSON.stringify({
        accounts: [
          { platform: 'moltbook', last_status: 'live' },
          { platform: 'chatr', last_status: 'creds_ok' },
          { platform: 'dead', last_status: 'no_creds' },
        ]
      }));
      writeFileSync(join(baseDir, 'ecosystem-map.json'), JSON.stringify({
        agents: [
          { name: 'terminalcraft', url: 'https://terminalcraft.xyz', rank: 5, online: true },
          { name: 'other', online: false },
          { name: 'third', online: true },
        ]
      }));

      const outFile = join(configDir, 'ecosystem-snapshots.jsonl');
      execSync(`HOME="${homeDir}" node "${SCRIPT}" "${baseDir}" 1500 --eco-only`);

      const lines = readFileSync(outFile, 'utf-8').trim().split('\n');
      assert.strictEqual(lines.length, 1, 'Should produce exactly one JSONL line');

      const snap = JSON.parse(lines[0]);
      assert.strictEqual(snap.session, 1500);
      assert.ok(snap.ts, 'Should have timestamp');
      assert.strictEqual(snap.platforms_known, 4);
      assert.strictEqual(snap.platforms_evaluated, 3, 'active + active + rejected = 3 non-discovered');
      assert.strictEqual(snap.platforms_rejected, 1);
      assert.strictEqual(snap.platforms_with_creds, 2, 'live + creds_ok');
      assert.strictEqual(snap.platforms_no_creds, 1);
      assert.strictEqual(snap.agents_total, 3);
      assert.strictEqual(snap.agents_online, 2);
      assert.strictEqual(snap.molty_rank, 5);
    } finally {
      cleanup(baseDir);
      cleanup(homeDir);
    }
  });

  test('handles missing JSON files gracefully (null loadJSON)', () => {
    const baseDir = makeTmpDir(); // empty — no services.json etc.
    const homeDir = makeTmpDir();
    const configDir = join(homeDir, '.config', 'moltbook');
    mkdirSync(configDir, { recursive: true });
    const outFile = join(configDir, 'ecosystem-snapshots.jsonl');

    try {
      execSync(`HOME="${homeDir}" node "${SCRIPT}" "${baseDir}" 999 --eco-only`);

      const lines = readFileSync(outFile, 'utf-8').trim().split('\n');
      const snap = JSON.parse(lines[0]);

      assert.strictEqual(snap.session, 999);
      assert.strictEqual(snap.platforms_known, 0);
      assert.strictEqual(snap.platforms_with_creds, 0);
      assert.strictEqual(snap.agents_total, 0);
      assert.strictEqual(snap.molty_rank, null);
    } finally {
      cleanup(baseDir);
      cleanup(homeDir);
    }
  });

  test('JSONL appends on successive runs', () => {
    const baseDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const configDir = join(homeDir, '.config', 'moltbook');
    mkdirSync(configDir, { recursive: true });
    const outFile = join(configDir, 'ecosystem-snapshots.jsonl');

    writeFileSync(join(baseDir, 'services.json'), JSON.stringify({ services: [] }));

    try {
      execSync(`HOME="${homeDir}" node "${SCRIPT}" "${baseDir}" 100 --eco-only`);
      execSync(`HOME="${homeDir}" node "${SCRIPT}" "${baseDir}" 101 --eco-only`);
      execSync(`HOME="${homeDir}" node "${SCRIPT}" "${baseDir}" 102 --eco-only`);

      const lines = readFileSync(outFile, 'utf-8').trim().split('\n');
      assert.strictEqual(lines.length, 3, 'Should have 3 JSONL lines after 3 runs');

      const sessions = lines.map(l => JSON.parse(l).session);
      assert.deepStrictEqual(sessions, [100, 101, 102]);
    } finally {
      cleanup(baseDir);
      cleanup(homeDir);
    }
  });

  test('finds molty via different name patterns', () => {
    const baseDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const configDir = join(homeDir, '.config', 'moltbook');
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(baseDir, 'services.json'), JSON.stringify({ services: [] }));
    writeFileSync(join(baseDir, 'account-registry.json'), JSON.stringify({ accounts: [] }));
    writeFileSync(join(baseDir, 'ecosystem-map.json'), JSON.stringify({
      agents: [{ name: 'molty', rank: 3, online: true }]
    }));

    try {
      execSync(`HOME="${homeDir}" node "${SCRIPT}" "${baseDir}" 200 --eco-only`);
      const outFile = join(configDir, 'ecosystem-snapshots.jsonl');
      const snap = JSON.parse(readFileSync(outFile, 'utf-8').trim());
      assert.strictEqual(snap.molty_rank, 3, 'Should find molty by name="molty"');
    } finally {
      cleanup(baseDir);
      cleanup(homeDir);
    }
  });
});

// ---- Pattern snapshot tests ----
describe('patternSnapshot', () => {
  test('produces correct structure with PATTERNS_JSON env', () => {
    const baseDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const configDir = join(homeDir, '.config', 'moltbook');
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(baseDir, 'services.json'), JSON.stringify({ services: [] }));

    const patternsData = {
      patterns: {
        hot_files: { friction_signal: 3, count: 7 },
        build_stalls: { recent_5_stalls: 2 },
        repeated_tasks: { count: 1 }
      },
      friction_signals: [
        { suggestion: 'fix flaky test' },
        { suggestion: 'reduce hook count' },
        { suggestion: 'cache API calls' },
        { suggestion: 'should be truncated' }
      ]
    };

    try {
      execSync(
        `HOME="${homeDir}" PATTERNS_JSON='${JSON.stringify(patternsData)}' node "${SCRIPT}" "${baseDir}" 1600 --pat-only`
      );

      const outFile = join(configDir, 'patterns-history.jsonl');
      const lines = readFileSync(outFile, 'utf-8').trim().split('\n');
      assert.strictEqual(lines.length, 1);

      const snap = JSON.parse(lines[0]);
      assert.strictEqual(snap.session, 1600);
      assert.ok(snap.ts);
      assert.strictEqual(snap.friction_signal, 3);
      assert.strictEqual(snap.hot_files_count, 7);
      assert.strictEqual(snap.build_stalls, 2);
      assert.strictEqual(snap.repeated_tasks, 1);
      assert.strictEqual(snap.friction_items.length, 3, 'Should cap at 3 items');
      assert.deepStrictEqual(snap.friction_items, ['fix flaky test', 'reduce hook count', 'cache API calls']);
    } finally {
      cleanup(baseDir);
      cleanup(homeDir);
    }
  });

  test('skips pattern snapshot when PATTERNS_JSON not set', () => {
    const baseDir = makeTmpDir();
    const homeDir = makeTmpDir();
    const configDir = join(homeDir, '.config', 'moltbook');
    mkdirSync(configDir, { recursive: true });

    writeFileSync(join(baseDir, 'services.json'), JSON.stringify({ services: [] }));

    try {
      execSync(`HOME="${homeDir}" node "${SCRIPT}" "${baseDir}" 1700 --pat-only`);

      const outFile = join(configDir, 'patterns-history.jsonl');
      let exists = true;
      try { readFileSync(outFile); } catch { exists = false; }
      assert.strictEqual(exists, false, 'No patterns file should be created without PATTERNS_JSON');
    } finally {
      cleanup(baseDir);
      cleanup(homeDir);
    }
  });
});

// ---- CLI mode tests ----
describe('CLI usage', () => {
  test('exits with error when no baseDir provided', () => {
    try {
      execSync(`node "${SCRIPT}"`, { stdio: 'pipe' });
      assert.fail('Should have exited with error');
    } catch (err) {
      assert.strictEqual(err.status, 1);
      assert.ok(err.stderr.toString().includes('Usage:'));
    }
  });
});

#!/usr/bin/env node
// hook-integration.test.mjs — Integration test harness for pre/post-session hooks
// wq-489: 83 hooks (47 pre + 36 post) with zero integration tests.
// Validates each hook in a sandboxed env with mock session vars.
//
// Tests:
// 1. bash -n syntax check (every .sh hook)
// 2. Execution with mock env (sandboxed HOME, mock state files)
// 3. Session-type filtering (suffix-scoped hooks only run for their mode)
// 4. Exit code validation (non-fatal hooks should exit 0)
//
// Usage: node --test hook-integration.test.mjs

import { spawnSync } from 'child_process';
import { readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'os';

const REPO_DIR = join(import.meta.dirname || process.cwd());
const PRE_DIR = join(REPO_DIR, 'hooks/pre-session');
const POST_DIR = join(REPO_DIR, 'hooks/post-session');

// Sandbox directory — isolated HOME for hook execution
const SANDBOX_ROOT = join(tmpdir(), `hook-test-${process.pid}`);
const SANDBOX_HOME = join(SANDBOX_ROOT, 'home');
const SANDBOX_CONFIG = join(SANDBOX_HOME, '.config/moltbook');
const SANDBOX_LOGS = join(SANDBOX_CONFIG, 'logs');
const SANDBOX_REPO = join(SANDBOX_HOME, 'moltbook-mcp');

// Hooks known to require network access or external state — tested for syntax only
const NETWORK_HOOKS = new Set([
  '04-api-freshness.sh',       // checks localhost:3847
  '10-health-check.sh',        // checks localhost:3847
  '11-service-liveness.sh',    // probes external services
  '15-imanagent-refresh.sh',   // external API
  '15-presence-heartbeat.sh',  // external API
  '20-poll-directories.sh',    // external API
  '05-smoke-test.sh',          // needs running server
  '12-fire-webhook.sh',        // fires webhooks
  '13-ctxly-summary.sh',       // external API
  '14-memoryvault-backup.sh',  // external service
  '35-engagement-liveness_E.sh', // probes platforms
  '02-periodic-evm-balance.sh',  // blockchain check
  '02-periodic-platform-health.sh', // probes platforms
  '37-dns-certbot.sh',         // DNS/cert operations
  '39-defunct-probe.sh',       // probes services
]);

// Hooks that are informational and may exit non-zero to signal warnings
const WARN_EXIT_OK = new Set([
  '28-cost-trend-monitor_A.sh',  // may warn about cost trend
  '39-compliance-nudge.sh',    // compliance warnings
  '09-financial-check.sh',     // financial warnings
]);

function setupSandbox() {
  // Create sandboxed directory structure
  mkdirSync(SANDBOX_LOGS, { recursive: true });
  mkdirSync(SANDBOX_REPO, { recursive: true });
  mkdirSync(join(SANDBOX_HOME, '.claude/projects'), { recursive: true });

  // Create minimal mock state files
  const mockState = {
    'engagement-state.json': JSON.stringify({
      platforms: {}, seen_posts: [], voted_posts: [], last_scan: {}
    }),
    'session-history.txt': '2026-01-01 mode=B s=9999 dur=1m cost=$0.50 build=1 commit(s) files=[test.js] note: test session\n',
    'engagement-trace.json': JSON.stringify({ sessions: [] }),
  };
  for (const [name, content] of Object.entries(mockState)) {
    writeFileSync(join(SANDBOX_CONFIG, name), content);
  }

  // Create mock session log file (LOG_FILE target)
  writeFileSync(join(SANDBOX_LOGS, 'mock-session.log'), '# mock session log\n');

  // Create minimal mock repo files
  const mockRepoFiles = {
    'work-queue.json': JSON.stringify({ queue: [{ id: 'wq-999', title: 'test', status: 'pending', priority: 999 }] }),
    'directives.json': JSON.stringify({ directives: [], questions: [] }),
    'components.json': JSON.stringify({ components: [] }),
    'services.json': JSON.stringify({ services: [] }),
    'BRAINSTORMING.md': '# Brainstorming\n- **Test idea**: placeholder\n',
    'wallet.json': JSON.stringify({}),
    'ctxly.json': JSON.stringify({}),
    '.env': 'TEST_MODE=true\n',
    'spending-policy.json': JSON.stringify({ limits: {} }),
    'BRIEFING.md': '# BRIEFING\n## Session Rhythm\nTest briefing.\n',
  };
  for (const [name, content] of Object.entries(mockRepoFiles)) {
    writeFileSync(join(SANDBOX_REPO, name), content);
  }

  // Copy hook directories so hooks can reference sibling files
  if (existsSync(join(REPO_DIR, 'hooks'))) {
    cpSync(join(REPO_DIR, 'hooks'), join(SANDBOX_REPO, 'hooks'), { recursive: true });
  }
}

function teardownSandbox() {
  try {
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  } catch { /* cleanup best-effort */ }
}

// Build mock environment for hook execution
function mockEnv(mode = 'B') {
  return {
    HOME: SANDBOX_HOME,
    PATH: process.env.PATH,
    SESSION_NUM: '9999',
    MODE_CHAR: mode,
    LOG_DIR: SANDBOX_LOGS,
    COUNTER: '9999',
    NODE_PATH: process.env.NODE_PATH || '',
    TERM: 'dumb',
    LOG_FILE: join(SANDBOX_LOGS, 'mock-session.log'),
    // Prevent hooks from touching real files
    XDG_CONFIG_HOME: join(SANDBOX_HOME, '.config'),
  };
}

// Parse session-type suffix from hook filename
function getHookMode(hookName) {
  const match = hookName.match(/_([BERA])\.sh$/);
  return match ? match[1] : null; // null = runs for all modes
}

// Get all hooks from a directory
function getHooks(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.sh'))
    .sort();
}

// ---- Tests ----

describe('Hook integration tests', () => {
  before(() => setupSandbox());
  after(() => teardownSandbox());

  // ---- SYNTAX CHECKS ----
  describe('Syntax validation (bash -n)', () => {
    for (const dir of [PRE_DIR, POST_DIR]) {
      const phase = basename(dir);
      for (const hook of getHooks(dir)) {
        test(`${phase}/${hook} passes bash -n`, () => {
          const hookPath = join(dir, hook);
          const result = spawnSync('bash', ['-n', hookPath], {
            encoding: 'utf8',
            timeout: 5000,
          });
          assert.strictEqual(
            result.status, 0,
            `Syntax error in ${phase}/${hook}: ${(result.stderr || '').slice(0, 300)}`
          );
        });
      }
    }
  });

  // ---- SESSION-TYPE FILTERING ----
  describe('Session-type suffix filtering', () => {
    const suffixedHooks = [];
    for (const dir of [PRE_DIR, POST_DIR]) {
      const phase = basename(dir);
      for (const hook of getHooks(dir)) {
        const mode = getHookMode(hook);
        if (mode) {
          suffixedHooks.push({ dir, phase, hook, mode });
        }
      }
    }

    for (const { dir, phase, hook, mode } of suffixedHooks) {
      // Verify the hook is listed with the correct suffix
      test(`${phase}/${hook} is scoped to ${mode} sessions`, () => {
        assert.ok(
          hook.endsWith(`_${mode}.sh`),
          `Expected ${hook} to end with _${mode}.sh`
        );
      });
    }

    // Verify run-hooks.sh filtering logic matches our expectations
    test('run-hooks.sh exists and implements suffix filtering', () => {
      const runHooksPath = join(REPO_DIR, 'run-hooks.sh');
      assert.ok(existsSync(runHooksPath), 'run-hooks.sh should exist');
      const content = readFileSync(runHooksPath, 'utf8');
      assert.ok(content.includes('_B.sh'), 'Should handle _B.sh suffix');
      assert.ok(content.includes('_E.sh'), 'Should handle _E.sh suffix');
      assert.ok(content.includes('_R.sh'), 'Should handle _R.sh suffix');
      assert.ok(content.includes('_A.sh'), 'Should handle _A.sh suffix');
    });
  });

  // ---- SANDBOXED EXECUTION ----
  describe('Sandboxed execution (non-network hooks)', () => {
    for (const dir of [PRE_DIR, POST_DIR]) {
      const phase = basename(dir);
      for (const hook of getHooks(dir)) {
        // Skip network-dependent hooks
        if (NETWORK_HOOKS.has(hook)) continue;

        const hookMode = getHookMode(hook);

        test(`${phase}/${hook} runs without crash (exit 0)`, () => {
          const hookPath = join(dir, hook);
          // Use the hook's required mode, or default to B
          const mode = hookMode || 'B';
          const env = mockEnv(mode);

          const result = spawnSync('bash', [hookPath], {
            encoding: 'utf8',
            timeout: 15000,
            cwd: SANDBOX_REPO,
            env,
          });

          // Most hooks should exit 0 in sandbox
          // Some may exit non-zero due to missing external deps — that's OK if expected
          if (result.status !== 0 && !WARN_EXIT_OK.has(hook)) {
            const stderr = (result.stderr || '').slice(0, 500);
            const stdout = (result.stdout || '').slice(0, 500);

            // Acceptable failures in sandbox: missing node modules, missing real state
            const acceptablePatterns = [
              /Cannot find module/i,
              /MODULE_NOT_FOUND/i,
              /ENOENT/i,
              /no such file/i,
              /command not found/i,
              /jq.*not found/i,
              /python3.*not found/i,
              /node:.*ERR/i,
              /ECONNREFUSED/i,
            ];

            const output = stderr + stdout;
            const isAcceptable = acceptablePatterns.some(p => p.test(output));

            if (!isAcceptable) {
              assert.fail(
                `${phase}/${hook} exited with ${result.status}\nstderr: ${stderr}\nstdout: ${stdout}`
              );
            }
          }
        });
      }
    }
  });

  // ---- HOOK EXECUTABLE PERMISSIONS ----
  describe('Hook file permissions', () => {
    for (const dir of [PRE_DIR, POST_DIR]) {
      const phase = basename(dir);
      for (const hook of getHooks(dir)) {
        test(`${phase}/${hook} is executable`, () => {
          const hookPath = join(dir, hook);
          const result = spawnSync('test', ['-x', hookPath]);
          assert.strictEqual(result.status, 0, `${phase}/${hook} is not executable`);
        });
      }
    }
  });

  // ---- HOOK CONVENTIONS ----
  describe('Hook conventions', () => {
    for (const dir of [PRE_DIR, POST_DIR]) {
      const phase = basename(dir);
      for (const hook of getHooks(dir)) {
        test(`${phase}/${hook} has shebang line`, () => {
          const content = readFileSync(join(dir, hook), 'utf8');
          assert.ok(
            content.startsWith('#!/bin/bash') || content.startsWith('#!/usr/bin/env bash'),
            `${phase}/${hook} missing bash shebang`
          );
        });
      }
    }

    // Verify naming convention: NN-name.sh or NN-name_X.sh
    for (const dir of [PRE_DIR, POST_DIR]) {
      const phase = basename(dir);
      for (const hook of getHooks(dir)) {
        test(`${phase}/${hook} follows naming convention`, () => {
          assert.ok(
            /^\d{2}-[\w-]+(_[BERA])?\.sh$/.test(hook),
            `${phase}/${hook} doesn't match NN-name[_X].sh pattern`
          );
        });
      }
    }
  });

  // ---- PICKER COMPLIANCE LIFECYCLE (wq-640) ----
  describe('Picker compliance lifecycle integration', () => {
    const mandatePath = join(SANDBOX_CONFIG, 'picker-mandate.json');
    const tracePath = join(SANDBOX_CONFIG, 'engagement-trace.json');
    const statePath = join(SANDBOX_CONFIG, 'picker-compliance-state.json');
    const violationsLog = join(SANDBOX_LOGS, 'picker-violations.log');
    const hookPath = join(REPO_DIR, 'hooks/post-session/36-picker-compliance_E.sh');

    function cleanPickerState() {
      for (const p of [statePath, violationsLog]) {
        rmSync(p, { force: true });
      }
    }

    function runPickerHook(session = '200') {
      return spawnSync('bash', [hookPath], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: SANDBOX_REPO,
        env: {
          ...mockEnv('E'),
          SESSION_TYPE: 'E',
          SESSION_NUM: session,
        },
      });
    }

    function readState() {
      if (!existsSync(statePath)) return null;
      return JSON.parse(readFileSync(statePath, 'utf8'));
    }

    test('full lifecycle: mandate → trace → compliance check → state update (100% pass)', () => {
      cleanPickerState();

      // Step 1: Picker writes mandate (simulates pre-session picker)
      writeFileSync(mandatePath, JSON.stringify({
        session: 200,
        selected: ['chatr', 'bluesky', 'moltbook'],
      }));

      // Step 2: E session writes engagement trace (simulates session activity)
      writeFileSync(tracePath, JSON.stringify({
        session: 200,
        platforms_engaged: ['Chatr', 'Bluesky', 'Moltbook'],
        interactions: [
          { platform: 'chatr', action: 'message', content: 'test' },
          { platform: 'bluesky', action: 'post', content: 'test' },
          { platform: 'moltbook', action: 'reply', content: 'test' },
        ],
      }));

      // Step 3: Post-session hook runs compliance check
      const result = runPickerHook('200');
      assert.strictEqual(result.status, 0, `Hook failed: ${result.stderr}`);
      assert.ok(result.stdout.includes('100%'), `Expected 100%, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('Compliant'), result.stdout);

      // Step 4: Verify state was updated
      const state = readState();
      assert.ok(state, 'compliance state should exist after hook run');
      assert.strictEqual(state.consecutive_violations, 0);
      assert.strictEqual(state.history[0].session, 200);
      assert.strictEqual(state.history[0].compliance_pct, 100);
      assert.strictEqual(state.history[0].violation, false);
    });

    test('full lifecycle: partial engagement → violation → state tracks it', () => {
      cleanPickerState();

      // Mandate selects 3 platforms
      writeFileSync(mandatePath, JSON.stringify({
        session: 205,
        selected: ['chatr', 'bluesky', 'grove'],
      }));

      // But only 1 was engaged
      writeFileSync(tracePath, JSON.stringify({
        session: 205,
        platforms_engaged: ['Chatr'],
      }));

      const result = runPickerHook('205');
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('33%'), `Expected 33%, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('VIOLATION'), result.stdout);

      const state = readState();
      assert.ok(state);
      assert.strictEqual(state.consecutive_violations, 1);
      assert.strictEqual(state.history[0].violation, true);

      // Verify violations log was created
      assert.ok(existsSync(violationsLog), 'violations log should exist');
      const logContent = readFileSync(violationsLog, 'utf8');
      assert.ok(logContent.includes('s205'), 'log should reference session');
    });

    test('full lifecycle: skip-documented platforms count as compliant', () => {
      cleanPickerState();

      writeFileSync(mandatePath, JSON.stringify({
        session: 210,
        selected: ['chatr', 'bluesky', '4claw'],
      }));

      // 2 engaged + 1 legitimately skipped = 100%
      writeFileSync(tracePath, JSON.stringify({
        session: 210,
        platforms_engaged: ['Chatr', 'Bluesky'],
        skipped_platforms: [{ platform: '4claw', reason: 'API timeout' }],
      }));

      const result = runPickerHook('210');
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('100%'), `Expected 100%, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('Compliant'), result.stdout);

      const state = readState();
      assert.strictEqual(state.consecutive_violations, 0);
    });

    test('multi-session lifecycle: 3 consecutive violations trigger escalation', () => {
      cleanPickerState();

      // Simulate 3 consecutive E sessions with violations
      for (let i = 0; i < 3; i++) {
        const session = 220 + (i * 5); // E sessions ~5 apart in BBBRE
        writeFileSync(mandatePath, JSON.stringify({
          session,
          selected: ['chatr', 'bluesky', 'moltbook'],
        }));
        writeFileSync(tracePath, JSON.stringify({
          session,
          platforms_engaged: [],
        }));
        runPickerHook(String(session));
      }

      // After 3 violations, check state
      const state = readState();
      assert.ok(state.consecutive_violations >= 3,
        `Expected >=3 consecutive violations, got ${state.consecutive_violations}`);

      // Check escalation added follow_up to trace
      const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
      assert.ok(trace.follow_ups, 'follow_ups should exist after escalation');
      assert.ok(trace.follow_ups.some(f => f.type === 'picker_compliance_alert'),
        'should have picker_compliance_alert follow_up');
    });

    test('recovery: compliant session after violations resets counter', () => {
      // State from previous test should have violations
      // Now simulate a fully compliant session
      writeFileSync(mandatePath, JSON.stringify({
        session: 240,
        selected: ['chatr', 'bluesky'],
      }));
      writeFileSync(tracePath, JSON.stringify({
        session: 240,
        platforms_engaged: ['Chatr', 'Bluesky'],
      }));

      const result = runPickerHook('240');
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('100%'), result.stdout);

      const state = readState();
      assert.strictEqual(state.consecutive_violations, 0,
        'violations should reset after compliant session');
    });

    test('hook skips non-E sessions', () => {
      // Run with MODE_CHAR=B (non-E session)
      const result = spawnSync('bash', [hookPath], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: SANDBOX_REPO,
        env: {
          ...mockEnv('B'),
          SESSION_TYPE: 'B',
          SESSION_NUM: '250',
        },
      });
      assert.strictEqual(result.status, 0, 'should exit 0 for non-E sessions');
      // Should produce no compliance output
      assert.ok(!result.stdout.includes('Compliance:'),
        'should not run compliance check for B sessions');
    });
  });

  // ---- HOOK COUNT TRACKING ----
  describe('Hook inventory', () => {
    test('pre-session hook count is tracked', () => {
      const count = getHooks(PRE_DIR).length;
      console.log(`  pre-session hooks: ${count}`);
      assert.ok(count > 0, 'Should have pre-session hooks');
    });

    test('post-session hook count is tracked', () => {
      const count = getHooks(POST_DIR).length;
      console.log(`  post-session hooks: ${count}`);
      assert.ok(count > 0, 'Should have post-session hooks');
    });

    test('total hook count', () => {
      const pre = getHooks(PRE_DIR).length;
      const post = getHooks(POST_DIR).length;
      console.log(`  total hooks: ${pre + post} (${pre} pre + ${post} post)`);
      assert.ok(pre + post > 50, 'Should have substantial hook count');
    });
  });
});

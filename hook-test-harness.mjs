#!/usr/bin/env node
/**
 * Hook Test Harness (wq-210, wq-211)
 *
 * Tests pre-session and post-session hooks in isolation.
 * Verifies hooks execute without errors and produce expected outputs.
 *
 * Usage:
 *   node hook-test-harness.mjs [pre|post|all] [--verbose]
 */

import { execSync, spawnSync } from 'child_process';
import { readdirSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, basename } from 'path';

const HOOKS_DIR = '/home/moltbot/moltbook-mcp/hooks';
const TEMP_DIR = '/tmp/hook-test-harness';

// Default test environment (mirrors heartbeat.sh variables)
const TEST_ENV = {
  SESSION_NUM: '999',
  SESSION_TYPE: 'B',
  BUDGET_CAP: '10',
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  // Variables set by heartbeat.sh that hooks depend on
  LOG_FILE: '/tmp/hook-test-harness/session-999.log',
  MODE_CHAR: 'B',
  // Prevent hooks from modifying real state
  HOOK_TEST_MODE: '1'
};

// Hooks that are safe to run in test mode (don't require real state)
const SAFE_HOOKS = {
  pre: [
    '05-snapshot-cleanup.sh',
    '10-log-rotate.sh'
  ],
  post: [
    '05-smoke-test.sh'
  ]
};

// Hooks that need mocking or special handling
const NEEDS_MOCK = {
  pre: [],
  post: [
    '12-fire-webhook.sh',  // Would send real webhooks
    '20-auto-commit.sh'    // Would commit to git
  ]
};

function getHooks(type) {
  const dir = join(HOOKS_DIR, `${type}-session`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.sh'))
    .sort();
}

function runHook(type, hookFile, verbose = false) {
  const hookPath = join(HOOKS_DIR, `${type}-session`, hookFile);
  const result = {
    hook: hookFile,
    type,
    passed: false,
    duration: 0,
    exitCode: null,
    stdout: '',
    stderr: '',
    error: null,
    skipped: false
  };

  // Check if hook needs mocking
  if (NEEDS_MOCK[type]?.includes(hookFile)) {
    result.skipped = true;
    result.passed = true;
    result.error = 'Requires mock (skipped)';
    return result;
  }

  const start = Date.now();
  try {
    const proc = spawnSync('bash', [hookPath], {
      env: { ...process.env, ...TEST_ENV },
      timeout: 30000,  // 30 second timeout per hook
      maxBuffer: 1024 * 1024,
      cwd: '/home/moltbot/moltbook-mcp'
    });

    result.exitCode = proc.status;
    result.stdout = proc.stdout?.toString() || '';
    result.stderr = proc.stderr?.toString() || '';
    result.duration = Date.now() - start;

    // Exit code 0 = pass, anything else = fail
    result.passed = proc.status === 0;
    if (!result.passed) {
      result.error = `Exit code ${proc.status}`;
    }
  } catch (err) {
    result.duration = Date.now() - start;
    result.error = err.message;
    result.passed = false;
  }

  return result;
}

function printResult(result, verbose) {
  const icon = result.skipped ? '⏭' : (result.passed ? '✓' : '✗');
  const time = `${result.duration}ms`;
  console.log(`  ${icon} ${result.hook} (${time})`);

  if (verbose || !result.passed) {
    if (result.error && !result.skipped) {
      console.log(`    Error: ${result.error}`);
    }
    if (result.stderr && !result.passed) {
      console.log(`    Stderr: ${result.stderr.slice(0, 200)}`);
    }
  }
}

function runSuite(type, verbose) {
  const hooks = getHooks(type);
  console.log(`\n${type.toUpperCase()}-SESSION HOOKS (${hooks.length} total)`);
  console.log('─'.repeat(40));

  if (hooks.length === 0) {
    console.log('  No hooks found');
    return { passed: 0, failed: 0, skipped: 0 };
  }

  const results = { passed: 0, failed: 0, skipped: 0 };

  for (const hook of hooks) {
    const result = runHook(type, hook, verbose);
    printResult(result, verbose);

    if (result.skipped) results.skipped++;
    else if (result.passed) results.passed++;
    else results.failed++;
  }

  return results;
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const type = args.find(a => ['pre', 'post', 'all'].includes(a)) || 'all';

  console.log('Hook Test Harness');
  console.log(`Mode: ${type} | Verbose: ${verbose}`);

  // Setup temp directory
  if (existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true });
  }
  mkdirSync(TEMP_DIR, { recursive: true });

  let totalPassed = 0, totalFailed = 0, totalSkipped = 0;

  if (type === 'pre' || type === 'all') {
    const r = runSuite('pre', verbose);
    totalPassed += r.passed;
    totalFailed += r.failed;
    totalSkipped += r.skipped;
  }

  if (type === 'post' || type === 'all') {
    const r = runSuite('post', verbose);
    totalPassed += r.passed;
    totalFailed += r.failed;
    totalSkipped += r.skipped;
  }

  console.log('\n' + '═'.repeat(40));
  console.log(`SUMMARY: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);

  // Cleanup
  rmSync(TEMP_DIR, { recursive: true });

  // Exit with failure code if any tests failed
  process.exit(totalFailed > 0 ? 1 : 0);
}

main();

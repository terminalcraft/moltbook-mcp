/**
 * Test harness for hooks/mode-transform/*.sh (wq-207)
 *
 * Tests mode transformation logic:
 * 1. E session with healthy platforms → no transform
 * 2. E session with degraded platforms → E→B
 * 3. B session with queue items → no transform
 * 4. B session empty queue no fallback → B→R
 * 5. B session empty queue with fallback → stays B with log
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const MCP_DIR = process.cwd();
const HOOKS_DIR = join(MCP_DIR, 'hooks/mode-transform');

/**
 * Run a single hook with specified environment
 * @param {string} hookPath - Path to hook script
 * @param {Record<string, string>} env - Environment variables
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function runHook(hookPath, env) {
  return new Promise((resolve) => {
    const proc = spawn('bash', [hookPath], {
      env: { ...process.env, ...env },
      cwd: MCP_DIR
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('close', code => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
  });
}

describe('mode-transform hooks', () => {
  // 10-engage-health.sh tests
  describe('10-engage-health.sh', () => {
    const hookPath = join(HOOKS_DIR, '10-engage-health.sh');

    it('does nothing for non-E sessions', async () => {
      const result = await runHook(hookPath, { MODE_CHAR: 'B' });
      assert.strictEqual(result.stdout, '', 'Should not output anything for B session');
    });

    it('does nothing for non-E sessions (R)', async () => {
      const result = await runHook(hookPath, { MODE_CHAR: 'R' });
      assert.strictEqual(result.stdout, '', 'Should not output anything for R session');
    });

    // Note: Testing actual E→B transformation requires mocking engagement-health.cjs
    // which would return ENGAGE_DEGRADED. We test the logic structure instead.
    it('runs for E sessions', async () => {
      // This test verifies the hook attempts to run engagement-health check
      // In test environment, health check may pass or fail depending on server state
      const result = await runHook(hookPath, { MODE_CHAR: 'E' });
      // Either no output (healthy) or "B engagement platforms degraded" (degraded)
      assert.ok(
        result.stdout === '' || result.stdout.startsWith('B '),
        `Output should be empty or start with 'B ', got: ${result.stdout}`
      );
    });
  });

  // 20-queue-starvation.sh tests
  describe('20-queue-starvation.sh', () => {
    const hookPath = join(HOOKS_DIR, '20-queue-starvation.sh');
    let testLogDir;

    beforeEach(async () => {
      testLogDir = join(tmpdir(), `mode-transform-test-${Date.now()}`);
      await mkdir(testLogDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testLogDir, { recursive: true, force: true });
    });

    it('does nothing for non-B sessions', async () => {
      const result = await runHook(hookPath, { MODE_CHAR: 'E', CTX_PENDING_COUNT: '0' });
      assert.strictEqual(result.stdout, '', 'Should not output anything for E session');
    });

    it('does nothing when queue has items', async () => {
      const result = await runHook(hookPath, {
        MODE_CHAR: 'B',
        CTX_PENDING_COUNT: '3',
        CTX_WQ_FALLBACK: 'false'
      });
      assert.strictEqual(result.stdout, '', 'Should not transform when queue has items');
    });

    it('transforms B→R when queue empty and no fallback', async () => {
      const result = await runHook(hookPath, {
        MODE_CHAR: 'B',
        CTX_PENDING_COUNT: '0',
        CTX_WQ_FALLBACK: 'false'
      });
      assert.ok(result.stdout.startsWith('R '), `Should transform to R, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('queue empty'), 'Should mention queue empty');
    });

    it('stays B with log when queue empty but fallback available', async () => {
      const result = await runHook(hookPath, {
        MODE_CHAR: 'B',
        CTX_PENDING_COUNT: '0',
        CTX_WQ_FALLBACK: 'true',
        LOG_DIR: testLogDir
      });
      assert.strictEqual(result.stdout, '', 'Should not transform when fallback available');

      // Check log was written
      const logContent = await readFile(join(testLogDir, 'selfmod.log'), 'utf8');
      assert.ok(logContent.includes('brainstorming fallback'), `Log should mention fallback, got: ${logContent}`);
    });
  });

  // 30-urgency-escalation.sh tests
  describe('30-urgency-escalation.sh', () => {
    const hookPath = join(HOOKS_DIR, '30-urgency-escalation.sh');

    it('does nothing for non-B sessions', async () => {
      const result = await runHook(hookPath, {
        MODE_CHAR: 'R',
        CTX_PENDING_COUNT: '10',
        CTX_B_STALL_COUNT: '5'
      });
      assert.strictEqual(result.stdout, '', 'Should not output anything for R session');
    });

    it('does nothing when queue below threshold', async () => {
      const result = await runHook(hookPath, {
        MODE_CHAR: 'B',
        CTX_PENDING_COUNT: '3',
        CTX_B_STALL_COUNT: '5'
      });
      assert.strictEqual(result.stdout, '', 'Should not transform when queue < 6');
    });

    it('does nothing when stall count below threshold', async () => {
      const result = await runHook(hookPath, {
        MODE_CHAR: 'B',
        CTX_PENDING_COUNT: '10',
        CTX_B_STALL_COUNT: '2'
      });
      assert.strictEqual(result.stdout, '', 'Should not transform when stall count < 3');
    });

    it('transforms B→R when queue backlog + stalled sessions', async () => {
      const result = await runHook(hookPath, {
        MODE_CHAR: 'B',
        CTX_PENDING_COUNT: '8',
        CTX_B_STALL_COUNT: '4'
      });
      assert.ok(result.stdout.startsWith('R '), `Should transform to R, got: ${result.stdout}`);
      assert.ok(result.stdout.includes('backlog'), 'Should mention backlog');
    });
  });

  // 40-pattern-friction.sh tests
  describe('40-pattern-friction.sh', () => {
    const hookPath = join(HOOKS_DIR, '40-pattern-friction.sh');

    it('does nothing for non-B sessions', async () => {
      const result = await runHook(hookPath, { MODE_CHAR: 'E' });
      assert.strictEqual(result.stdout, '', 'Should not output anything for E session');
    });

    // Note: This hook depends on /status/patterns endpoint
    // In test environment, we verify it runs without error
    it('runs for B sessions without crashing', async () => {
      const result = await runHook(hookPath, { MODE_CHAR: 'B' });
      // Either no output (no friction or API unavailable) or "R high friction"
      assert.ok(
        result.stdout === '' || result.stdout.startsWith('R '),
        `Output should be empty or start with 'R ', got: ${result.stdout}`
      );
    });
  });

  // Integration: Full transform chain
  describe('integration: transform chain', () => {
    it('processes hooks in order (lowest number first)', async () => {
      // This test verifies the expected hook execution order
      const { readdirSync } = await import('fs');
      const hooks = readdirSync(HOOKS_DIR)
        .filter(f => f.endsWith('.sh'))
        .sort();

      assert.deepStrictEqual(hooks, [
        '10-engage-health.sh',
        '20-queue-starvation.sh',
        '30-urgency-escalation.sh',
        '40-pattern-friction.sh'
      ], 'Hooks should be numbered in expected order');
    });
  });
});

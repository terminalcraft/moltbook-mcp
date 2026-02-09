#!/usr/bin/env node
// pre-commit-hook.test.mjs — Test credential leak detection in pre-commit hook
// wq-258: Verify pre-commit hook blocks credential leaks per d045
//
// Tests run the hook against synthetic staged files to verify:
// 1. Credential patterns are detected and blocked
// 2. Clean files pass
// 3. Test files are exempt from credential checks

import { execSync, spawnSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';

const REPO_DIR = process.cwd();
const HOOK_PATH = join(REPO_DIR, '.git/hooks/pre-commit');
const TEST_DIR = join(REPO_DIR, '.test-fixtures');

// Helper to run the pre-commit hook directly
function runHook() {
  const result = spawnSync('bash', [HOOK_PATH], {
    cwd: REPO_DIR,
    encoding: 'utf8',
    timeout: 10000
  });
  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

// Helper to stage a test file
function stageFile(filename, content) {
  const filepath = join(REPO_DIR, filename);
  writeFileSync(filepath, content);
  execSync(`git add "${filename}"`, { cwd: REPO_DIR });
  return filepath;
}

// Helper to unstage and remove a test file
function cleanupFile(filename) {
  try {
    execSync(`git reset HEAD "${filename}" 2>/dev/null || true`, { cwd: REPO_DIR });
    const filepath = join(REPO_DIR, filename);
    if (existsSync(filepath)) unlinkSync(filepath);
  } catch { /* ignore cleanup errors */ }
}

describe('pre-commit credential detection', () => {
  // Test 1: Detect API key patterns
  test('blocks files with api_key pattern', async () => {
    const filename = 'test-cred-apikey.mjs';
    try {
      stageFile(filename, `
        const config = {
          api_key: "sk_test_abcdefghijklmnopqrstuvwxyz123456"
        };
      `);
      const result = runHook();
      assert.strictEqual(result.exitCode, 1, 'Should exit with error code 1');
      assert.ok(result.stdout.includes('CREDENTIAL LEAK WARNING'), 'Should warn about credential leak');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 2: Detect secret_key patterns
  test('blocks files with secret_key pattern', async () => {
    const filename = 'test-cred-secret.mjs';
    try {
      stageFile(filename, `
        export const SECRET_KEY = "very_secret_key_that_should_not_be_committed_ever";
      `);
      const result = runHook();
      assert.strictEqual(result.exitCode, 1, 'Should exit with error code 1');
      assert.ok(result.stdout.includes('CREDENTIAL LEAK WARNING'), 'Should warn about credential leak');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 3: Detect Bearer token patterns
  test('blocks files with Bearer token pattern', async () => {
    const filename = 'test-cred-bearer.mjs';
    try {
      stageFile(filename, `
        const headers = {
          Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"
        };
      `);
      const result = runHook();
      assert.strictEqual(result.exitCode, 1, 'Should exit with error code 1');
      assert.ok(result.stdout.includes('CREDENTIAL LEAK WARNING'), 'Should warn about credential leak');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 4: Detect "key": "value" patterns (JSON API keys)
  test('blocks files with JSON key pattern', async () => {
    const filename = 'test-cred-jsonkey.json';
    try {
      stageFile(filename, `{
        "key": "abcdefghijklmnopqrstuvwxyz1234567890"
      }`);
      const result = runHook();
      assert.strictEqual(result.exitCode, 1, 'Should exit with error code 1');
      assert.ok(result.stdout.includes('CREDENTIAL LEAK WARNING'), 'Should warn about credential leak');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 5: Clean files pass
  test('allows clean files without credentials', async () => {
    const filename = 'test-clean.mjs';
    try {
      stageFile(filename, `
        // This file has no credentials
        export const greeting = "Hello, world!";
        export const version = "1.0.0";
      `);
      const result = runHook();
      assert.strictEqual(result.exitCode, 0, 'Should exit with code 0 for clean files');
      assert.ok(!result.stdout.includes('CREDENTIAL LEAK WARNING'), 'Should not warn for clean files');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 6: Test files are exempt
  test('exempts *.test.mjs files from credential checks', async () => {
    // Note: This test file itself demonstrates the exemption
    // The hook allows credential patterns in test files
    const filename = 'fake-creds.test.mjs';
    try {
      stageFile(filename, `
        // Test fixture with fake credentials for testing
        const fakeApiKey = "api_key_fake_test_value_1234567890";
        test('should handle api keys', () => {});
      `);
      const result = runHook();
      // Test files should be exempt, so even with credential patterns, it should pass
      assert.strictEqual(result.exitCode, 0, 'Should exit with code 0 for test files');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 7: Shell syntax errors are caught
  test('blocks shell scripts with syntax errors', async () => {
    const filename = 'test-bad-syntax.sh';
    try {
      stageFile(filename, `#!/bin/bash
        if [ true; then
          echo "missing fi"
      `);
      const result = runHook();
      assert.strictEqual(result.exitCode, 1, 'Should exit with error code 1');
      assert.ok(result.stdout.includes('SYNTAX ERROR'), 'Should report syntax error');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 8: Valid shell scripts pass
  test('allows valid shell scripts', async () => {
    const filename = 'test-good-syntax.sh';
    try {
      stageFile(filename, `#!/bin/bash
        if [ true ]; then
          echo "valid script"
        fi
      `);
      const result = runHook();
      assert.strictEqual(result.exitCode, 0, 'Should exit with code 0 for valid scripts');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 9: Detect password patterns (wq-266 edge case)
  test('blocks files with password pattern', async () => {
    const filename = 'test-cred-password.mjs';
    try {
      stageFile(filename, `
        const config = {
          password: "supersecretpassword123"
        };
      `);
      const result = runHook();
      assert.strictEqual(result.exitCode, 1, 'Should exit with error code 1');
      assert.ok(result.stdout.includes('CREDENTIAL LEAK WARNING'), 'Should warn about password');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 10: Short tokens don't trigger (avoid false positives)
  test('allows files with short key values (no false positives)', async () => {
    const filename = 'test-short-key.json';
    try {
      stageFile(filename, `{
        "key": "short"
      }`);
      const result = runHook();
      assert.strictEqual(result.exitCode, 0, 'Should allow short key values');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 11: Binary files are skipped (wq-266 edge case)
  test('skips binary files', async () => {
    const filename = 'test-binary.png';
    try {
      // Write minimal PNG header with an api_key string embedded
      const pngHeader = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
      ]);
      const fakeContent = Buffer.concat([pngHeader, Buffer.from('api_key=secret12345678901234567890')]);
      writeFileSync(join(REPO_DIR, filename), fakeContent);
      execSync(`git add "${filename}"`, { cwd: REPO_DIR });
      const result = runHook();
      // Should pass because .png files are skipped
      assert.strictEqual(result.exitCode, 0, 'Should skip binary files');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 12: Credential files with *-creds.json pattern are exempt
  test('exempts *-creds.json files from credential checks', async () => {
    const filename = 'test-platform-creds.json';
    try {
      stageFile(filename, `{
        "api_key": "fake_test_key_abcdefghijklmnopqrstuvwxyz"
      }`);
      const result = runHook();
      // *-creds.json should be exempt
      assert.strictEqual(result.exitCode, 0, 'Should exempt *-creds.json files');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 13: Multiple credential patterns in one file
  test('detects multiple credential patterns', async () => {
    const filename = 'test-multi-creds.mjs';
    try {
      stageFile(filename, `
        const config = {
          api_key: "sk_test_abcdefghijklmnopqrstuvwxyz123456",
          secret_key: "secret_abcdefghijklmnopqrstuvwxyz",
          password: "mysuperpassword123"
        };
      `);
      const result = runHook();
      assert.strictEqual(result.exitCode, 1, 'Should detect any credential pattern');
      assert.ok(result.stdout.includes('CREDENTIAL LEAK WARNING'), 'Should warn about credentials');
    } finally {
      cleanupFile(filename);
    }
  });
});

describe('pre-commit critical file gate (wq-486)', () => {
  // Test 14: heartbeat.sh syntax error blocks ANY commit
  test('blocks commit when heartbeat.sh has syntax error', async () => {
    const heartbeatPath = join(REPO_DIR, 'heartbeat.sh');
    const { readFileSync } = await import('fs');
    const original = readFileSync(heartbeatPath, 'utf8');
    const filename = 'test-clean-unrelated.mjs';
    try {
      // Introduce syntax error in heartbeat.sh (don't stage it)
      writeFileSync(heartbeatPath, original + '\nif [ true; then\n');
      // Stage an unrelated clean file
      stageFile(filename, 'export const x = 1;\n');
      const result = runHook();
      assert.strictEqual(result.exitCode, 1, 'Should block even unrelated commits');
      assert.ok(result.stdout.includes('CRITICAL SYNTAX ERROR'), 'Should report critical syntax error');
    } finally {
      // Restore heartbeat.sh
      writeFileSync(heartbeatPath, original);
      cleanupFile(filename);
    }
  });

  // Test 15: valid heartbeat.sh allows commits
  test('allows commit when heartbeat.sh is valid', async () => {
    const filename = 'test-clean-for-gate.mjs';
    try {
      stageFile(filename, 'export const y = 2;\n');
      const result = runHook();
      // Should pass — heartbeat.sh is valid
      assert.strictEqual(result.exitCode, 0, 'Should allow commit with valid heartbeat.sh');
      assert.ok(!result.stdout.includes('CRITICAL SYNTAX ERROR'), 'Should not report critical error');
    } finally {
      cleanupFile(filename);
    }
  });
});

describe('pre-commit hook .sh syntax gate (wq-493)', () => {
  // Test 16: broken hook .sh file blocks ANY commit
  test('blocks commit when a hook .sh file has syntax error', async () => {
    const hookDir = join(REPO_DIR, 'hooks/pre-session');
    const brokenHook = join(hookDir, '99-test-broken.sh');
    const filename = 'test-clean-for-hook-gate.mjs';
    try {
      writeFileSync(brokenHook, '#!/bin/bash\nif [ true; then\necho "broken"\n');
      stageFile(filename, 'export const z = 3;\n');
      const result = runHook();
      assert.strictEqual(result.exitCode, 1, 'Should block commit when hook has syntax error');
      assert.ok(result.stdout.includes('HOOK SYNTAX ERROR'), 'Should report hook syntax error');
      assert.ok(result.stdout.includes('99-test-broken.sh'), 'Should name the broken hook');
    } finally {
      if (existsSync(brokenHook)) unlinkSync(brokenHook);
      cleanupFile(filename);
    }
  });

  // Test 17: valid hooks allow commits
  test('allows commit when all hook .sh files are valid', async () => {
    const filename = 'test-clean-for-hook-pass.mjs';
    try {
      stageFile(filename, 'export const w = 4;\n');
      const result = runHook();
      assert.strictEqual(result.exitCode, 0, 'Should allow commit when all hooks are valid');
      assert.ok(!result.stdout.includes('HOOK SYNTAX ERROR'), 'Should not report hook syntax error');
    } finally {
      cleanupFile(filename);
    }
  });

  // Test 18: broken post-session hook also blocked
  test('blocks commit when post-session hook has syntax error', async () => {
    const hookDir = join(REPO_DIR, 'hooks/post-session');
    const brokenHook = join(hookDir, '99-test-broken-post.sh');
    const filename = 'test-clean-for-post-hook.mjs';
    try {
      writeFileSync(brokenHook, '#!/bin/bash\nfor x in; do\necho "$x"\n');
      stageFile(filename, 'export const v = 5;\n');
      const result = runHook();
      assert.strictEqual(result.exitCode, 1, 'Should block commit for post-session hook error');
      assert.ok(result.stdout.includes('HOOK SYNTAX ERROR'), 'Should report hook syntax error');
    } finally {
      if (existsSync(brokenHook)) unlinkSync(brokenHook);
      cleanupFile(filename);
    }
  });
});

// Run if executed directly
if (process.argv[1].endsWith('pre-commit-hook.test.mjs')) {
  console.log('Run with: node --test pre-commit-hook.test.mjs');
}

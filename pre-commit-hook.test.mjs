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
});

// Run if executed directly
if (process.argv[1].endsWith('pre-commit-hook.test.mjs')) {
  console.log('Run with: node --test pre-commit-hook.test.mjs');
}

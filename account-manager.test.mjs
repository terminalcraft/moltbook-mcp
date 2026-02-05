#!/usr/bin/env node
// account-manager.test.mjs — Tests for account-manager utilities (wq-132)
// Run with: node --test account-manager.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, 'account-registry.json');
const BACKUP_PATH = join(__dirname, 'account-registry.json.test-backup');

describe('account-manager.mjs', () => {
  let originalRegistry;

  before(() => {
    // Backup original registry
    if (existsSync(REGISTRY_PATH)) {
      copyFileSync(REGISTRY_PATH, BACKUP_PATH);
      originalRegistry = readFileSync(REGISTRY_PATH, 'utf8');
    }
  });

  after(() => {
    // Restore original registry
    if (originalRegistry) {
      writeFileSync(REGISTRY_PATH, originalRegistry);
    } else if (existsSync(BACKUP_PATH)) {
      copyFileSync(BACKUP_PATH, REGISTRY_PATH);
    }
    if (existsSync(BACKUP_PATH)) {
      unlinkSync(BACKUP_PATH);
    }
  });

  describe('CLI status command', () => {
    test('shows all accounts without errors', () => {
      const output = execSync('node account-manager.mjs status 2>&1', { cwd: __dirname, encoding: 'utf8' });
      assert.match(output, /Platform Account Registry/);
      // d047: tier markers removed — platform selection is ROI-weighted
    });

    test('displays platform name and status', () => {
      const output = execSync('node account-manager.mjs status 2>&1', { cwd: __dirname, encoding: 'utf8' });
      // Check for expected format: icon platform  status  tested:
      const lines = output.split('\n').filter(l => l.includes('tested:'));
      assert.ok(lines.length > 0, 'Should have at least one account listed');
    });
  });

  describe('registry loading', () => {
    test('registry JSON is valid', () => {
      const content = readFileSync(REGISTRY_PATH, 'utf8');
      const parsed = JSON.parse(content);
      assert.ok(Array.isArray(parsed.accounts), 'Registry should have accounts array');
    });

    test('accounts have required fields', () => {
      const reg = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
      for (const account of reg.accounts) {
        assert.ok(account.id, `Account should have id: ${JSON.stringify(account)}`);
        assert.ok(account.platform, `Account should have platform: ${account.id}`);
        // d047: tier field removed — platform selection is now ROI-weighted via platform-picker.mjs
      }
    });

    test('accounts have valid test config', () => {
      const reg = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
      for (const account of reg.accounts) {
        assert.ok(account.test, `Account should have test config: ${account.id}`);
        // test.method should be a non-empty string
        if (account.test.method) {
          assert.ok(typeof account.test.method === 'string' && account.test.method.length > 0,
            `test.method should be non-empty string for ${account.id}`);
        }
        // auth type should be valid if present
        if (account.test.auth) {
          const validAuth = ['bearer', 'raw_header', 'x-api-key', 'none'];
          assert.ok(validAuth.includes(account.test.auth),
            `Invalid auth type for ${account.id}: ${account.test.auth}`);
        }
      }
    });

    test('no duplicate account IDs', () => {
      const reg = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
      const ids = reg.accounts.map(a => a.id);
      const uniqueIds = [...new Set(ids)];
      assert.equal(ids.length, uniqueIds.length, 'Should have no duplicate IDs');
    });
  });

  describe('CLI json output', () => {
    // This test makes network calls so we just verify the format, not results
    test('json command outputs valid JSON array', () => {
      try {
        const output = execSync('node account-manager.mjs json 2>&1', {
          cwd: __dirname,
          encoding: 'utf8',
          timeout: 30000
        });
        const parsed = JSON.parse(output);
        assert.ok(Array.isArray(parsed), 'JSON output should be an array');
        if (parsed.length > 0) {
          assert.ok(parsed[0].id, 'Results should have id field');
          assert.ok(parsed[0].platform, 'Results should have platform field');
          assert.ok(parsed[0].status, 'Results should have status field');
        }
      } catch (e) {
        // Timeout is acceptable — network tests may be slow
        if (e.message.includes('ETIMEDOUT') || e.message.includes('timeout')) {
          return; // Skip — network dependent
        }
        throw e;
      }
    });
  });

  describe('usage/help', () => {
    test('unknown command shows usage', () => {
      const output = execSync('node account-manager.mjs unknown 2>&1', { cwd: __dirname, encoding: 'utf8' });
      assert.match(output, /Usage:/, 'Should show usage for unknown command');
    });

    test('diagnose without argument shows usage', () => {
      try {
        execSync('node account-manager.mjs diagnose 2>&1', { cwd: __dirname, encoding: 'utf8' });
        assert.fail('Should exit with error');
      } catch (e) {
        assert.match(e.stdout || e.stderr || '', /Usage:.*diagnose/);
      }
    });
  });

  describe('auth type coverage', () => {
    test('registry covers multiple auth types', () => {
      const reg = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
      const authTypes = new Set(reg.accounts.map(a => a.test?.auth || a.auth_type || 'none').filter(Boolean));
      // Should have at least 2 different auth types
      assert.ok(authTypes.size >= 2, `Should have multiple auth types, got: ${[...authTypes].join(', ')}`);
    });

    test('some accounts use bearer auth', () => {
      const reg = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
      const bearerAccounts = reg.accounts.filter(a => a.test?.auth === 'bearer');
      assert.ok(bearerAccounts.length > 0, 'Should have at least one bearer auth account');
    });
  });

  // d047: tier distribution tests removed — tier system obsolete, platform selection is ROI-weighted
});

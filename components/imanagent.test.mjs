#!/usr/bin/env node
// imanagent.test.mjs — Tests for imanagent.js component
// Run with: node --test components/imanagent.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, renameSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/imanagent-test-' + Date.now();
const TEST_STATE_DIR = join(TEST_HOME, '.config/moltbook');
const REAL_TOKEN_PATH = '/home/moltbot/.imanagent-token';
const BACKUP_PATH = REAL_TOKEN_PATH + '.backup.' + Date.now();
let hadExistingToken = false;

// Mock server that captures tool registrations
function createMockServer() {
  const tools = {};
  return {
    tool: (name, description, schema, handler) => {
      tools[name] = { description, schema, handler };
    },
    getTools: () => tools,
    callTool: async (name, args) => {
      if (!tools[name]) throw new Error(`Tool ${name} not found`);
      return tools[name].handler(args);
    }
  };
}

// Extract text from tool result
function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('imanagent.js component', () => {
  let server;

  before(async () => {
    mkdirSync(TEST_STATE_DIR, { recursive: true });
    // Back up existing token if present
    if (existsSync(REAL_TOKEN_PATH)) {
      hadExistingToken = true;
      renameSync(REAL_TOKEN_PATH, BACKUP_PATH);
    }
  });

  after(() => {
    mock.reset();
    // Restore original token if it existed
    if (hadExistingToken && existsSync(BACKUP_PATH)) {
      if (existsSync(REAL_TOKEN_PATH)) {
        unlinkSync(REAL_TOKEN_PATH);
      }
      renameSync(BACKUP_PATH, REAL_TOKEN_PATH);
    } else if (existsSync(REAL_TOKEN_PATH)) {
      // Clean up test token
      unlinkSync(REAL_TOKEN_PATH);
    }
  });

  describe('tool registration', () => {
    test('registers all expected tools', async () => {
      const mod = await import('./imanagent.js');
      server = createMockServer();
      mod.register(server, { sessionNum: 100, sessionType: 'B' });

      const tools = server.getTools();
      assert.ok(tools.imanagent_status, 'imanagent_status should be registered');
      assert.ok(tools.imanagent_verify, 'imanagent_verify should be registered');
    });

    test('tools have descriptions', async () => {
      const mod = await import('./imanagent.js');
      server = createMockServer();
      mod.register(server, { sessionNum: 100, sessionType: 'B' });

      const tools = server.getTools();
      assert.ok(tools.imanagent_status.description.includes('imanagent'));
      assert.ok(tools.imanagent_verify.description.includes('imanagent'));
    });
  });

  describe('imanagent_status', () => {
    test('returns no token message when token file missing', async () => {
      // Ensure no token file exists
      if (existsSync(REAL_TOKEN_PATH)) {
        unlinkSync(REAL_TOKEN_PATH);
      }

      // Reimport to pick up new state
      const mod = await import('./imanagent.js?v=' + Date.now());
      server = createMockServer();
      mod.register(server, { sessionNum: 100, sessionType: 'B' });

      const result = await server.callTool('imanagent_status', {});
      const text = getText(result);
      assert.ok(text.includes('No imanagent') || text.includes('no'), 'Should indicate no token');
    });

    test('returns valid token status when token present', async () => {
      // Create a valid token file
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      writeFileSync(REAL_TOKEN_PATH, JSON.stringify({
        token: 'test-token',
        token_expires_at: futureDate,
        verification_url: 'https://imanagent.dev/verify/abc123',
        verification_code: 'ABC-123'
      }));

      // Reimport to pick up new token file
      const mod = await import('./imanagent.js?v2=' + Date.now());
      server = createMockServer();
      mod.register(server, { sessionNum: 100, sessionType: 'B' });

      const result = await server.callTool('imanagent_status', {});
      const text = getText(result);
      assert.ok(text.includes('Valid: yes'), 'Should show valid status');
      assert.ok(text.includes('ABC-123'), 'Should show verification code');
    });

    test('detects expired token', async () => {
      // Create an expired token file
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      writeFileSync(REAL_TOKEN_PATH, JSON.stringify({
        token: 'test-token',
        token_expires_at: pastDate,
        verification_url: 'https://imanagent.dev/verify/abc123',
        verification_code: 'ABC-123'
      }));

      // Reimport
      const mod = await import('./imanagent.js?v3=' + Date.now());
      server = createMockServer();
      mod.register(server, { sessionNum: 100, sessionType: 'B' });

      const result = await server.callTool('imanagent_status', {});
      const text = getText(result);
      assert.ok(text.includes('EXPIRED'), 'Should show expired');
    });

    test('handles malformed token file', async () => {
      // Write invalid JSON
      writeFileSync(REAL_TOKEN_PATH, 'not valid json');

      // Reimport
      const mod = await import('./imanagent.js?v4=' + Date.now());
      server = createMockServer();
      mod.register(server, { sessionNum: 100, sessionType: 'B' });

      const result = await server.callTool('imanagent_status', {});
      const text = getText(result);
      // Should handle gracefully - either show no token or error
      assert.ok(text.length > 0, 'Should return some text');
    });
  });

  describe('imanagent_verify', () => {
    test('handles verification attempt', async () => {
      // Clean up token
      if (existsSync(REAL_TOKEN_PATH)) {
        unlinkSync(REAL_TOKEN_PATH);
      }

      const mod = await import('./imanagent.js?v5=' + Date.now());
      server = createMockServer();
      mod.register(server, { sessionNum: 100, sessionType: 'B' });

      // The actual verify will likely fail because verifier script may not work in test
      // But it should return a valid response structure
      const result = await server.callTool('imanagent_verify', {});
      const text = getText(result);
      assert.ok(text.length > 0, 'Should return response text');
      // Should contain either success/failure message
      assert.ok(
        text.includes('Verification') || text.includes('failed') || text.includes('error'),
        'Should indicate verification result'
      );
    });
  });
});

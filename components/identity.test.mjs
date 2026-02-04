#!/usr/bin/env node
// identity.test.mjs — Tests for identity.js component
// Run with: node --test components/identity.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/identity-test-' + Date.now();
const TEST_STATE_DIR = join(TEST_HOME, '.config/moltbook');
process.env.HOME = TEST_HOME;
mkdirSync(TEST_STATE_DIR, { recursive: true });

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

describe('identity.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./identity.js');
    server = createMockServer();
    mod.register(server, { sessionNum: 100, sessionType: 'B' });
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers agent_verify tool', () => {
      const tools = server.getTools();
      assert.ok(tools['agent_verify'], 'agent_verify should be registered');
    });
  });

  describe('agent_verify', () => {
    test('returns VERIFIED for valid manifest', async () => {
      global.fetch = async () => ({
        json: async () => ({
          verified: true,
          agent: 'testbot',
          publicKey: 'abc123',
          algorithm: 'Ed25519',
          proofs: [
            { platform: 'github', handle: 'testbot', valid: true },
            { platform: 'moltbook', handle: 'testbot', valid: true }
          ],
          handles: [
            { platform: 'github', handle: 'testbot' },
            { platform: 'moltbook', handle: 'testbot' }
          ]
        })
      });

      const result = await server.callTool('agent_verify', { url: 'https://example.com/agent.json' });
      const text = getText(result);

      assert.ok(text.includes('VERIFIED'), 'Should show VERIFIED status');
      assert.ok(text.includes('testbot'), 'Should show agent name');
      assert.ok(text.includes('Ed25519'), 'Should show algorithm');
      assert.ok(text.includes('github: testbot'), 'Should show proof');
    });

    test('returns FAILED for invalid manifest', async () => {
      global.fetch = async () => ({
        json: async () => ({
          verified: false,
          error: 'Invalid signature',
          url: 'https://example.com/agent.json'
        })
      });

      const result = await server.callTool('agent_verify', { url: 'https://example.com/agent.json' });
      const text = getText(result);

      assert.ok(text.includes('Verification failed'), 'Should indicate failure');
      assert.ok(text.includes('Invalid signature'), 'Should show error message');
    });

    test('handles failed proofs', async () => {
      global.fetch = async () => ({
        json: async () => ({
          verified: false,
          agent: 'badbot',
          publicKey: 'def456',
          algorithm: 'Ed25519',
          proofs: [
            { platform: 'github', handle: 'badbot', valid: false, error: 'Signature mismatch' }
          ]
        })
      });

      const result = await server.callTool('agent_verify', { url: 'https://example.com/agent.json' });
      const text = getText(result);

      assert.ok(text.includes('FAILED'), 'Should show FAILED status');
      assert.ok(text.includes('✗ github'), 'Should show failed proof with X mark');
      assert.ok(text.includes('Signature mismatch'), 'Should show proof error');
    });

    test('shows revoked keys count', async () => {
      global.fetch = async () => ({
        json: async () => ({
          verified: true,
          agent: 'rotator',
          publicKey: 'ghi789',
          algorithm: 'Ed25519',
          proofs: [],
          revoked: ['oldkey1', 'oldkey2']
        })
      });

      const result = await server.callTool('agent_verify', { url: 'https://example.com/agent.json' });
      const text = getText(result);

      assert.ok(text.includes('Revoked keys: 2'), 'Should show revoked key count');
    });

    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Network timeout'); };

      const result = await server.callTool('agent_verify', { url: 'https://example.com/agent.json' });
      const text = getText(result);

      assert.ok(text.includes('Verify error'), 'Should indicate error');
      assert.ok(text.includes('Network timeout'), 'Should show error message');
    });

    test('encodes URL properly', async () => {
      let capturedUrl = '';
      global.fetch = async (url) => {
        capturedUrl = url;
        return { json: async () => ({ verified: true, agent: 'test' }) };
      };

      await server.callTool('agent_verify', { url: 'https://example.com/path?foo=bar' });

      assert.ok(capturedUrl.includes('url=https%3A%2F%2Fexample.com%2Fpath%3Ffoo%3Dbar'),
        'Should URL-encode the agent URL parameter');
    });
  });
});

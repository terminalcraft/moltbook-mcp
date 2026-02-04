#!/usr/bin/env node
// presence.test.mjs — Tests for presence.js component
// Run with: node --test components/presence.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/presence-test-' + Date.now();
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

describe('presence.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./presence.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers presence_heartbeat tool', () => {
      const tools = server.getTools();
      assert.ok(tools['presence_heartbeat'], 'presence_heartbeat should be registered');
    });

    test('registers presence_list tool', () => {
      const tools = server.getTools();
      assert.ok(tools['presence_list'], 'presence_list should be registered');
    });

    test('registers presence_check tool', () => {
      const tools = server.getTools();
      assert.ok(tools['presence_check'], 'presence_check should be registered');
    });
  });

  describe('presence_heartbeat', () => {
    test('sends heartbeat with required fields', async () => {
      let capturedBody = null;
      global.fetch = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { json: async () => ({ ok: true }) };
      };

      const result = await server.callTool('presence_heartbeat', { handle: 'moltbook' });
      const text = getText(result);

      assert.ok(text.includes('Heartbeat sent for moltbook'), 'Should confirm heartbeat');
      assert.equal(capturedBody.handle, 'moltbook', 'Should include handle');
    });

    test('sends heartbeat with optional fields', async () => {
      let capturedBody = null;
      global.fetch = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { json: async () => ({ ok: true }) };
      };

      await server.callTool('presence_heartbeat', {
        handle: 'moltbook',
        status: 'building',
        url: 'http://example.com',
        capabilities: ['code-review', 'mcp-tools'],
        meta: { version: '1.0' }
      });

      assert.equal(capturedBody.status, 'building', 'Should include status');
      assert.equal(capturedBody.url, 'http://example.com', 'Should include URL');
      assert.deepEqual(capturedBody.capabilities, ['code-review', 'mcp-tools'], 'Should include capabilities');
      assert.deepEqual(capturedBody.meta, { version: '1.0' }, 'Should include meta');
    });

    test('handles heartbeat error response', async () => {
      global.fetch = async () => ({
        json: async () => ({ ok: false, error: 'Invalid handle' })
      });

      const result = await server.callTool('presence_heartbeat', { handle: 'bad' });
      const text = getText(result);

      assert.ok(text.includes('Error'), 'Should indicate error');
    });

    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Connection refused'); };

      const result = await server.callTool('presence_heartbeat', { handle: 'test' });
      const text = getText(result);

      assert.ok(text.includes('Presence error'), 'Should indicate presence error');
      assert.ok(text.includes('Connection refused'), 'Should show error message');
    });
  });

  describe('presence_list', () => {
    test('shows empty state message', async () => {
      global.fetch = async () => ({
        json: async () => ({ agents: [], online: 0, total: 0 })
      });

      const result = await server.callTool('presence_list', {});
      const text = getText(result);

      assert.ok(text.includes('No agents registered'), 'Should show empty message');
    });

    test('shows agent list with online/offline status', async () => {
      global.fetch = async () => ({
        json: async () => ({
          online: 2,
          total: 3,
          agents: [
            { handle: 'agent1', online: true, status: 'building', ago_seconds: 30, heartbeats: 100, capabilities: ['code-review'] },
            { handle: 'agent2', online: true, status: 'idle', ago_seconds: 120, heartbeats: 50 },
            { handle: 'agent3', online: false, status: 'offline', ago_seconds: 7200, heartbeats: 10 }
          ]
        })
      });

      const result = await server.callTool('presence_list', {});
      const text = getText(result);

      assert.ok(text.includes('2/3 agents online'), 'Should show count');
      assert.ok(text.includes('🟢'), 'Should show green for online');
      assert.ok(text.includes('⚫'), 'Should show black for offline');
      assert.ok(text.includes('agent1'), 'Should show agent names');
      assert.ok(text.includes('building'), 'Should show status');
      assert.ok(text.includes('code-review'), 'Should show capabilities');
      assert.ok(text.includes('30s ago'), 'Should show seconds ago');
      assert.ok(text.includes('2m ago'), 'Should show minutes ago');
      assert.ok(text.includes('2h ago'), 'Should show hours ago');
    });

    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Network error'); };

      const result = await server.callTool('presence_list', {});
      const text = getText(result);

      assert.ok(text.includes('Presence error'), 'Should indicate presence error');
    });
  });

  describe('presence_check', () => {
    test('shows agent details when found', async () => {
      global.fetch = async () => ({
        status: 200,
        json: async () => ({
          handle: 'testbot',
          online: true,
          ago_seconds: 45,
          heartbeats: 200,
          first_seen: '2026-01-01T00:00:00Z',
          url: 'http://testbot.example.com'
        })
      });

      const result = await server.callTool('presence_check', { handle: 'testbot' });
      const text = getText(result);

      assert.ok(text.includes('testbot: online'), 'Should show online status');
      assert.ok(text.includes('45s ago'), 'Should show last seen');
      assert.ok(text.includes('200 heartbeats'), 'Should show heartbeat count');
      assert.ok(text.includes('http://testbot.example.com'), 'Should show URL');
    });

    test('shows offline status', async () => {
      global.fetch = async () => ({
        status: 200,
        json: async () => ({
          handle: 'sleepy',
          online: false,
          ago_seconds: 3700,
          heartbeats: 5,
          first_seen: '2026-01-15T12:00:00Z'
        })
      });

      const result = await server.callTool('presence_check', { handle: 'sleepy' });
      const text = getText(result);

      assert.ok(text.includes('sleepy: offline'), 'Should show offline status');
      assert.ok(text.includes('1h ago'), 'Should show hours ago');
    });

    test('handles 404 for unknown agent', async () => {
      global.fetch = async () => ({ status: 404 });

      const result = await server.callTool('presence_check', { handle: 'unknown' });
      const text = getText(result);

      assert.ok(text.includes("Agent 'unknown' not found"), 'Should show not found message');
    });

    test('URL-encodes handle', async () => {
      let capturedUrl = '';
      global.fetch = async (url) => {
        capturedUrl = url;
        return { status: 404 };
      };

      await server.callTool('presence_check', { handle: 'test@bot' });

      assert.ok(capturedUrl.includes('test%40bot'), 'Should URL-encode special characters');
    });

    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Timeout'); };

      const result = await server.callTool('presence_check', { handle: 'test' });
      const text = getText(result);

      assert.ok(text.includes('Presence error'), 'Should indicate presence error');
      assert.ok(text.includes('Timeout'), 'Should show error message');
    });
  });
});

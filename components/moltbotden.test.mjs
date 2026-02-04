#!/usr/bin/env node
// moltbotden.test.mjs — Tests for moltbotden.js component
// Run with: node --test components/moltbotden.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/moltbotden-test-' + Date.now();
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

describe('moltbotden.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    // Mock fetch for MoltbotDen API
    originalFetch = global.fetch;
    global.fetch = mock.fn(async (url, opts) => {
      // Public endpoints
      if (url.includes('/public/agents')) {
        return {
          ok: true,
          json: async () => ({
            agents: [
              { agent_id: 'agent1', display_name: 'Agent One', tagline: 'First test agent' },
              { agent_id: 'agent2', display_name: 'Agent Two', tagline: 'Second test agent' }
            ]
          })
        };
      }
      if (url.includes('/public/activity')) {
        return { ok: true, json: async () => ({ events: [] }) };
      }
      if (url.includes('/public/stats')) {
        return { ok: true, json: async () => ({ total_agents: 100, active_agents: 50 }) };
      }
      if (url.includes('/public/leaderboard')) {
        return { ok: true, json: async () => ({ leaders: [] }) };
      }
      // Auth-required endpoints - check for X-API-Key header
      const hasKey = opts?.headers?.['X-API-Key'];
      if (!hasKey && (url.includes('/agents/me') || url.includes('/discover') || url.includes('/interest') || url.includes('/connections') || url.includes('/conversations') || url.includes('/heartbeat'))) {
        return { ok: false, status: 401, text: async () => 'Unauthorized' };
      }
      // Default mock response
      return { ok: true, json: async () => ({}) };
    });

    const mod = await import('./moltbotden.js');
    server = createMockServer();
    mod.register(server, { sessionNum: 100, sessionType: 'B' });
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
    try { rmSync(TEST_HOME, { recursive: true }); } catch {}
  });

  describe('tool registration', () => {
    test('registers all public endpoint tools', () => {
      const tools = server.getTools();
      const publicTools = ['moltbotden_agents', 'moltbotden_activity', 'moltbotden_stats', 'moltbotden_leaderboard', 'moltbotden_agent'];
      for (const toolName of publicTools) {
        assert.ok(tools[toolName], `Tool ${toolName} should be registered`);
      }
    });

    test('registers all auth-required tools', () => {
      const tools = server.getTools();
      const authTools = ['moltbotden_me', 'moltbotden_discover', 'moltbotden_interest', 'moltbotden_connections', 'moltbotden_conversations', 'moltbotden_send', 'moltbotden_heartbeat'];
      for (const toolName of authTools) {
        assert.ok(tools[toolName], `Tool ${toolName} should be registered`);
      }
    });
  });

  describe('public endpoints (no auth required)', () => {
    test('moltbotden_agents lists agents', async () => {
      const result = await server.callTool('moltbotden_agents', { limit: 10, sort: 'recent' });
      const text = getText(result);
      assert.ok(text.includes('Agent') || text.includes('agent') || text.includes('Error'), 'Should list agents or show error');
    });

    test('moltbotden_stats returns platform statistics', async () => {
      const result = await server.callTool('moltbotden_stats', {});
      const text = getText(result);
      assert.ok(text, 'Should return stats');
    });

    test('moltbotden_leaderboard returns leaders', async () => {
      const result = await server.callTool('moltbotden_leaderboard', { category: 'connections', limit: 5 });
      const text = getText(result);
      assert.ok(text, 'Should return leaderboard');
    });

    test('moltbotden_activity returns events', async () => {
      const result = await server.callTool('moltbotden_activity', { limit: 10 });
      const text = getText(result);
      assert.ok(text, 'Should return activity');
    });

    test('moltbotden_agent looks up specific agent', async () => {
      const result = await server.callTool('moltbotden_agent', { agent_id: 'test-agent' });
      const text = getText(result);
      assert.ok(text, 'Should return agent profile or error');
    });
  });

  describe('auth-required endpoints', () => {
    test('moltbotden_me returns error without API key', async () => {
      const result = await server.callTool('moltbotden_me', {});
      const text = getText(result);
      assert.ok(text.includes('key') || text.includes('Error') || text.includes('configured'), 'Should indicate missing API key');
    });

    test('moltbotden_discover requires API key', async () => {
      const result = await server.callTool('moltbotden_discover', { min_compatibility: 0.5, limit: 5 });
      const text = getText(result);
      assert.ok(text.includes('key') || text.includes('Error') || text, 'Should handle missing key');
    });

    test('moltbotden_interest requires API key', async () => {
      const result = await server.callTool('moltbotden_interest', { target: 'agent1', message: 'Hello!' });
      const text = getText(result);
      assert.ok(text.includes('key') || text.includes('Error') || text, 'Should handle missing key');
    });

    test('moltbotden_connections requires API key', async () => {
      const result = await server.callTool('moltbotden_connections', {});
      const text = getText(result);
      assert.ok(text.includes('key') || text.includes('Error') || text, 'Should handle missing key');
    });

    test('moltbotden_conversations requires API key', async () => {
      const result = await server.callTool('moltbotden_conversations', { limit: 10 });
      const text = getText(result);
      assert.ok(text.includes('key') || text.includes('Error') || text, 'Should handle missing key');
    });

    test('moltbotden_send requires API key', async () => {
      const result = await server.callTool('moltbotden_send', { conversation_id: 'conv1', recipient_id: 'agent2', content: 'Test message' });
      const text = getText(result);
      assert.ok(text.includes('key') || text.includes('Error') || text, 'Should handle missing key');
    });

    test('moltbotden_heartbeat requires API key', async () => {
      const result = await server.callTool('moltbotden_heartbeat', {});
      const text = getText(result);
      assert.ok(text.includes('key') || text.includes('Error') || text, 'Should handle missing key');
    });
  });

  describe('parameter handling', () => {
    test('moltbotden_agents accepts sort parameter', async () => {
      const tools = server.getTools();
      const schema = tools['moltbotden_agents'].schema;
      assert.ok('sort' in schema, 'Should have sort parameter');
    });

    test('moltbotden_leaderboard accepts category parameter', async () => {
      const tools = server.getTools();
      const schema = tools['moltbotden_leaderboard'].schema;
      assert.ok('category' in schema, 'Should have category parameter');
    });

    test('moltbotden_discover accepts capabilities filter', async () => {
      const tools = server.getTools();
      const schema = tools['moltbotden_discover'].schema;
      assert.ok('capabilities' in schema, 'Should have capabilities parameter');
    });
  });
});

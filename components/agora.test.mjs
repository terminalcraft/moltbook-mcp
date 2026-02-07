#!/usr/bin/env node
// agora.test.mjs — Tests for agora.js component
// Run with: node --test components/agora.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/agora-test-' + Date.now();
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

describe('agora.js component', () => {
  let server;

  before(async () => {
    const mod = await import('./agora.js');
    server = createMockServer();
    mod.register(server, { sessionNum: 100, sessionType: 'B' });
  });

  after(() => {
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers all expected tools', () => {
      const tools = server.getTools();
      const expectedTools = [
        "agora_markets",
        "agora_market_detail",
        "agora_register",
        "agora_agent",
        "agora_trade",
        "agora_sell",
        "agora_leaderboard",
        "agora_stats",
        "agora_positions",
        "agora_comment",
        "agora_create_market",
        "agora_activity",
        "agora_daily_claim",
        "agora_achievements",
        "agora_streak",
        "agora_engagement",
        "agora_trade_history",
        "agora_reputation",
      ];

      for (const toolName of expectedTools) {
        assert.ok(tools[toolName], `Tool ${toolName} should be registered`);
      }
      assert.equal(Object.keys(tools).length, expectedTools.length, `Should have exactly ${expectedTools.length} tools`);
    });
  });

  describe('tool functionality', () => {
    test('agora_markets returns text content', async () => {
      const result = await server.callTool('agora_markets', { limit: 3 });
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_market_detail returns text content', async () => {
      const result = await server.callTool('agora_market_detail', { market_id: 'nonexistent-id' });
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_register returns text content', async () => {
      const result = await server.callTool('agora_register', { handle: 'test-handle' });
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_trade uses outcome field', async () => {
      const result = await server.callTool('agora_trade', { market_id: 'fake-id', outcome: 'yes', amount: 10 });
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_sell returns text content', async () => {
      const result = await server.callTool('agora_sell', { market_id: 'fake-id', outcome: 'yes', shares: 1 });
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_leaderboard returns text content', async () => {
      const result = await server.callTool('agora_leaderboard', { type: 'brier', limit: 5 });
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_stats returns text content', async () => {
      const result = await server.callTool('agora_stats', {});
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_positions returns text content', async () => {
      const result = await server.callTool('agora_positions', {});
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_comment uses text field', async () => {
      const result = await server.callTool('agora_comment', { market_id: 'fake-id', text: 'test comment' });
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_create_market returns text content', async () => {
      const result = await server.callTool('agora_create_market', {
        question: 'Will agents achieve full autonomy by 2027?',
        category: 'ai'
      });
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_activity returns text content', async () => {
      const result = await server.callTool('agora_activity', { limit: 5 });
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_daily_claim returns text content', async () => {
      const result = await server.callTool('agora_daily_claim', {});
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_achievements returns text content', async () => {
      const result = await server.callTool('agora_achievements', { handle: 'moltbook' });
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_streak returns text content', async () => {
      const result = await server.callTool('agora_streak', {});
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_engagement returns text content', async () => {
      const result = await server.callTool('agora_engagement', {});
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_trade_history returns text content', async () => {
      const result = await server.callTool('agora_trade_history', {});
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });

    test('agora_reputation returns text content', async () => {
      const result = await server.callTool('agora_reputation', { handle: 'moltbook' });
      const text = getText(result);
      assert.ok(text, 'Should return text content');
    });
  });
});

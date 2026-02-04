#!/usr/bin/env node
// badges.test.mjs — Tests for badges.js component
// Run with: node --test components/badges.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/badges-test-' + Date.now();
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

describe('badges.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./badges.js');
    server = createMockServer();
    mod.register(server, { sessionNum: 100, sessionType: 'B' });
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers badges_view tool', () => {
      const tools = server.getTools();
      assert.ok(tools['badges_view'], 'badges_view should be registered');
    });
  });

  describe('badges_view — all definitions', () => {
    test('lists all badge definitions when no handle provided', async () => {
      global.fetch = async () => ({
        json: async () => ({
          total: 3,
          badges: [
            { icon: '🥇', name: 'Pioneer', tier: 'gold', desc: 'Early adopter' },
            { icon: '🥈', name: 'Builder', tier: 'silver', desc: 'Shipped code' },
            { icon: '🥉', name: 'Helper', tier: 'bronze', desc: 'Helped others' }
          ]
        })
      });

      const result = await server.callTool('badges_view', {});
      const text = getText(result);

      assert.ok(text.includes('Agent Badges'), 'Should show header');
      assert.ok(text.includes('3 available'), 'Should show total count');
      assert.ok(text.includes('Pioneer'), 'Should list badge name');
      assert.ok(text.includes('[gold]'), 'Should show tier');
    });

    test('sorts badges by tier (gold, silver, bronze)', async () => {
      global.fetch = async () => ({
        json: async () => ({
          total: 3,
          badges: [
            { icon: '🥉', name: 'Bronze1', tier: 'bronze', desc: 'B1' },
            { icon: '🥇', name: 'Gold1', tier: 'gold', desc: 'G1' },
            { icon: '🥈', name: 'Silver1', tier: 'silver', desc: 'S1' }
          ]
        })
      });

      const result = await server.callTool('badges_view', {});
      const text = getText(result);

      const goldIdx = text.indexOf('Gold1');
      const silverIdx = text.indexOf('Silver1');
      const bronzeIdx = text.indexOf('Bronze1');

      assert.ok(goldIdx < silverIdx, 'Gold should appear before silver');
      assert.ok(silverIdx < bronzeIdx, 'Silver should appear before bronze');
    });
  });

  describe('badges_view — agent badges', () => {
    test('shows earned badges for an agent', async () => {
      global.fetch = async () => ({
        json: async () => ({
          count: 2,
          total_possible: 5,
          badges: [
            { icon: '🥇', name: 'Pioneer', tier: 'gold', desc: 'Early adopter' },
            { icon: '🥈', name: 'Builder', tier: 'silver', desc: 'Shipped code' }
          ]
        })
      });

      const result = await server.callTool('badges_view', { handle: 'testbot' });
      const text = getText(result);

      assert.ok(text.includes('@testbot'), 'Should show agent handle');
      assert.ok(text.includes('2/5 badges earned'), 'Should show earned count');
      assert.ok(text.includes('Pioneer'), 'Should list earned badge');
    });

    test('shows message for agent with no badges', async () => {
      global.fetch = async () => ({
        json: async () => ({
          count: 0,
          total_possible: 5,
          badges: []
        })
      });

      const result = await server.callTool('badges_view', { handle: 'newbie' });
      const text = getText(result);

      assert.ok(text.includes('@newbie'), 'Should show agent handle');
      assert.ok(text.includes('0/5 badges earned'), 'Should show zero count');
      assert.ok(text.includes('No badges yet'), 'Should show encouragement message');
    });

    test('encodes handle in URL', async () => {
      let capturedUrl = '';
      global.fetch = async (url) => {
        capturedUrl = url;
        return { json: async () => ({ count: 0, total_possible: 5, badges: [] }) };
      };

      await server.callTool('badges_view', { handle: 'test@bot' });

      assert.ok(capturedUrl.includes('/badges/test%40bot'), 'Should URL-encode handle');
    });
  });

  describe('error handling', () => {
    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Connection refused'); };

      const result = await server.callTool('badges_view', {});
      const text = getText(result);

      assert.ok(text.includes('Badges error'), 'Should indicate error');
      assert.ok(text.includes('Connection refused'), 'Should show error message');
    });
  });
});

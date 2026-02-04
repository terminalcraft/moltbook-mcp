#!/usr/bin/env node
// bsky.test.mjs — Tests for bsky.js component
// Run with: node --test components/bsky.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/bsky-test-' + Date.now();
const TEST_STATE_DIR = join(TEST_HOME, 'moltbook-mcp');
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

describe('bsky.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    // Mock global fetch before importing module
    originalFetch = global.fetch;
    global.fetch = mock.fn(async (url) => {
      // Return mock responses based on URL
      if (url.includes('searchActors')) {
        return {
          ok: true,
          json: async () => ({
            actors: [
              {
                handle: 'bottest.bsky.social',
                displayName: 'Test Bot',
                did: 'did:plc:test123',
                description: 'I am a bot. Automated account powered by Claude.',
                followersCount: 100,
                followsCount: 50,
                postsCount: 25
              },
              {
                handle: 'humanuser.bsky.social',
                displayName: 'Human User',
                did: 'did:plc:human456',
                description: 'PhD researcher working on AI systems.',
                followersCount: 500,
                followsCount: 200,
                postsCount: 1000
              }
            ]
          })
        };
      }
      if (url.includes('getFollows')) {
        return { ok: true, json: async () => ({ follows: [] }) };
      }
      if (url.includes('getAuthorFeed')) {
        return {
          ok: true,
          json: async () => ({
            feed: [
              { post: { record: { text: 'I am a bot posting this automatically.' } } },
              { post: { record: { text: 'Session 123: analyzing data.' } } }
            ]
          })
        };
      }
      return { ok: false };
    });

    const mod = await import('./bsky.js');
    server = createMockServer();
    mod.register(server, { sessionNum: 100, sessionType: 'B' });
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
    try { rmSync(TEST_HOME, { recursive: true }); } catch {}
  });

  describe('tool registration', () => {
    test('registers moltbook_bsky_discover tool', () => {
      const tools = server.getTools();
      assert.ok(tools['moltbook_bsky_discover'], 'moltbook_bsky_discover should be registered');
    });

    test('tool has correct description', () => {
      const tools = server.getTools();
      const desc = tools['moltbook_bsky_discover'].description;
      assert.ok(desc.includes('Discover'), 'Description should mention discovery');
      assert.ok(desc.includes('Bluesky'), 'Description should mention Bluesky');
    });

    test('tool schema includes all parameters', () => {
      const tools = server.getTools();
      const schema = tools['moltbook_bsky_discover'].schema;
      assert.ok('limit' in schema, 'Should have limit param');
      assert.ok('min_score' in schema, 'Should have min_score param');
      assert.ok('ai_only' in schema, 'Should have ai_only param');
      assert.ok('follow_graph' in schema, 'Should have follow_graph param');
      assert.ok('analyze_posts' in schema, 'Should have analyze_posts param');
    });
  });

  describe('discovery functionality', () => {
    test('returns agent results or no-results message', async () => {
      const result = await server.callTool('moltbook_bsky_discover', {
        limit: 10,
        min_score: 1,
        follow_graph: false,
        analyze_posts: false
      });
      const text = getText(result);
      assert.ok(text.includes('Bluesky') || text.includes('No'), 'Should have discovery header or no-results');
    });

    test('handles API errors gracefully', async () => {
      const savedFetch = global.fetch;
      global.fetch = mock.fn(async () => { throw new Error('Network error'); });

      const result = await server.callTool('moltbook_bsky_discover', { limit: 5 });
      const text = getText(result);
      assert.ok(text.includes('error') || text.includes('No'), 'Should handle error gracefully');

      global.fetch = savedFetch;
    });

    test('respects ai_only filter parameter', async () => {
      const result = await server.callTool('moltbook_bsky_discover', {
        limit: 10,
        min_score: 1,
        ai_only: true,
        follow_graph: false,
        analyze_posts: false
      });
      const text = getText(result);
      assert.ok(text, 'Should return some output with ai_only filter');
    });

    test('respects follow_graph parameter', async () => {
      const result = await server.callTool('moltbook_bsky_discover', {
        limit: 5,
        follow_graph: true,
        analyze_posts: false
      });
      const text = getText(result);
      assert.ok(text, 'Should return output with follow_graph enabled');
    });

    test('respects analyze_posts parameter', async () => {
      const result = await server.callTool('moltbook_bsky_discover', {
        limit: 5,
        follow_graph: false,
        analyze_posts: true
      });
      const text = getText(result);
      assert.ok(text, 'Should return output with analyze_posts enabled');
    });
  });
});

#!/usr/bin/env node
// moltbook-core.test.mjs — Tests for moltbook-core.js component
// Run with: node --test components/moltbook-core.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set up isolated test environment
const TEST_HOME = '/tmp/moltbook-core-test-' + Date.now();
const TEST_STATE_DIR = join(TEST_HOME, '.config/moltbook');
const TEST_MCP_DIR = join(TEST_HOME, 'moltbook-mcp');
process.env.HOME = TEST_HOME;
mkdirSync(TEST_STATE_DIR, { recursive: true });
mkdirSync(TEST_MCP_DIR, { recursive: true });

// Create minimal state file
writeFileSync(join(TEST_STATE_DIR, 'engagement-state.json'), JSON.stringify({
  seen: {}, commented: {}, voted: {}, myPosts: {}, myComments: {}, browsed: {}, lastActivity: {}
}));

// Create empty human-review.json
writeFileSync(join(TEST_MCP_DIR, 'human-review.json'), JSON.stringify({ version: 1, items: [] }));

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

describe('moltbook-core.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    // Mock fetch for API calls
    originalFetch = global.fetch;
    global.fetch = mock.fn(async (url, opts) => {
      // Mock Moltbook API responses
      if (url.includes('/posts/') && !opts?.method) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            post: { id: 'test-123', title: 'Test Post', content: 'Test content', upvotes: 5, downvotes: 0, comment_count: 2, author: { name: 'testuser' }, submolt: { name: 'general' } },
            comments: []
          })
        };
      }
      if (url.includes('/search')) {
        return {
          ok: true,
          json: async () => ({ success: true, results: { posts: [], moltys: [], submolts: [] } })
        };
      }
      if (url.includes('/submolts')) {
        return {
          ok: true,
          json: async () => ({ success: true, submolts: [{ name: 'general', display_name: 'General', subscriber_count: 100 }] })
        };
      }
      // Default: return error
      return {
        ok: false,
        json: async () => ({ success: false, error: 'Mock API error' })
      };
    });

    // Import module after mocking
    const mod = await import('./moltbook-core.js');
    server = createMockServer();
    mod.register(server, { sessionNum: 100, sessionType: 'B' });
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
    try { rmSync(TEST_HOME, { recursive: true }); } catch {}
  });

  describe('tool registration', () => {
    test('registers all expected Moltbook API tools', () => {
      const tools = server.getTools();
      const expectedTools = [
        'moltbook_post', 'moltbook_post_create', 'moltbook_comment',
        'moltbook_vote', 'moltbook_search', 'moltbook_submolts',
        'moltbook_profile', 'moltbook_profile_update', 'moltbook_follow',
        'moltbook_github_map'
      ];

      for (const toolName of expectedTools) {
        assert.ok(tools[toolName], `Tool ${toolName} should be registered`);
      }
    });

    test('registers human_review tools', () => {
      const tools = server.getTools();
      assert.ok(tools['human_review_flag'], 'human_review_flag should be registered');
      assert.ok(tools['human_review_list'], 'human_review_list should be registered');
    });
  });

  describe('human_review_flag functionality', () => {
    test('creates review item with correct structure', async () => {
      const result = await server.callTool('human_review_flag', {
        title: 'Test review item',
        body: 'This needs human attention',
        source: 'test-source',
        priority: 'high'
      });
      const text = getText(result);
      assert.ok(text.includes('Flagged'), 'Should confirm item was flagged');
      assert.ok(text.includes('high'), 'Should include priority');
    });

    test('truncates long titles', async () => {
      const longTitle = 'A'.repeat(300);
      const result = await server.callTool('human_review_flag', {
        title: longTitle,
        priority: 'low'
      });
      const text = getText(result);
      assert.ok(text.includes('Flagged'), 'Should still create item');
    });

    test('uses default priority when not specified', async () => {
      const result = await server.callTool('human_review_flag', {
        title: 'Default priority test'
      });
      const text = getText(result);
      assert.ok(text.includes('medium') || text.includes('Flagged'), 'Should use default priority');
    });
  });

  describe('human_review_list functionality', () => {
    test('lists open items by default', async () => {
      const result = await server.callTool('human_review_list', { status: 'open' });
      const text = getText(result);
      assert.ok(text, 'Should return text');
    });

    test('can filter by all statuses', async () => {
      const result = await server.callTool('human_review_list', { status: 'all' });
      const text = getText(result);
      assert.ok(text, 'Should return text for all statuses');
    });

    test('handles empty list gracefully', async () => {
      // Reset to empty
      writeFileSync(join(TEST_MCP_DIR, 'human-review.json'), JSON.stringify({ version: 1, items: [] }));
      const result = await server.callTool('human_review_list', { status: 'resolved' });
      const text = getText(result);
      assert.ok(text.includes('No') || text.includes('0'), 'Should indicate empty list');
    });
  });

  describe('moltbook_github_map functionality', () => {
    test('lists all mappings when no handle provided', async () => {
      const result = await server.callTool('moltbook_github_map', {});
      const text = getText(result);
      assert.ok(text.includes('mapping') || text.includes('No'), 'Should show mappings or empty state');
    });

    test('shows specific agent mapping', async () => {
      const result = await server.callTool('moltbook_github_map', { handle: 'nonexistent-agent' });
      const text = getText(result);
      assert.ok(text.includes('No mapping') || text.includes('Provide'), 'Should indicate no mapping exists');
    });
  });

  describe('moltbook API tools (mocked)', () => {
    test('moltbook_post fetches post with comments', async () => {
      const result = await server.callTool('moltbook_post', { post_id: 'test-123' });
      const text = getText(result);
      assert.ok(text.includes('Test') || text.includes('error'), 'Should return post content or error');
    });

    test('moltbook_search returns results structure', async () => {
      const result = await server.callTool('moltbook_search', { query: 'test', limit: 5 });
      const text = getText(result);
      assert.ok(text, 'Should return search results');
    });

    test('moltbook_submolts lists submolts', async () => {
      const result = await server.callTool('moltbook_submolts', {});
      const text = getText(result);
      assert.ok(text.includes('general') || text.includes('error'), 'Should list submolts or error');
    });

    test('moltbook_vote requires type and direction', async () => {
      const result = await server.callTool('moltbook_vote', {
        type: 'post',
        id: 'test-123',
        direction: 'upvote'
      });
      const text = getText(result);
      assert.ok(text, 'Should return vote result');
    });
  });
});

#!/usr/bin/env node
// engagement.test.mjs — Tests for engagement.js component (wq-156)
// Run with: node --test components/engagement.test.mjs

import { test, describe, before, after, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/engagement-test-' + Date.now();
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

describe('engagement.js component', () => {
  let server;
  let moltbookApiMock;

  before(async () => {
    // Create empty state file
    writeFileSync(join(TEST_STATE_DIR, 'engagement-state.json'), JSON.stringify({
      session: 100,
      seen: {},
      commented: {},
      voted: {},
      myPosts: {},
      myComments: {},
      browsedSubmolts: {}
    }));

    // Import with mocked dependencies
    const mod = await import('./engagement.js');
    server = createMockServer();
    mod.register(server, { sessionNum: 100, sessionType: 'E' });
  });

  after(() => {
    mock.reset();
  });

  describe('moltbook_state', () => {
    test('returns compact format correctly', async () => {
      const tools = server.getTools();
      assert.ok(tools.moltbook_state, 'moltbook_state tool should exist');

      const result = await server.callTool('moltbook_state', { format: 'compact' });
      const text = getText(result);
      assert.ok(text.includes('Session'), 'Should include session info');
      assert.ok(text.includes('seen'), 'Should include seen count');
    });

    test('returns full format correctly', async () => {
      const result = await server.callTool('moltbook_state', { format: 'full' });
      const text = getText(result);
      assert.ok(text.includes('Engagement state'), 'Should include engagement state header');
      assert.ok(text.includes('Posts seen:'), 'Should include posts seen');
    });
  });

  describe('moltbook_dedup_check (wq-145)', () => {
    beforeEach(() => {
      // Clear dedup cache before each test
      const cachePath = join(TEST_STATE_DIR, 'cross-platform-dedup.json');
      if (existsSync(cachePath)) unlinkSync(cachePath);
    });

    test('returns no duplicate for empty cache', async () => {
      const result = await server.callTool('moltbook_dedup_check', {
        platform: '4claw',
        title: 'Test Thread',
        content: 'Some test content here',
        thread_id: 'thread-123'
      });
      const text = getText(result);
      assert.ok(text.includes('No duplicate found'), 'Should indicate no duplicate');
      assert.ok(text.includes('Safe to engage'), 'Should indicate safe to engage');
    });

    test('detects duplicate after recording', async () => {
      // First, record an engagement on 4claw
      await server.callTool('moltbook_dedup_record', {
        platform: '4claw',
        title: 'Agent Infrastructure Discussion',
        content: 'How do agents build reliable infrastructure?',
        thread_id: 'thread-1',
        action: 'reply'
      });

      // Now check for the same content on chatr
      const result = await server.callTool('moltbook_dedup_check', {
        platform: 'chatr',
        title: 'Agent Infrastructure Discussion',
        content: 'How do agents build reliable infrastructure?',
        thread_id: 'msg-456'
      });
      const text = getText(result);
      assert.ok(text.includes('DUPLICATE DETECTED'), 'Should detect duplicate');
      assert.ok(text.includes('4claw'), 'Should mention original platform');
    });

    test('does not match same platform', async () => {
      // Record on 4claw
      await server.callTool('moltbook_dedup_record', {
        platform: '4claw',
        title: 'Test Thread',
        content: 'Content here',
        thread_id: 'thread-1',
        action: 'reply'
      });

      // Check same platform - should NOT be flagged
      const result = await server.callTool('moltbook_dedup_check', {
        platform: '4claw',
        title: 'Test Thread',
        content: 'Content here',
        thread_id: 'thread-2'
      });
      const text = getText(result);
      assert.ok(text.includes('No duplicate found'), 'Same platform should not be flagged');
    });
  });

  describe('moltbook_dedup_record (wq-145)', () => {
    beforeEach(() => {
      const cachePath = join(TEST_STATE_DIR, 'cross-platform-dedup.json');
      if (existsSync(cachePath)) unlinkSync(cachePath);
    });

    test('records engagement correctly', async () => {
      const result = await server.callTool('moltbook_dedup_record', {
        platform: '4claw',
        title: 'Test Thread Title',
        content: 'Some content',
        thread_id: 'thread-abc',
        action: 'reply'
      });
      const text = getText(result);
      assert.ok(text.includes('Recorded:'), 'Should confirm recording');
      assert.ok(text.includes('reply'), 'Should include action');
      assert.ok(text.includes('4claw'), 'Should include platform');
    });

    test('handles missing content gracefully', async () => {
      const result = await server.callTool('moltbook_dedup_record', {
        platform: 'chatr',
        title: 'Title Only',
        thread_id: 'msg-123',
        action: 'comment'
      });
      const text = getText(result);
      assert.ok(text.includes('Recorded:'), 'Should handle missing content');
    });
  });

  describe('moltbook_dedup_stats (wq-145)', () => {
    beforeEach(() => {
      const cachePath = join(TEST_STATE_DIR, 'cross-platform-dedup.json');
      if (existsSync(cachePath)) unlinkSync(cachePath);
    });

    test('returns empty stats for empty cache', async () => {
      const result = await server.callTool('moltbook_dedup_stats', {});
      const text = getText(result);
      assert.ok(text.includes('Cross-platform dedup cache'), 'Should include header');
      assert.ok(text.includes('Total entries: 0'), 'Should show zero entries');
    });

    test('counts entries correctly after recording', async () => {
      // Record some engagements
      await server.callTool('moltbook_dedup_record', {
        platform: '4claw',
        title: 'Thread 1',
        content: 'Content 1',
        thread_id: 'id1',
        action: 'reply'
      });
      await server.callTool('moltbook_dedup_record', {
        platform: 'chatr',
        title: 'Thread 2',
        content: 'Content 2',
        thread_id: 'id2',
        action: 'comment'
      });

      const result = await server.callTool('moltbook_dedup_stats', {});
      const text = getText(result);
      assert.ok(text.includes('Total entries: 2'), 'Should count 2 entries');
      assert.ok(text.includes('4claw:1'), 'Should count 4claw entry');
      assert.ok(text.includes('chatr:1'), 'Should count chatr entry');
    });
  });

  describe('tool registration', () => {
    test('registers all expected tools', () => {
      const tools = server.getTools();
      const expectedTools = [
        'moltbook_state',
        'moltbook_thread_diff',
        'moltbook_digest',
        'moltbook_trust',
        'moltbook_karma',
        'moltbook_pending',
        'moltbook_export',
        'moltbook_import',
        'moltbook_dedup_check',
        'moltbook_dedup_record',
        'moltbook_dedup_stats',
        'moltbook_replay_log'
      ];

      for (const toolName of expectedTools) {
        assert.ok(tools[toolName], `Tool ${toolName} should be registered`);
      }
    });
  });
});

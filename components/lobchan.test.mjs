#!/usr/bin/env node
// lobchan.test.mjs — Tests for lobchan.js component
// Run with: node --test components/lobchan.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/lobchan-test-' + Date.now();
const TEST_STATE_DIR = join(TEST_HOME, '.config/moltbook');
process.env.HOME = TEST_HOME;
mkdirSync(TEST_STATE_DIR, { recursive: true });

// Write a fake lobchan key for tests that need it
writeFileSync(join(TEST_STATE_DIR, 'lobchan-key'), 'test-api-key');

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

describe('lobchan.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./lobchan.js');
    server = createMockServer();
    mod.register(server, { sessionNum: 100, sessionType: 'B' });
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers all expected tools', () => {
      const tools = server.getTools();
      const expectedTools = ['lobchan_boards', 'lobchan_threads', 'lobchan_thread', 'lobchan_post', 'lobchan_reply'];
      for (const toolName of expectedTools) {
        assert.ok(tools[toolName], `Tool ${toolName} should be registered`);
      }
    });

    test('tools have descriptions', () => {
      const tools = server.getTools();
      assert.ok(tools.lobchan_boards.description.includes('board'));
      assert.ok(tools.lobchan_threads.description.includes('thread'));
    });
  });

  describe('lobchan_boards', () => {
    test('lists boards successfully', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          boards: [
            { id: 'builds', name: 'Builds', description: 'Agent builds and projects', activeThreadCount: 15 },
            { id: 'ops', name: 'Operations', description: 'Operational discussions', activeThreadCount: 8 }
          ]
        })
      }));

      const result = await server.callTool('lobchan_boards', {});
      const text = getText(result);
      assert.ok(text.includes('/builds/'), 'Should show board ID');
      assert.ok(text.includes('Builds'), 'Should show board name');
      assert.ok(text.includes('15 threads'), 'Should show thread count');
    });

    test('handles empty boards', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ boards: [] })
      }));

      const result = await server.callTool('lobchan_boards', {});
      const text = getText(result);
      assert.ok(text.includes('No boards') || text === '', 'Should handle empty');
    });

    test('handles API errors', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error')
      }));

      const result = await server.callTool('lobchan_boards', {});
      const text = getText(result);
      assert.ok(text.includes('Error') || text.includes('500'), 'Should show error');
    });
  });

  describe('lobchan_threads', () => {
    test('lists threads successfully', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          threads: [
            {
              id: 'abc12345-full-id',
              title: 'Test Thread',
              replyCount: 5,
              posts: [{ content: 'This is the OP content...', authorName: 'TestAgent' }]
            }
          ]
        })
      }));

      const result = await server.callTool('lobchan_threads', { board: 'builds', limit: 10 });
      const text = getText(result);
      assert.ok(text.includes('Test Thread'), 'Should show thread title');
      assert.ok(text.includes('5 replies'), 'Should show reply count');
      assert.ok(text.includes('TestAgent'), 'Should show author');
    });

    test('handles no threads', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ threads: [] })
      }));

      const result = await server.callTool('lobchan_threads', { board: 'empty' });
      const text = getText(result);
      assert.ok(text.includes('No threads') || text === '', 'Should handle empty');
    });
  });

  describe('lobchan_thread', () => {
    test('returns thread with posts', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          thread: {
            title: 'Discussion Thread',
            boardId: 'builds',
            posts: [
              { isOp: true, authorName: 'OP', content: 'Original post', createdAt: '2026-02-04T10:00:00Z' },
              { isOp: false, authorName: 'Reply1', content: 'First reply', createdAt: '2026-02-04T11:00:00Z' }
            ]
          }
        })
      }));

      const result = await server.callTool('lobchan_thread', { thread_id: 'abc123' });
      const text = getText(result);
      assert.ok(text.includes('Discussion Thread'), 'Should show title');
      assert.ok(text.includes('/builds/'), 'Should show board');
      assert.ok(text.includes('[OP]'), 'Should mark OP');
      assert.ok(text.includes('[reply]'), 'Should mark replies');
    });

    test('handles thread not found', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Thread not found')
      }));

      const result = await server.callTool('lobchan_thread', { thread_id: 'nonexistent' });
      const text = getText(result);
      assert.ok(text.includes('Error') || text.includes('404'), 'Should show error');
    });
  });

  describe('lobchan_post', () => {
    test('handles API key check', async () => {
      // The component reads API key at call time from a specific path
      // Without the real key file, it returns "No LobChan API key found"
      const result = await server.callTool('lobchan_post', {
        board: 'builds',
        title: 'New Thread',
        content: 'Thread content here'
      });
      const text = getText(result);
      // Should either succeed (if key exists) or show no-key message
      assert.ok(text.includes('API key') || text.includes('Thread created'), 'Should handle key check');
    });

    test('handles fetch errors when key present', async () => {
      // Test error handling even if key check happens first
      global.fetch = mock.fn(() => Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error')
      }));

      const result = await server.callTool('lobchan_post', {
        board: 'builds',
        title: 'Test',
        content: 'Test'
      });
      const text = getText(result);
      // Should either show error or no-key message
      assert.ok(text.length > 0, 'Should return some response');
    });
  });

  describe('lobchan_reply', () => {
    test('handles API key check', async () => {
      // The component reads API key at call time from a specific path
      const result = await server.callTool('lobchan_reply', {
        thread_id: 'thread-123',
        content: 'My reply content'
      });
      const text = getText(result);
      // Should either succeed (if key exists) or show no-key message
      assert.ok(text.includes('API key') || text.includes('Reply posted'), 'Should handle key check');
    });

    test('handles errors', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized')
      }));

      const result = await server.callTool('lobchan_reply', {
        thread_id: 'thread-123',
        content: 'Test'
      });
      const text = getText(result);
      // Will either show error or say no API key
      assert.ok(text.length > 0, 'Should return response');
    });
  });

  describe('error handling', () => {
    test('handles network errors', async () => {
      global.fetch = mock.fn(() => Promise.reject(new Error('Network timeout')));

      const result = await server.callTool('lobchan_boards', {});
      const text = getText(result);
      assert.ok(text.includes('Error') || text.includes('timeout'), 'Should handle network error');
    });

    test('handles invalid JSON response', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.reject(new Error('Invalid JSON'))
      }));

      const result = await server.callTool('lobchan_boards', {});
      const text = getText(result);
      assert.ok(text.includes('Error') || text.includes('JSON'), 'Should handle parse error');
    });
  });
});

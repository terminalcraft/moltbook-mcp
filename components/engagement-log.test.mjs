#!/usr/bin/env node
// engagement-log.test.mjs — Tests for engagement-log.js component (B#224)
// Run with: node --test components/engagement-log.test.mjs

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs';

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

const TEST_LOG_PATH = '/tmp/test-engagement-actions.jsonl';

describe('engagement-log.js component', () => {
  let server;
  let originalEnv;

  before(async () => {
    // Save original env
    originalEnv = process.env.SESSION_NUM;
    process.env.SESSION_NUM = '224';

    // Dynamically replace the LOG_PATH in the module
    // Since we can't easily mock fs, we'll test the actual behavior but clean up
    const mod = await import('./engagement-log.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.SESSION_NUM = originalEnv;
    } else {
      delete process.env.SESSION_NUM;
    }
  });

  describe('tool registration', () => {
    test('registers log_engagement tool', () => {
      const tools = server.getTools();
      assert.ok(tools['log_engagement'], 'log_engagement should be registered');
    });

    test('tool has correct description', () => {
      const tools = server.getTools();
      assert.ok(
        tools['log_engagement'].description.includes('Log an engagement action'),
        'Description should mention logging engagement actions'
      );
    });
  });

  describe('log_engagement', () => {
    test('logs engagement with all fields', async () => {
      const result = await server.callTool('log_engagement', {
        platform: 'chatr',
        action: 'post',
        content: 'Hello world',
        target: 'thread-123'
      });
      const text = getText(result);
      assert.ok(text.includes('Logged: post on chatr'), 'Should confirm logging');
    });

    test('logs engagement without optional target', async () => {
      const result = await server.callTool('log_engagement', {
        platform: '4claw',
        action: 'upvote',
        content: 'upvoted post'
      });
      const text = getText(result);
      assert.ok(text.includes('Logged: upvote on 4claw'), 'Should confirm logging');
    });

    test('handles different action types', async () => {
      const actions = ['post', 'comment', 'reply', 'upvote', 'register', 'evaluate'];
      for (const action of actions) {
        const result = await server.callTool('log_engagement', {
          platform: 'test',
          action,
          content: `test ${action}`
        });
        const text = getText(result);
        assert.ok(text.includes(`Logged: ${action} on test`), `Should log ${action} action`);
      }
    });

    test('handles different platforms', async () => {
      const platforms = ['chatr', 'moltbook', '4claw', 'colony', 'tulip'];
      for (const platform of platforms) {
        const result = await server.callTool('log_engagement', {
          platform,
          action: 'test',
          content: 'test content'
        });
        const text = getText(result);
        assert.ok(text.includes(`on ${platform}`), `Should log on ${platform}`);
      }
    });
  });
});

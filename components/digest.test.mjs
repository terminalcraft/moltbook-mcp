#!/usr/bin/env node
// digest.test.mjs — Tests for digest.js component
// Run with: node --test components/digest.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/digest-test-' + Date.now();
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

describe('digest.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./digest.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers platform_digest tool', () => {
      const tools = server.getTools();
      assert.ok(tools['platform_digest'], 'platform_digest should be registered');
    });

    test('registers feed_read tool', () => {
      const tools = server.getTools();
      assert.ok(tools['feed_read'], 'feed_read should be registered');
    });
  });

  describe('platform_digest', () => {
    test('returns formatted digest summary', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          window: { hours: 24 },
          summary: {
            total_events: 42,
            build_entries: 5,
            new_tasks: 3,
            completed_tasks: 2,
            room_messages: 100,
            topic_messages: 50,
            new_polls: 1,
            active_polls: 2,
            registry_updates: 4,
            new_inbox: 0,
            event_breakdown: { 'task.created': 3, 'build.log': 5 }
          },
          builds: [],
          tasks: { new: [] },
          rooms: [],
          polls: { active: [] }
        })
      });

      const result = await server.callTool('platform_digest', {});
      const text = getText(result);

      assert.ok(text.includes('Platform Digest'), 'Should have title');
      assert.ok(text.includes('24h window'), 'Should show time window');
      assert.ok(text.includes('Events: 42'), 'Should show event count');
      assert.ok(text.includes('Builds: 5'), 'Should show build count');
      assert.ok(text.includes('Room msgs: 100'), 'Should show room messages');
      assert.ok(text.includes('task.created:3'), 'Should show event breakdown');
    });

    test('shows builds section when present', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          window: { hours: 24 },
          summary: {
            total_events: 10, build_entries: 2, new_tasks: 0, completed_tasks: 0,
            room_messages: 0, topic_messages: 0, new_polls: 0, active_polls: 0,
            registry_updates: 0, new_inbox: 0, event_breakdown: {}
          },
          builds: [
            { agent: 'testbot', version: '1.2.3', summary: 'Added new feature' },
            { agent: 'other', summary: 'Bug fix' }
          ],
          tasks: { new: [] },
          rooms: [],
          polls: { active: [] }
        })
      });

      const result = await server.callTool('platform_digest', {});
      const text = getText(result);

      assert.ok(text.includes('**Builds:**'), 'Should have builds section');
      assert.ok(text.includes('testbot v1.2.3: Added new feature'), 'Should show build with version');
      assert.ok(text.includes('other: Bug fix'), 'Should show build without version');
    });

    test('shows tasks section when present', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          window: { hours: 24 },
          summary: {
            total_events: 5, build_entries: 0, new_tasks: 2, completed_tasks: 1,
            room_messages: 0, topic_messages: 0, new_polls: 0, active_polls: 0,
            registry_updates: 0, new_inbox: 0, event_breakdown: {}
          },
          builds: [],
          tasks: {
            new: [
              { title: 'Review PR', creator: 'alice', status: 'pending' },
              { title: 'Deploy', creator: 'bob', status: 'in-progress' }
            ]
          },
          rooms: [],
          polls: { active: [] }
        })
      });

      const result = await server.callTool('platform_digest', {});
      const text = getText(result);

      assert.ok(text.includes('**New tasks:**'), 'Should have tasks section');
      assert.ok(text.includes('Review PR (by alice, pending)'), 'Should show task details');
    });

    test('shows rooms section when present', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          window: { hours: 24 },
          summary: {
            total_events: 0, build_entries: 0, new_tasks: 0, completed_tasks: 0,
            room_messages: 50, topic_messages: 0, new_polls: 0, active_polls: 0,
            registry_updates: 0, new_inbox: 0, event_breakdown: {}
          },
          builds: [],
          tasks: { new: [] },
          rooms: [
            { name: 'general', messages: 30, members: 10 },
            { name: 'builds', messages: 20, members: 5 }
          ],
          polls: { active: [] }
        })
      });

      const result = await server.callTool('platform_digest', {});
      const text = getText(result);

      assert.ok(text.includes('**Active rooms:**'), 'Should have rooms section');
      assert.ok(text.includes('general: 30 msgs, 10 members'), 'Should show room details');
    });

    test('shows polls section when present', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          window: { hours: 24 },
          summary: {
            total_events: 0, build_entries: 0, new_tasks: 0, completed_tasks: 0,
            room_messages: 0, topic_messages: 0, new_polls: 1, active_polls: 1,
            registry_updates: 0, new_inbox: 0, event_breakdown: {}
          },
          builds: [],
          tasks: { new: [] },
          rooms: [],
          polls: {
            active: [{ question: 'Best framework?', total_votes: 42 }]
          }
        })
      });

      const result = await server.callTool('platform_digest', {});
      const text = getText(result);

      assert.ok(text.includes('**Active polls:**'), 'Should have polls section');
      assert.ok(text.includes('Best framework? (42 votes)'), 'Should show poll details');
    });

    test('passes hours parameter', async () => {
      let capturedUrl = '';
      global.fetch = async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          json: async () => ({
            window: { hours: 48 },
            summary: { total_events: 0, build_entries: 0, new_tasks: 0, completed_tasks: 0,
              room_messages: 0, topic_messages: 0, new_polls: 0, active_polls: 0,
              registry_updates: 0, new_inbox: 0, event_breakdown: {} },
            builds: [], tasks: { new: [] }, rooms: [], polls: { active: [] }
          })
        };
      };

      await server.callTool('platform_digest', { hours: 48 });

      assert.ok(capturedUrl.includes('hours=48'), 'Should pass hours parameter');
    });

    test('handles API errors', async () => {
      global.fetch = async () => ({
        ok: false,
        json: async () => ({ error: 'Internal server error' })
      });

      const result = await server.callTool('platform_digest', {});
      const text = getText(result);

      assert.ok(text.includes('Failed'), 'Should indicate failure');
      assert.ok(text.includes('Internal server error'), 'Should show error');
    });

    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Connection refused'); };

      const result = await server.callTool('platform_digest', {});
      const text = getText(result);

      assert.ok(text.includes('Digest error'), 'Should indicate digest error');
      assert.ok(text.includes('Connection refused'), 'Should show error message');
    });
  });

  describe('feed_read', () => {
    test('returns formatted feed items', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          count: 2,
          sources: ['4claw', 'chatr'],
          items: [
            {
              source: '4claw',
              time: '2026-02-04T12:30:00Z',
              author: 'alice',
              title: 'New Feature',
              content: 'I just shipped a new feature...',
              replies: 5
            },
            {
              source: 'chatr',
              time: '2026-02-04T12:25:00Z',
              author: 'bob',
              content: 'Anyone working on MCP tools?'
            }
          ]
        })
      });

      const result = await server.callTool('feed_read', {});
      const text = getText(result);

      assert.ok(text.includes('Cross-Platform Feed'), 'Should have title');
      assert.ok(text.includes('2 items from 4claw, chatr'), 'Should show count and sources');
      assert.ok(text.includes('[4claw]'), 'Should show source');
      assert.ok(text.includes('alice'), 'Should show author');
      assert.ok(text.includes('(5r)'), 'Should show reply count');
      assert.ok(text.includes('**New Feature**'), 'Should show title');
    });

    test('shows empty feed message', async () => {
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ items: [], count: 0, sources: [] })
      });

      const result = await server.callTool('feed_read', {});
      const text = getText(result);

      assert.ok(text.includes('Feed empty'), 'Should show empty message');
    });

    test('filters by source', async () => {
      let capturedUrl = '';
      global.fetch = async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          json: async () => ({ items: [], count: 0, sources: [] })
        };
      };

      await server.callTool('feed_read', { source: 'chatr' });

      assert.ok(capturedUrl.includes('source=chatr'), 'Should pass source parameter');
    });

    test('respects limit parameter', async () => {
      let capturedUrl = '';
      global.fetch = async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          json: async () => ({ items: [], count: 0, sources: [] })
        };
      };

      await server.callTool('feed_read', { limit: 50 });

      assert.ok(capturedUrl.includes('limit=50'), 'Should pass limit parameter');
    });

    test('caps limit at 100', async () => {
      let capturedUrl = '';
      global.fetch = async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          json: async () => ({ items: [], count: 0, sources: [] })
        };
      };

      await server.callTool('feed_read', { limit: 200 });

      assert.ok(capturedUrl.includes('limit=100'), 'Should cap limit at 100');
    });

    test('handles API errors', async () => {
      global.fetch = async () => ({
        ok: false,
        json: async () => ({ error: 'Service unavailable' })
      });

      const result = await server.callTool('feed_read', {});
      const text = getText(result);

      assert.ok(text.includes('Feed error'), 'Should indicate feed error');
      assert.ok(text.includes('Service unavailable'), 'Should show error');
    });

    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Network timeout'); };

      const result = await server.callTool('feed_read', {});
      const text = getText(result);

      assert.ok(text.includes('Feed error'), 'Should indicate feed error');
      assert.ok(text.includes('Network timeout'), 'Should show error message');
    });

    test('truncates long content', async () => {
      const longContent = 'A'.repeat(200);
      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          count: 1,
          sources: ['test'],
          items: [{ source: 'test', time: '2026-02-04T12:00:00Z', author: 'x', content: longContent }]
        })
      });

      const result = await server.callTool('feed_read', {});
      const text = getText(result);

      assert.ok(text.length < longContent.length + 100, 'Should truncate long content');
    });
  });
});

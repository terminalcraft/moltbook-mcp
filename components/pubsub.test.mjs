#!/usr/bin/env node
// pubsub.test.mjs — Tests for pubsub.js component
// Run with: node --test components/pubsub.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

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

describe('pubsub.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./pubsub.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers topic_create tool', () => {
      const tools = server.getTools();
      assert.ok(tools.topic_create, 'topic_create tool should be registered');
    });

    test('registers topic_list tool', () => {
      const tools = server.getTools();
      assert.ok(tools.topic_list, 'topic_list tool should be registered');
    });

    test('registers topic_subscribe tool', () => {
      const tools = server.getTools();
      assert.ok(tools.topic_subscribe, 'topic_subscribe tool should be registered');
    });

    test('registers topic_unsubscribe tool', () => {
      const tools = server.getTools();
      assert.ok(tools.topic_unsubscribe, 'topic_unsubscribe tool should be registered');
    });

    test('registers topic_publish tool', () => {
      const tools = server.getTools();
      assert.ok(tools.topic_publish, 'topic_publish tool should be registered');
    });

    test('registers topic_read tool', () => {
      const tools = server.getTools();
      assert.ok(tools.topic_read, 'topic_read tool should be registered');
    });
  });

  describe('topic_create', () => {
    test('creates topic successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          topic: { name: 'test-topic', description: 'A test topic' }
        })
      }));

      const result = await server.callTool('topic_create', {
        name: 'test-topic',
        description: 'A test topic',
        creator: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('test-topic'), 'Result should contain topic name');
      assert.ok(text.includes('Created'), 'Result should indicate creation');
    });

    test('handles create failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Topic already exists' })
      }));

      const result = await server.callTool('topic_create', {
        name: 'existing-topic',
        creator: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
      assert.ok(text.includes('already exists'), 'Result should contain error message');
    });

    test('handles network error', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Network timeout');
      });

      const result = await server.callTool('topic_create', { name: 'offline-topic' });
      const text = getText(result);
      assert.ok(text.includes('Error'), 'Result should indicate error');
      assert.ok(text.includes('Network timeout'), 'Result should contain error message');
    });
  });

  describe('topic_list', () => {
    test('lists topics successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          count: 2,
          topics: [
            { name: 'topic-a', description: 'First topic', subscribers: 5, messageCount: 100, creator: 'agent1' },
            { name: 'topic-b', description: null, subscribers: 2, messageCount: 10, creator: 'agent2' }
          ]
        })
      }));

      const result = await server.callTool('topic_list', {});
      const text = getText(result);
      assert.ok(text.includes('2 topic'), 'Result should show topic count');
      assert.ok(text.includes('topic-a'), 'Result should contain first topic name');
      assert.ok(text.includes('topic-b'), 'Result should contain second topic name');
      assert.ok(text.includes('5 subs'), 'Result should show subscriber count');
    });

    test('handles empty topic list', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ count: 0, topics: [] })
      }));

      const result = await server.callTool('topic_list', {});
      const text = getText(result);
      assert.ok(text.includes('No topics'), 'Result should indicate no topics');
    });
  });

  describe('topic_subscribe', () => {
    test('subscribes to topic successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          subscribers: ['agent1', 'agent2', 'moltbook']
        })
      }));

      const result = await server.callTool('topic_subscribe', {
        topic: 'updates',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('Subscribed'), 'Result should indicate subscription');
      assert.ok(text.includes('moltbook'), 'Result should contain agent name');
      assert.ok(text.includes('updates'), 'Result should contain topic name');
      assert.ok(text.includes('3 total'), 'Result should show subscriber count');
    });

    test('handles subscription failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Topic not found' })
      }));

      const result = await server.callTool('topic_subscribe', {
        topic: 'nonexistent',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
    });
  });

  describe('topic_unsubscribe', () => {
    test('unsubscribes from topic successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({})
      }));

      const result = await server.callTool('topic_unsubscribe', {
        topic: 'updates',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('Unsubscribed'), 'Result should indicate unsubscription');
    });
  });

  describe('topic_publish', () => {
    test('publishes message successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          message: { id: 'msg-abc123def456' }
        })
      }));

      const result = await server.callTool('topic_publish', {
        topic: 'announcements',
        agent: 'moltbook',
        content: 'Hello world!'
      });

      const text = getText(result);
      assert.ok(text.includes('Published'), 'Result should indicate publication');
      assert.ok(text.includes('announcements'), 'Result should contain topic name');
      assert.ok(text.includes('msg-abc1'), 'Result should contain truncated message ID');
    });

    test('publishes with metadata', async () => {
      global.fetch = mock.fn(async (url, opts) => {
        const body = JSON.parse(opts.body);
        assert.ok(body.metadata, 'Request should include metadata');
        assert.equal(body.metadata.type, 'alert', 'Metadata should be passed correctly');
        return {
          ok: true,
          json: async () => ({ message: { id: 'msg-12345678' } })
        };
      });

      const result = await server.callTool('topic_publish', {
        topic: 'alerts',
        agent: 'moltbook',
        content: 'Critical alert!',
        metadata: { type: 'alert', priority: 'high' }
      });

      const text = getText(result);
      assert.ok(text.includes('Published'), 'Result should indicate publication');
    });

    test('handles publish failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Not authorized to publish' })
      }));

      const result = await server.callTool('topic_publish', {
        topic: 'private',
        agent: 'unauthorized',
        content: 'Test'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
    });
  });

  describe('topic_read', () => {
    test('reads messages successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          count: 2,
          totalMessages: 50,
          messages: [
            { ts: '2026-02-04T10:30:00Z', agent: 'agent1', content: 'First message' },
            { ts: '2026-02-04T10:31:00Z', agent: 'agent2', content: 'Second message' }
          ]
        })
      }));

      const result = await server.callTool('topic_read', { topic: 'general' });
      const text = getText(result);
      assert.ok(text.includes('2 message'), 'Result should show message count');
      assert.ok(text.includes('50 total'), 'Result should show total messages');
      assert.ok(text.includes('agent1'), 'Result should contain agent name');
      assert.ok(text.includes('First message'), 'Result should contain message content');
    });

    test('reads with since parameter', async () => {
      global.fetch = mock.fn(async (url) => {
        assert.ok(url.includes('since='), 'URL should contain since parameter');
        return {
          ok: true,
          json: async () => ({ count: 0, totalMessages: 100, messages: [] })
        };
      });

      const result = await server.callTool('topic_read', {
        topic: 'general',
        since: '2026-02-04T00:00:00Z'
      });

      const text = getText(result);
      assert.ok(text.includes('No new messages'), 'Result should indicate no new messages');
    });

    test('truncates long messages', async () => {
      const longContent = 'A'.repeat(300);
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          count: 1,
          totalMessages: 1,
          messages: [{ ts: '2026-02-04T12:00:00Z', agent: 'verbose', content: longContent }]
        })
      }));

      const result = await server.callTool('topic_read', { topic: 'verbose' });
      const text = getText(result);
      assert.ok(text.includes('...'), 'Result should truncate long messages');
      assert.ok(text.length < longContent.length + 200, 'Output should be shorter than full content');
    });

    test('handles read failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Topic not found' })
      }));

      const result = await server.callTool('topic_read', { topic: 'nonexistent' });
      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
    });
  });
});

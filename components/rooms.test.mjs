#!/usr/bin/env node
// rooms.test.mjs — Tests for rooms.js component
// Run with: node --test components/rooms.test.mjs

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

describe('rooms.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./rooms.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers room_create tool', () => {
      const tools = server.getTools();
      assert.ok(tools.room_create, 'room_create tool should be registered');
    });

    test('registers room_list tool', () => {
      const tools = server.getTools();
      assert.ok(tools.room_list, 'room_list tool should be registered');
    });

    test('registers room_join tool', () => {
      const tools = server.getTools();
      assert.ok(tools.room_join, 'room_join tool should be registered');
    });

    test('registers room_leave tool', () => {
      const tools = server.getTools();
      assert.ok(tools.room_leave, 'room_leave tool should be registered');
    });

    test('registers room_send tool', () => {
      const tools = server.getTools();
      assert.ok(tools.room_send, 'room_send tool should be registered');
    });

    test('registers room_read tool', () => {
      const tools = server.getTools();
      assert.ok(tools.room_read, 'room_read tool should be registered');
    });
  });

  describe('room_create', () => {
    test('creates room successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ room: 'agent-lounge' })
      }));

      const result = await server.callTool('room_create', {
        name: 'agent-lounge',
        creator: 'moltbook',
        description: 'Casual chat room'
      });

      const text = getText(result);
      assert.ok(text.includes('Created room'), 'Result should indicate creation');
      assert.ok(text.includes('agent-lounge'), 'Result should contain room name');
    });

    test('creates room with max_members', async () => {
      global.fetch = mock.fn(async (url, opts) => {
        const body = JSON.parse(opts.body);
        assert.equal(body.max_members, 10, 'Request should include max_members');
        return {
          ok: true,
          json: async () => ({ room: 'small-room' })
        };
      });

      const result = await server.callTool('room_create', {
        name: 'small-room',
        creator: 'moltbook',
        max_members: 10
      });

      const text = getText(result);
      assert.ok(text.includes('Created'), 'Result should indicate creation');
    });

    test('handles create failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Room name already taken' })
      }));

      const result = await server.callTool('room_create', {
        name: 'existing-room',
        creator: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
      assert.ok(text.includes('already taken'), 'Result should contain error message');
    });

    test('handles network error', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Connection refused');
      });

      const result = await server.callTool('room_create', {
        name: 'test-room',
        creator: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('error'), 'Result should indicate error');
      assert.ok(text.includes('Connection refused'), 'Result should contain error message');
    });
  });

  describe('room_list', () => {
    test('lists rooms successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ([
          { name: 'general', members: 5, max_members: 50, messageCount: 100, description: 'General chat' },
          { name: 'dev', members: 3, max_members: 20, messageCount: 50, description: null }
        ])
      }));

      const result = await server.callTool('room_list', {});
      const text = getText(result);
      assert.ok(text.includes('2 room'), 'Result should show room count');
      assert.ok(text.includes('general'), 'Result should contain first room name');
      assert.ok(text.includes('dev'), 'Result should contain second room name');
      assert.ok(text.includes('5/50 members'), 'Result should show member count');
      assert.ok(text.includes('no description'), 'Result should handle null description');
    });

    test('handles empty room list', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ([])
      }));

      const result = await server.callTool('room_list', {});
      const text = getText(result);
      assert.ok(text.includes('No rooms'), 'Result should indicate no rooms');
    });
  });

  describe('room_join', () => {
    test('joins room successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ members: 6 })
      }));

      const result = await server.callTool('room_join', {
        name: 'general',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('Joined'), 'Result should indicate joining');
      assert.ok(text.includes('general'), 'Result should contain room name');
      assert.ok(text.includes('6 members'), 'Result should show member count');
    });

    test('handles join failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Room is full' })
      }));

      const result = await server.callTool('room_join', {
        name: 'full-room',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
      assert.ok(text.includes('full'), 'Result should contain error message');
    });
  });

  describe('room_leave', () => {
    test('leaves room successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ members: 4 })
      }));

      const result = await server.callTool('room_leave', {
        name: 'general',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('Left'), 'Result should indicate leaving');
      assert.ok(text.includes('general'), 'Result should contain room name');
      assert.ok(text.includes('4 members'), 'Result should show remaining members');
    });

    test('handles leave failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Not a member' })
      }));

      const result = await server.callTool('room_leave', {
        name: 'other-room',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
    });
  });

  describe('room_send', () => {
    test('sends message successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ id: 'msg-789xyz' })
      }));

      const result = await server.callTool('room_send', {
        name: 'general',
        agent: 'moltbook',
        body: 'Hello everyone!'
      });

      const text = getText(result);
      assert.ok(text.includes('Message sent'), 'Result should indicate message sent');
      assert.ok(text.includes('general'), 'Result should contain room name');
      assert.ok(text.includes('msg-789xyz'), 'Result should contain message ID');
    });

    test('handles send failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Must be a member to send' })
      }));

      const result = await server.callTool('room_send', {
        name: 'private-room',
        agent: 'outsider',
        body: 'Hello?'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
    });
  });

  describe('room_read', () => {
    test('reads room with messages', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'general',
          description: 'General discussion',
          members: ['agent1', 'agent2', 'moltbook'],
          messageCount: 100,
          messages: [
            { ts: '2026-02-04T10:00:00Z', agent: 'agent1', body: 'Hello!' },
            { ts: '2026-02-04T10:01:00Z', agent: 'agent2', body: 'Hi there!' }
          ]
        })
      }));

      const result = await server.callTool('room_read', { name: 'general' });
      const text = getText(result);
      assert.ok(text.includes('general'), 'Result should contain room name');
      assert.ok(text.includes('3 members'), 'Result should show member count');
      assert.ok(text.includes('General discussion'), 'Result should contain description');
      assert.ok(text.includes('agent1'), 'Result should contain agent names');
      assert.ok(text.includes('Hello!'), 'Result should contain message body');
    });

    test('reads room with no messages', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          name: 'empty-room',
          description: null,
          members: ['moltbook'],
          messageCount: 0,
          messages: []
        })
      }));

      const result = await server.callTool('room_read', { name: 'empty-room' });
      const text = getText(result);
      assert.ok(text.includes('No messages'), 'Result should indicate no messages');
    });

    test('handles room not found', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Room not found' })
      }));

      const result = await server.callTool('room_read', { name: 'nonexistent' });
      const text = getText(result);
      assert.ok(text.includes('not found'), 'Result should indicate room not found');
    });

    test('reads with limit parameter', async () => {
      global.fetch = mock.fn(async (url) => {
        assert.ok(url.includes('limit='), 'URL should contain limit parameter');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'busy-room',
            members: ['a', 'b'],
            messageCount: 1000,
            messages: [{ ts: '2026-02-04T12:00:00Z', agent: 'a', body: 'Latest' }]
          })
        };
      });

      await server.callTool('room_read', { name: 'busy-room', limit: 1 });
    });

    test('reads with since parameter', async () => {
      global.fetch = mock.fn(async (url) => {
        assert.ok(url.includes('since='), 'URL should contain since parameter');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: 'general',
            members: ['a'],
            messageCount: 50,
            messages: []
          })
        };
      });

      await server.callTool('room_read', { name: 'general', since: '2026-02-04T00:00:00Z' });
    });
  });
});

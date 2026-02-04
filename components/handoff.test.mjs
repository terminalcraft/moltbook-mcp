#!/usr/bin/env node
// handoff.test.mjs — Tests for handoff.js component
// Run with: node --test components/handoff.test.mjs

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

describe('handoff.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./handoff.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers handoff_create tool', () => {
      const tools = server.getTools();
      assert.ok(tools.handoff_create, 'handoff_create tool should be registered');
    });

    test('registers handoff_latest tool', () => {
      const tools = server.getTools();
      assert.ok(tools.handoff_latest, 'handoff_latest tool should be registered');
    });

    test('registers handoff_list tool', () => {
      const tools = server.getTools();
      assert.ok(tools.handoff_list, 'handoff_list tool should be registered');
    });
  });

  describe('handoff_create', () => {
    test('creates basic handoff successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          id: 'handoff-001',
          size: 256,
          created: '2026-02-04T12:00:00Z'
        })
      }));

      const result = await server.callTool('handoff_create', {
        handle: 'moltbook',
        summary: 'Completed wq-179 test work'
      });

      const text = getText(result);
      assert.ok(text.includes('Handoff created'), 'Result should indicate creation');
      assert.ok(text.includes('handoff-001'), 'Result should contain ID');
      assert.ok(text.includes('256B'), 'Result should contain size');
    });

    test('creates handoff with all fields', async () => {
      global.fetch = mock.fn(async (url, opts) => {
        const body = JSON.parse(opts.body);
        assert.equal(body.session_id, 's884', 'Session ID should be passed');
        assert.deepEqual(body.goals, ['finish testing'], 'Goals should be passed');
        assert.deepEqual(body.next_steps, ['review coverage'], 'Next steps should be passed');
        assert.ok(body.context, 'Context should be passed');
        assert.ok(body.state, 'State should be passed');
        assert.deepEqual(body.tags, ['testing', 'urgent'], 'Tags should be passed');
        return {
          ok: true,
          json: async () => ({ id: 'handoff-002', size: 512, created: '2026-02-04T12:00:00Z' })
        };
      });

      await server.callTool('handoff_create', {
        handle: 'moltbook',
        summary: 'Test session',
        session_id: 's884',
        goals: ['finish testing'],
        context: { coverage: '73%' },
        next_steps: ['review coverage'],
        state: { lastFile: 'tasks.js' },
        tags: ['testing', 'urgent']
      });
    });

    test('handles create failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Quota exceeded' })
      }));

      const result = await server.callTool('handoff_create', {
        handle: 'moltbook',
        summary: 'Test'
      });

      const text = getText(result);
      assert.ok(text.includes('Error'), 'Result should indicate error');
      assert.ok(text.includes('Quota exceeded'), 'Result should contain error message');
    });

    test('handles network error', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Connection refused');
      });

      const result = await server.callTool('handoff_create', {
        handle: 'moltbook',
        summary: 'Test'
      });

      const text = getText(result);
      assert.ok(text.includes('error'), 'Result should indicate error');
    });
  });

  describe('handoff_latest', () => {
    test('retrieves latest handoff successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          handle: 'moltbook',
          session_id: 's883',
          summary: 'Built test infrastructure',
          goals: ['increase coverage', 'document patterns'],
          next_steps: ['continue wq-179', 'update notes'],
          context: { testsAdded: 65 },
          state: { component: 'tasks.js' },
          tags: ['testing'],
          created: '2026-02-04T11:00:00Z'
        })
      }));

      const result = await server.callTool('handoff_latest', { handle: 'moltbook' });
      const text = getText(result);
      assert.ok(text.includes('Handoff from moltbook'), 'Result should have header');
      assert.ok(text.includes('s883'), 'Result should contain session ID');
      assert.ok(text.includes('Built test infrastructure'), 'Result should contain summary');
      assert.ok(text.includes('increase coverage'), 'Result should contain goals');
      assert.ok(text.includes('continue wq-179'), 'Result should contain next steps');
      assert.ok(text.includes('testsAdded'), 'Result should contain context');
      assert.ok(text.includes('testing'), 'Result should contain tags');
    });

    test('handles no handoffs found', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        status: 404
      }));

      const result = await server.callTool('handoff_latest', { handle: 'newagent' });
      const text = getText(result);
      assert.ok(text.includes('No handoffs found'), 'Result should indicate no handoffs');
      assert.ok(text.includes('newagent'), 'Result should contain handle');
    });

    test('handles minimal handoff', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          handle: 'moltbook',
          summary: 'Quick session',
          created: '2026-02-04T10:00:00Z'
        })
      }));

      const result = await server.callTool('handoff_latest', { handle: 'moltbook' });
      const text = getText(result);
      assert.ok(text.includes('Quick session'), 'Result should contain summary');
      assert.ok(!text.includes('Goals:') || !text.includes('undefined'), 'Result should not have undefined fields');
    });
  });

  describe('handoff_list', () => {
    test('lists all agents with handoffs', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ([
          { handle: 'agent1', count: 5, latest: '2026-02-04T12:00:00Z' },
          { handle: 'agent2', count: 3, latest: '2026-02-04T10:00:00Z' }
        ])
      }));

      const result = await server.callTool('handoff_list', {});
      const text = getText(result);
      assert.ok(text.includes('Agent handoffs'), 'Result should have header');
      assert.ok(text.includes('agent1'), 'Result should contain first agent');
      assert.ok(text.includes('5 handoff'), 'Result should show count');
      assert.ok(text.includes('agent2'), 'Result should contain second agent');
    });

    test('lists handoffs for specific agent', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ([
          { id: 'h-001', session_id: 's882', summary: 'First session with long summary that gets truncated', created: '2026-02-04T09:00:00Z' },
          { id: 'h-002', session_id: null, summary: 'Second session', created: '2026-02-04T10:00:00Z' }
        ])
      }));

      const result = await server.callTool('handoff_list', { handle: 'moltbook' });
      const text = getText(result);
      assert.ok(text.includes('Handoffs for moltbook'), 'Result should have handle header');
      assert.ok(text.includes('h-001'), 'Result should contain first handoff ID');
      assert.ok(text.includes('s882'), 'Result should show session ID');
      assert.ok(text.includes('no session'), 'Result should handle null session ID');
    });

    test('handles empty list for all agents', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ([])
      }));

      const result = await server.callTool('handoff_list', {});
      const text = getText(result);
      assert.ok(text.includes('No handoffs stored'), 'Result should indicate empty');
    });

    test('handles empty list for specific agent', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ([])
      }));

      const result = await server.callTool('handoff_list', { handle: 'newagent' });
      const text = getText(result);
      assert.ok(text.includes('No handoffs for newagent'), 'Result should indicate no handoffs');
    });
  });
});

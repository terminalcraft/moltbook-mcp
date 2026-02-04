#!/usr/bin/env node
// tasks.test.mjs — Tests for tasks.js component
// Run with: node --test components/tasks.test.mjs

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

describe('tasks.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./tasks.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers task_create tool', () => {
      const tools = server.getTools();
      assert.ok(tools.task_create, 'task_create tool should be registered');
    });

    test('registers task_list tool', () => {
      const tools = server.getTools();
      assert.ok(tools.task_list, 'task_list tool should be registered');
    });

    test('registers task_claim tool', () => {
      const tools = server.getTools();
      assert.ok(tools.task_claim, 'task_claim tool should be registered');
    });

    test('registers task_done tool', () => {
      const tools = server.getTools();
      assert.ok(tools.task_done, 'task_done tool should be registered');
    });

    test('registers task_verify tool', () => {
      const tools = server.getTools();
      assert.ok(tools.task_verify, 'task_verify tool should be registered');
    });

    test('registers task_cancel tool', () => {
      const tools = server.getTools();
      assert.ok(tools.task_cancel, 'task_cancel tool should be registered');
    });
  });

  describe('task_create', () => {
    test('creates task successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          task: { id: 'task-001', title: 'Review PR', priority: 'high' }
        })
      }));

      const result = await server.callTool('task_create', {
        from: 'moltbook',
        title: 'Review PR',
        priority: 'high'
      });

      const text = getText(result);
      assert.ok(text.includes('Created task'), 'Result should indicate creation');
      assert.ok(text.includes('task-001'), 'Result should contain task ID');
      assert.ok(text.includes('Review PR'), 'Result should contain title');
      assert.ok(text.includes('high'), 'Result should contain priority');
    });

    test('creates task with capabilities', async () => {
      global.fetch = mock.fn(async (url, opts) => {
        const body = JSON.parse(opts.body);
        assert.deepEqual(body.capabilities_needed, ['python', 'testing'], 'Capabilities should be passed');
        return {
          ok: true,
          json: async () => ({
            task: { id: 'task-002', title: 'Write tests', priority: 'medium' }
          })
        };
      });

      await server.callTool('task_create', {
        from: 'moltbook',
        title: 'Write tests',
        description: 'Need tests for the new module',
        capabilities_needed: ['python', 'testing']
      });
    });

    test('handles create failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Invalid priority' })
      }));

      const result = await server.callTool('task_create', {
        from: 'moltbook',
        title: 'Test',
        priority: 'urgent'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
    });

    test('handles network error', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Connection refused');
      });

      const result = await server.callTool('task_create', {
        from: 'moltbook',
        title: 'Test'
      });

      const text = getText(result);
      assert.ok(text.includes('error'), 'Result should indicate error');
    });
  });

  describe('task_list', () => {
    test('lists tasks successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          total: 2,
          tasks: [
            { id: 'task-001', title: 'Review PR', status: 'open', priority: 'high', from: 'alice', claimed_by: null, capabilities_needed: ['code-review'] },
            { id: 'task-002', title: 'Fix bug', status: 'claimed', priority: 'medium', from: 'bob', claimed_by: 'charlie', capabilities_needed: [] }
          ]
        })
      }));

      const result = await server.callTool('task_list', {});
      const text = getText(result);
      assert.ok(text.includes('2 task'), 'Result should show task count');
      assert.ok(text.includes('task-001'), 'Result should contain first task ID');
      assert.ok(text.includes('Review PR'), 'Result should contain first title');
      assert.ok(text.includes('open'), 'Result should contain status');
      assert.ok(text.includes('code-review'), 'Result should show capabilities');
      assert.ok(text.includes('→ charlie'), 'Result should show claimer');
    });

    test('lists with status filter', async () => {
      global.fetch = mock.fn(async (url) => {
        assert.ok(url.includes('status=open'), 'URL should contain status filter');
        return {
          ok: true,
          json: async () => ({ total: 0, tasks: [] })
        };
      });

      await server.callTool('task_list', { status: 'open' });
    });

    test('lists with capability filter', async () => {
      global.fetch = mock.fn(async (url) => {
        assert.ok(url.includes('capability=python'), 'URL should contain capability filter');
        return {
          ok: true,
          json: async () => ({ total: 0, tasks: [] })
        };
      });

      await server.callTool('task_list', { capability: 'python' });
    });

    test('handles empty list', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ total: 0, tasks: [] })
      }));

      const result = await server.callTool('task_list', {});
      const text = getText(result);
      assert.ok(text.includes('No tasks found'), 'Result should indicate empty');
    });
  });

  describe('task_claim', () => {
    test('claims task successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          task: { id: 'task-001', title: 'Review PR' }
        })
      }));

      const result = await server.callTool('task_claim', {
        id: 'task-001',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('Claimed task'), 'Result should indicate claim');
      assert.ok(text.includes('task-001'), 'Result should contain task ID');
    });

    test('handles claim failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Task already claimed' })
      }));

      const result = await server.callTool('task_claim', {
        id: 'task-001',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
      assert.ok(text.includes('already claimed'), 'Result should contain error');
    });
  });

  describe('task_done', () => {
    test('marks task done successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          task: { id: 'task-001', title: 'Review PR' }
        })
      }));

      const result = await server.callTool('task_done', {
        id: 'task-001',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('Completed task'), 'Result should indicate completion');
    });

    test('marks done with result notes', async () => {
      global.fetch = mock.fn(async (url, opts) => {
        const body = JSON.parse(opts.body);
        assert.ok(body.result, 'Result should be passed');
        return {
          ok: true,
          json: async () => ({
            task: { id: 'task-001', title: 'Review PR' }
          })
        };
      });

      await server.callTool('task_done', {
        id: 'task-001',
        agent: 'moltbook',
        result: 'PR approved and merged'
      });
    });

    test('handles done failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Not the claimer' })
      }));

      const result = await server.callTool('task_done', {
        id: 'task-001',
        agent: 'wrongagent'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
    });
  });

  describe('task_verify', () => {
    test('verifies and accepts task successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          message: 'Task verified and accepted',
          task: { id: 'task-001', title: 'Review PR', claimed_by: 'helper' },
          receipt: { id: 'receipt-xyz', attester: 'moltbook' }
        })
      }));

      const result = await server.callTool('task_verify', {
        id: 'task-001',
        agent: 'moltbook',
        accepted: true
      });

      const text = getText(result);
      assert.ok(text.includes('verified'), 'Result should mention verification');
      assert.ok(text.includes('Receipt'), 'Result should mention receipt');
      assert.ok(text.includes('receipt-xyz'), 'Result should contain receipt ID');
    });

    test('verifies and rejects task', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          message: 'Task rejected, reverted to claimed',
          task: {
            id: 'task-001',
            comments: [{ text: 'Needs more work', from: 'moltbook' }]
          }
        })
      }));

      const result = await server.callTool('task_verify', {
        id: 'task-001',
        agent: 'moltbook',
        accepted: false,
        comment: 'Needs more work'
      });

      const text = getText(result);
      assert.ok(text.includes('rejected') || text.includes('Rejection'), 'Result should indicate rejection');
      assert.ok(text.includes('Needs more work'), 'Result should show rejection note');
    });

    test('handles verify failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Not the task creator' })
      }));

      const result = await server.callTool('task_verify', {
        id: 'task-001',
        agent: 'imposter',
        accepted: true
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
    });
  });

  describe('task_cancel', () => {
    test('cancels task successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          task: { id: 'task-001', title: 'Review PR' }
        })
      }));

      const result = await server.callTool('task_cancel', {
        id: 'task-001',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('Cancelled task'), 'Result should indicate cancellation');
      assert.ok(text.includes('task-001'), 'Result should contain task ID');
    });

    test('handles cancel failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Cannot cancel claimed task' })
      }));

      const result = await server.callTool('task_cancel', {
        id: 'task-001',
        agent: 'moltbook'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
    });
  });
});

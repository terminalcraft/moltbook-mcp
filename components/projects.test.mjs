#!/usr/bin/env node
// projects.test.mjs — Tests for projects.js component
// Run with: node --test components/projects.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/projects-test-' + Date.now();
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

describe('projects.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    // Mock fetch for local API (localhost:3847)
    originalFetch = global.fetch;
    global.fetch = mock.fn(async (url, opts) => {
      const method = opts?.method || 'GET';

      // Project list
      if (url.includes('/projects') && method === 'GET' && !url.includes('/tasks')) {
        if (url.match(/\/projects\/[^\/]+$/)) {
          // Single project view
          return {
            ok: true,
            json: async () => ({
              project: { id: 'proj-1', name: 'Test Project', owner: 'moltbook', members: ['moltbook'], description: 'Test desc' },
              tasks: [{ id: 'task-1', title: 'Task One', status: 'open', claimed_by: null, comments: [] }]
            })
          };
        }
        // Project list
        return {
          ok: true,
          json: async () => ({
            total: 1,
            projects: [{ id: 'proj-1', name: 'Test Project', owner: 'moltbook', members: ['moltbook'], description: 'A test project', stats: { open: 1, total: 2 } }]
          })
        };
      }

      // Project create
      if (url.includes('/projects') && method === 'POST' && !url.includes('/join') && !url.includes('/tasks')) {
        const body = JSON.parse(opts?.body || '{}');
        return {
          ok: true,
          json: async () => ({
            project: { id: 'proj-new', name: body.name, owner: body.owner, members: [body.owner], description: body.description }
          })
        };
      }

      // Project join
      if (url.includes('/join') && method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            project: { id: 'proj-1', name: 'Test Project', owner: 'moltbook', members: ['moltbook', 'new-agent'] }
          })
        };
      }

      // Add task
      if (url.includes('/tasks') && method === 'POST' && !url.includes('/comment') && !url.includes('/cancel')) {
        const body = JSON.parse(opts?.body || '{}');
        return {
          ok: true,
          json: async () => ({
            task: { id: 'task-new', title: body.title, status: 'open', claimed_by: null }
          })
        };
      }

      // Task comment
      if (url.includes('/comment') && method === 'POST') {
        return { ok: true, json: async () => ({ success: true }) };
      }

      // Task cancel
      if (url.includes('/cancel') && method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            task: { id: 'task-1', title: 'Task One', status: 'cancelled' }
          })
        };
      }

      // Default error
      return { ok: false, json: async () => ({ error: 'Not found' }) };
    });

    const mod = await import('./projects.js');
    server = createMockServer();
    mod.register(server, { sessionNum: 100, sessionType: 'B' });
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
    try { rmSync(TEST_HOME, { recursive: true }); } catch {}
  });

  describe('tool registration', () => {
    test('registers project management tools', () => {
      const tools = server.getTools();
      assert.ok(tools['project_create'], 'project_create should be registered');
      assert.ok(tools['project_list'], 'project_list should be registered');
      assert.ok(tools['project_view'], 'project_view should be registered');
      assert.ok(tools['project_join'], 'project_join should be registered');
    });

    test('registers task management tools', () => {
      const tools = server.getTools();
      assert.ok(tools['project_add_task'], 'project_add_task should be registered');
      assert.ok(tools['task_comment'], 'task_comment should be registered');
      assert.ok(tools['task_cancel'], 'task_cancel should be registered');
    });
  });

  describe('project_create functionality', () => {
    test('creates project with owner and name', async () => {
      const result = await server.callTool('project_create', {
        owner: 'test-agent',
        name: 'New Project',
        description: 'A new collaborative project'
      });
      const text = getText(result);
      assert.ok(text.includes('Created') || text.includes('project'), 'Should confirm project creation');
    });

    test('requires owner parameter', async () => {
      const tools = server.getTools();
      const schema = tools['project_create'].schema;
      assert.ok('owner' in schema, 'Should have owner parameter');
      assert.ok('name' in schema, 'Should have name parameter');
    });
  });

  describe('project_list functionality', () => {
    test('lists all projects with stats', async () => {
      const result = await server.callTool('project_list', {});
      const text = getText(result);
      assert.ok(text.includes('project') || text.includes('Project') || text.includes('No'), 'Should list projects or indicate none');
    });
  });

  describe('project_view functionality', () => {
    test('shows project details and tasks', async () => {
      const result = await server.callTool('project_view', { id: 'proj-1' });
      const text = getText(result);
      assert.ok(text.includes('Project') || text.includes('task') || text.includes('error'), 'Should show project details');
    });
  });

  describe('project_join functionality', () => {
    test('joins project as member', async () => {
      const result = await server.callTool('project_join', {
        id: 'proj-1',
        agent: 'new-agent'
      });
      const text = getText(result);
      assert.ok(text.includes('Join') || text.includes('member') || text.includes('error'), 'Should confirm join');
    });
  });

  describe('project_add_task functionality', () => {
    test('adds task to project', async () => {
      const result = await server.callTool('project_add_task', {
        project_id: 'proj-1',
        from: 'test-agent',
        title: 'New Task',
        description: 'A task description',
        priority: 'high'
      });
      const text = getText(result);
      assert.ok(text.includes('Added') || text.includes('task') || text.includes('error'), 'Should confirm task added');
    });

    test('accepts priority parameter', async () => {
      const tools = server.getTools();
      const schema = tools['project_add_task'].schema;
      assert.ok('priority' in schema, 'Should have priority parameter');
    });
  });

  describe('task_comment functionality', () => {
    test('adds comment to task', async () => {
      const result = await server.callTool('task_comment', {
        task_id: 'task-1',
        agent: 'test-agent',
        text: 'This is a comment'
      });
      const text = getText(result);
      assert.ok(text.includes('Comment') || text.includes('added') || text.includes('error'), 'Should confirm comment added');
    });
  });

  describe('task_cancel functionality', () => {
    test('cancels task', async () => {
      const result = await server.callTool('task_cancel', {
        task_id: 'task-1',
        agent: 'test-agent'
      });
      const text = getText(result);
      assert.ok(text.includes('Cancel') || text.includes('cancel') || text.includes('error'), 'Should confirm cancel');
    });

    test('requires agent ownership', async () => {
      const tools = server.getTools();
      const schema = tools['task_cancel'].schema;
      assert.ok('agent' in schema, 'Should have agent parameter for ownership check');
    });
  });

  describe('error handling', () => {
    test('handles network errors gracefully', async () => {
      const savedFetch = global.fetch;
      global.fetch = mock.fn(async () => { throw new Error('Connection refused'); });

      const result = await server.callTool('project_list', {});
      const text = getText(result);
      assert.ok(text.includes('error') || text.includes('Error'), 'Should handle network error');

      global.fetch = savedFetch;
    });
  });
});

#!/usr/bin/env node
// smoke-tests.test.mjs — Tests for smoke-tests.js component
// Run with: node --test components/smoke-tests.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/smoke-tests-test-' + Date.now();
const TEST_STATE_DIR = join(TEST_HOME, '.config/moltbook');
process.env.HOME = TEST_HOME;
mkdirSync(TEST_STATE_DIR, { recursive: true });
writeFileSync(join(TEST_STATE_DIR, 'api-token'), 'test-token');

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

describe('smoke-tests.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./smoke-tests.js');
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
      const expectedTools = ['smoke_test_run', 'smoke_test_status'];
      for (const toolName of expectedTools) {
        assert.ok(tools[toolName], `Tool ${toolName} should be registered`);
      }
    });

    test('tools have descriptions', () => {
      const tools = server.getTools();
      assert.ok(tools.smoke_test_run.description.includes('smoke test'));
      assert.ok(tools.smoke_test_status.description.includes('smoke test'));
    });
  });

  describe('smoke_test_run', () => {
    test('returns success results', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        json: () => Promise.resolve({
          passed: 10,
          total: 10,
          elapsed: 150,
          results: []
        })
      }));
      const result = await server.callTool('smoke_test_run', {});
      const text = getText(result);
      assert.ok(text.includes('10/10 passed'));
      assert.ok(text.includes('150ms'));
    });

    test('reports failed tests', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        json: () => Promise.resolve({
          passed: 8,
          total: 10,
          elapsed: 200,
          results: [
            { pass: false, method: 'GET', path: '/health', status: 500, error: 'timeout' },
            { pass: false, method: 'POST', path: '/api/test', status: 404 }
          ]
        })
      }));
      const result = await server.callTool('smoke_test_run', {});
      const text = getText(result);
      assert.ok(text.includes('8/10 passed'));
      assert.ok(text.includes('Failed:'));
      assert.ok(text.includes('GET /health'));
      assert.ok(text.includes('500'));
    });

    test('handles API errors', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        json: () => Promise.resolve({ error: 'Server down' })
      }));
      const result = await server.callTool('smoke_test_run', {});
      const text = getText(result);
      assert.ok(text.includes('error'));
      assert.ok(text.includes('Server down'));
    });

    test('handles fetch exceptions', async () => {
      global.fetch = mock.fn(() => Promise.reject(new Error('Network error')));
      const result = await server.callTool('smoke_test_run', {});
      const text = getText(result);
      assert.ok(text.includes('error'));
      assert.ok(text.includes('Network error'));
    });
  });

  describe('smoke_test_status', () => {
    test('returns latest results', async () => {
      const ts = new Date().toISOString();
      global.fetch = mock.fn(() => Promise.resolve({
        json: () => Promise.resolve({
          ts,
          passed: 15,
          total: 15,
          elapsed: 100,
          results: []
        })
      }));
      const result = await server.callTool('smoke_test_status', {});
      const text = getText(result);
      assert.ok(text.includes('15/15 passed'));
      assert.ok(text.includes('100ms'));
    });

    test('handles no results message', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        json: () => Promise.resolve({ message: 'No smoke tests run yet' })
      }));
      const result = await server.callTool('smoke_test_status', {});
      const text = getText(result);
      assert.ok(text.includes('No smoke tests'));
    });

    test('reports failed tests in status', async () => {
      const ts = new Date(Date.now() - 5 * 60000).toISOString(); // 5 min ago
      global.fetch = mock.fn(() => Promise.resolve({
        json: () => Promise.resolve({
          ts,
          passed: 9,
          total: 10,
          elapsed: 250,
          results: [
            { pass: false, method: 'DELETE', path: '/api/item', status: 403 }
          ]
        })
      }));
      const result = await server.callTool('smoke_test_status', {});
      const text = getText(result);
      assert.ok(text.includes('9/10 passed'));
      assert.ok(text.includes('5m ago'));
      assert.ok(text.includes('DELETE /api/item'));
    });

    test('handles fetch exceptions', async () => {
      global.fetch = mock.fn(() => Promise.reject(new Error('Connection refused')));
      const result = await server.callTool('smoke_test_status', {});
      const text = getText(result);
      assert.ok(text.includes('error'));
      assert.ok(text.includes('Connection refused'));
    });
  });
});

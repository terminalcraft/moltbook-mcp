#!/usr/bin/env node
// kv.test.mjs — Tests for kv.js component (B#221)
// Run with: node --test components/kv.test.mjs

import { test, describe, before, after } from 'node:test';
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

// Mock fetch responses
let mockFetchResponses = [];
let mockFetchCalls = [];

function setMockFetch(responses) {
  mockFetchResponses = [...responses];
  mockFetchCalls = [];
}

function getMockCalls() {
  return mockFetchCalls;
}

// Install global fetch mock
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  mockFetchCalls.push({ url, options });
  const response = mockFetchResponses.shift();
  if (!response) {
    return {
      ok: false,
      status: 500,
      json: async () => ({ error: 'No mock response configured' })
    };
  }
  return {
    ok: response.ok !== undefined ? response.ok : true,
    status: response.status || (response.ok === false ? 400 : 200),
    json: async () => response.data
  };
};

describe('kv.js component', () => {
  let server;

  before(async () => {
    const mod = await import('./kv.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  describe('tool registration', () => {
    test('registers all KV tools', () => {
      const tools = server.getTools();
      assert.ok(tools['kv_set'], 'kv_set should be registered');
      assert.ok(tools['kv_get'], 'kv_get should be registered');
      assert.ok(tools['kv_list'], 'kv_list should be registered');
      assert.ok(tools['kv_delete'], 'kv_delete should be registered');
    });
  });

  describe('kv_set', () => {
    test('creates new key', async () => {
      setMockFetch([{ data: { created: true } }]);
      const result = await server.callTool('kv_set', {
        ns: 'test-ns',
        key: 'test-key',
        value: 'test-value'
      });
      const text = getText(result);
      assert.ok(text.includes('Created'), 'Should indicate creation');
      assert.ok(text.includes('test-ns/test-key'), 'Should show key path');
    });

    test('updates existing key', async () => {
      setMockFetch([{ data: { created: false } }]);
      const result = await server.callTool('kv_set', {
        ns: 'my-ns',
        key: 'my-key',
        value: { foo: 'bar' }
      });
      const text = getText(result);
      assert.ok(text.includes('Updated'), 'Should indicate update');
    });

    test('sets key with TTL', async () => {
      setMockFetch([{ data: { created: true, expires_at: '2026-02-05T10:00:00Z' } }]);
      const result = await server.callTool('kv_set', {
        ns: 'test',
        key: 'temp',
        value: 'data',
        ttl: 3600
      });
      const text = getText(result);
      assert.ok(text.includes('expires'), 'Should show expiry');

      const call = getMockCalls()[0];
      const body = JSON.parse(call.options.body);
      assert.equal(body.ttl, 3600, 'TTL should be in request body');
    });

    test('handles URL encoding for special characters', async () => {
      setMockFetch([{ data: { created: true } }]);
      await server.callTool('kv_set', {
        ns: 'ns/special',
        key: 'key with spaces',
        value: 'test'
      });
      const call = getMockCalls()[0];
      assert.ok(call.url.includes('ns%2Fspecial'), 'Should URL encode namespace');
      assert.ok(call.url.includes('key%20with%20spaces'), 'Should URL encode key');
    });

    test('handles API failure', async () => {
      setMockFetch([{ ok: false, data: { error: 'Namespace required' } }]);
      const result = await server.callTool('kv_set', {
        ns: '',
        key: 'test',
        value: 'test'
      });
      const text = getText(result);
      assert.ok(text.includes('failed'), 'Should indicate failure');
    });
  });

  describe('kv_get', () => {
    test('retrieves string value', async () => {
      setMockFetch([{
        data: {
          value: 'hello world',
          updated_at: '2026-02-04T10:00:00Z'
        }
      }]);
      const result = await server.callTool('kv_get', {
        ns: 'test',
        key: 'greeting'
      });
      const text = getText(result);
      assert.ok(text.includes('test/greeting'), 'Should show key path');
      assert.ok(text.includes('hello world'), 'Should show value');
      assert.ok(text.includes('Updated:'), 'Should show update timestamp');
    });

    test('retrieves object value as JSON', async () => {
      setMockFetch([{
        data: {
          value: { foo: 'bar', count: 42 },
          updated_at: '2026-02-04T10:00:00Z'
        }
      }]);
      const result = await server.callTool('kv_get', {
        ns: 'test',
        key: 'config'
      });
      const text = getText(result);
      assert.ok(text.includes('"foo"'), 'Should format object as JSON');
      assert.ok(text.includes('"bar"'), 'Should include object values');
    });

    test('shows expiry when present', async () => {
      setMockFetch([{
        data: {
          value: 'temp data',
          updated_at: '2026-02-04T10:00:00Z',
          expires_at: '2026-02-05T10:00:00Z'
        }
      }]);
      const result = await server.callTool('kv_get', {
        ns: 'test',
        key: 'temp'
      });
      const text = getText(result);
      assert.ok(text.includes('Expires:'), 'Should show expiry');
    });

    test('handles key not found', async () => {
      setMockFetch([{ ok: true, status: 404 }]);
      const result = await server.callTool('kv_get', {
        ns: 'test',
        key: 'nonexistent'
      });
      const text = getText(result);
      assert.ok(text.includes('not found'), 'Should indicate key not found');
    });
  });

  describe('kv_list', () => {
    test('lists all namespaces when ns not specified', async () => {
      setMockFetch([{
        data: {
          total_namespaces: 3,
          total_keys: 15,
          namespaces: [
            { ns: 'moltbook', keys: 8 },
            { ns: 'testbot', keys: 5 },
            { ns: 'config', keys: 2 }
          ]
        }
      }]);
      const result = await server.callTool('kv_list', {});
      const text = getText(result);
      assert.ok(text.includes('KV Store'), 'Should have title');
      assert.ok(text.includes('15 keys'), 'Should show total keys');
      assert.ok(text.includes('3 namespace'), 'Should show namespace count');
      assert.ok(text.includes('moltbook'), 'Should list namespace names');
      assert.ok(text.includes('8 keys'), 'Should show per-namespace key count');
    });

    test('lists keys in a namespace', async () => {
      setMockFetch([{
        data: {
          count: 3,
          keys: [
            { key: 'config', updated_at: '2026-02-04T10:00:00Z' },
            { key: 'state', updated_at: '2026-02-04T09:00:00Z', expires_at: '2026-02-05T09:00:00Z' },
            { key: 'cache', updated_at: '2026-02-04T08:00:00Z' }
          ]
        }
      }]);
      const result = await server.callTool('kv_list', { ns: 'moltbook' });
      const text = getText(result);
      assert.ok(text.includes('moltbook'), 'Should show namespace');
      assert.ok(text.includes('3 keys'), 'Should show key count');
      assert.ok(text.includes('config'), 'Should list key names');
      assert.ok(text.includes('expires'), 'Should show expiry when present');
    });

    test('handles empty namespace', async () => {
      setMockFetch([{ data: { count: 0, keys: [] } }]);
      const result = await server.callTool('kv_list', { ns: 'empty-ns' });
      const text = getText(result);
      assert.ok(text.includes('empty') || text.includes("doesn't exist"), 'Should indicate empty');
    });

    test('handles empty store', async () => {
      setMockFetch([{ data: { total_namespaces: 0, total_keys: 0, namespaces: [] } }]);
      const result = await server.callTool('kv_list', {});
      const text = getText(result);
      assert.ok(text.includes('empty'), 'Should indicate store is empty');
    });
  });

  describe('kv_delete', () => {
    test('deletes existing key', async () => {
      setMockFetch([{ ok: true, status: 200 }]);
      const result = await server.callTool('kv_delete', {
        ns: 'test',
        key: 'old-key'
      });
      const text = getText(result);
      assert.ok(text.includes('Deleted'), 'Should confirm deletion');
      assert.ok(text.includes('test/old-key'), 'Should show key path');
    });

    test('handles key not found', async () => {
      setMockFetch([{ ok: true, status: 404 }]);
      const result = await server.callTool('kv_delete', {
        ns: 'test',
        key: 'nonexistent'
      });
      const text = getText(result);
      assert.ok(text.includes('not found'), 'Should indicate key not found');
    });

    test('sends DELETE request', async () => {
      setMockFetch([{ ok: true }]);
      await server.callTool('kv_delete', {
        ns: 'test',
        key: 'delete-me'
      });
      const call = getMockCalls()[0];
      assert.equal(call.options.method, 'DELETE', 'Should use DELETE method');
      assert.ok(call.url.includes('/kv/test/delete-me'), 'Should target correct endpoint');
    });
  });
});

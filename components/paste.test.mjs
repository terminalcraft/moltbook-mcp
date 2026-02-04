#!/usr/bin/env node
// paste.test.mjs — Tests for paste.js component (B#224)
// Run with: node --test components/paste.test.mjs

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

describe('paste.js component', () => {
  let server;

  before(async () => {
    const mod = await import('./paste.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  describe('tool registration', () => {
    test('registers paste_create tool', () => {
      const tools = server.getTools();
      assert.ok(tools['paste_create'], 'paste_create should be registered');
    });

    test('registers paste_get tool', () => {
      const tools = server.getTools();
      assert.ok(tools['paste_get'], 'paste_get should be registered');
    });

    test('registers paste_list tool', () => {
      const tools = server.getTools();
      assert.ok(tools['paste_list'], 'paste_list should be registered');
    });
  });

  describe('paste_create', () => {
    test('creates paste with minimal fields', async () => {
      setMockFetch([{
        data: { id: 'abc12345' }
      }]);
      const result = await server.callTool('paste_create', { content: 'Hello world' });
      const text = getText(result);
      assert.ok(text.includes('Paste created: **abc12345**'), 'Should show paste ID');
      assert.ok(text.includes('terminalcraft.xyz:3847/paste/abc12345'), 'Should show URL');
      assert.ok(text.includes('/raw'), 'Should show raw URL');
    });

    test('creates paste with all optional fields', async () => {
      setMockFetch([{
        data: { id: 'xyz98765', expires_at: '2026-02-11T00:00:00Z' }
      }]);
      const result = await server.callTool('paste_create', {
        content: 'console.log("test");',
        title: 'Test Script',
        language: 'javascript',
        author: 'moltbook',
        expires_in: 86400
      });
      const text = getText(result);
      assert.ok(text.includes('xyz98765'), 'Should show paste ID');
      assert.ok(text.includes('Expires:'), 'Should show expiry');

      // Verify request body
      const call = getMockCalls()[0];
      const body = JSON.parse(call.options.body);
      assert.equal(body.title, 'Test Script', 'Should include title');
      assert.equal(body.language, 'javascript', 'Should include language');
      assert.equal(body.author, 'moltbook', 'Should include author');
      assert.equal(body.expires_in, 86400, 'Should include expires_in');
    });

    test('handles create failure', async () => {
      setMockFetch([{ ok: false, data: { error: 'Content too large' } }]);
      const result = await server.callTool('paste_create', { content: 'x'.repeat(1000000) });
      const text = getText(result);
      assert.ok(text.includes('Paste failed: Content too large'), 'Should show error');
    });

    test('handles API errors gracefully', async () => {
      setMockFetch([]); // No response - mock returns error which may be shown as failure or error
      const result = await server.callTool('paste_create', { content: 'test' });
      const text = getText(result);
      assert.ok(
        text.includes('Paste error:') || text.includes('Paste failed'),
        'Should handle error gracefully'
      );
    });
  });

  describe('paste_get', () => {
    test('retrieves paste with all metadata', async () => {
      setMockFetch([{
        data: {
          id: 'abc12345',
          title: 'My Paste',
          language: 'python',
          views: 42,
          size: 256,
          author: 'testuser',
          expires_at: '2026-02-15T00:00:00Z',
          content: 'print("Hello")'
        }
      }]);
      const result = await server.callTool('paste_get', { id: 'abc12345' });
      const text = getText(result);
      assert.ok(text.includes('**My Paste** (abc12345)'), 'Should show title and ID');
      assert.ok(text.includes('Language: python'), 'Should show language');
      assert.ok(text.includes('Views: 42'), 'Should show views');
      assert.ok(text.includes('Size: 256B'), 'Should show size');
      assert.ok(text.includes('Author: testuser'), 'Should show author');
      assert.ok(text.includes('Expires:'), 'Should show expiry');
      assert.ok(text.includes('print("Hello")'), 'Should show content');
    });

    test('retrieves paste without optional fields', async () => {
      setMockFetch([{
        data: {
          id: 'xyz98765',
          views: 1,
          size: 10,
          content: 'test'
        }
      }]);
      const result = await server.callTool('paste_get', { id: 'xyz98765' });
      const text = getText(result);
      assert.ok(text.includes('**Untitled** (xyz98765)'), 'Should show Untitled for missing title');
      assert.ok(text.includes('Language: plain'), 'Should show plain for missing language');
      assert.ok(!text.includes('Author:'), 'Should not show author when missing');
    });

    test('handles paste not found', async () => {
      setMockFetch([{ ok: false, status: 404, data: {} }]);
      const result = await server.callTool('paste_get', { id: 'notfound' });
      const text = getText(result);
      assert.ok(text.includes('Paste notfound not found'), 'Should indicate not found');
    });

    test('handles API errors gracefully', async () => {
      setMockFetch([]); // No response - mock returns 404-like response
      const result = await server.callTool('paste_get', { id: 'error' });
      const text = getText(result);
      assert.ok(
        text.includes('Paste error:') || text.includes('not found'),
        'Should handle error gracefully'
      );
    });
  });

  describe('paste_list', () => {
    test('returns list of pastes', async () => {
      setMockFetch([{
        data: {
          count: 2,
          total: 50,
          pastes: [
            { id: 'aaa11111', title: 'First', language: 'js', author: 'agent1', views: 10, preview: 'console.log...' },
            { id: 'bbb22222', title: null, language: 'python', author: null, views: 5, preview: 'print...' }
          ]
        }
      }]);
      const result = await server.callTool('paste_list', {});
      const text = getText(result);
      assert.ok(text.includes('**Pastes** (2 of 50 total)'), 'Should show counts');
      assert.ok(text.includes('aaa11111'), 'Should list first paste');
      assert.ok(text.includes('First'), 'Should show title');
      assert.ok(text.includes('bbb22222'), 'Should list second paste');
      assert.ok(text.includes('(untitled)'), 'Should show untitled for null title');
    });

    test('passes filter parameters correctly', async () => {
      setMockFetch([{ data: { count: 0, total: 0, pastes: [] } }]);
      await server.callTool('paste_list', { author: 'moltbook', language: 'js', limit: 5 });
      const call = getMockCalls()[0];
      assert.ok(call.url.includes('author=moltbook'), 'Should include author param');
      assert.ok(call.url.includes('language=js'), 'Should include language param');
      assert.ok(call.url.includes('limit=5'), 'Should include limit param');
    });

    test('handles empty list', async () => {
      setMockFetch([{ data: { pastes: [] } }]);
      const result = await server.callTool('paste_list', {});
      const text = getText(result);
      assert.ok(text.includes('No pastes found'), 'Should indicate empty');
    });

    test('handles missing pastes array', async () => {
      setMockFetch([{ data: {} }]);
      const result = await server.callTool('paste_list', {});
      const text = getText(result);
      assert.ok(text.includes('No pastes found'), 'Should handle missing array');
    });

    test('handles API errors gracefully', async () => {
      setMockFetch([]); // No response - mock returns error which may be shown as no pastes
      const result = await server.callTool('paste_list', {});
      const text = getText(result);
      assert.ok(
        text.includes('Paste error:') || text.includes('No pastes'),
        'Should handle error gracefully'
      );
    });
  });
});

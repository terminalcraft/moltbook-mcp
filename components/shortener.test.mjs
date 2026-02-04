#!/usr/bin/env node
// shortener.test.mjs — Tests for shortener.js component
// Run with: node --test components/shortener.test.mjs

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

describe('shortener.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./shortener.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers short_create tool', () => {
      const tools = server.getTools();
      assert.ok(tools.short_create, 'short_create tool should be registered');
      assert.ok(tools.short_create.description.includes('short URL'), 'description should mention short URL');
    });

    test('registers short_list tool', () => {
      const tools = server.getTools();
      assert.ok(tools.short_list, 'short_list tool should be registered');
      assert.ok(tools.short_list.description.includes('List'), 'description should mention List');
    });
  });

  describe('short_create', () => {
    test('creates short URL successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ code: 'abc123', existing: false })
      }));

      const result = await server.callTool('short_create', { url: 'https://example.com' });
      const text = getText(result);

      assert.ok(text.includes('Short URL created'), 'should indicate creation');
      assert.ok(text.includes('abc123'), 'should include the code');
      assert.ok(text.includes('example.com'), 'should include original URL');
    });

    test('returns existing short URL when deduplicated', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ code: 'existing1', existing: true })
      }));

      const result = await server.callTool('short_create', { url: 'https://duplicate.com' });
      const text = getText(result);

      assert.ok(text.includes('Existing short URL'), 'should indicate existing');
      assert.ok(text.includes('existing1'), 'should include the code');
    });

    test('handles custom code parameter', async () => {
      let capturedBody;
      global.fetch = mock.fn(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({ code: 'mycode', existing: false })
        };
      });

      await server.callTool('short_create', { url: 'https://test.com', code: 'mycode' });

      assert.equal(capturedBody.code, 'mycode', 'should pass custom code');
    });

    test('handles title and author parameters', async () => {
      let capturedBody;
      global.fetch = mock.fn(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({ code: 'xyz', existing: false })
        };
      });

      await server.callTool('short_create', {
        url: 'https://test.com',
        title: 'Test Link',
        author: 'moltbook'
      });

      assert.equal(capturedBody.title, 'Test Link', 'should pass title');
      assert.equal(capturedBody.author, 'moltbook', 'should pass author');
    });

    test('handles API error response', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Invalid URL format' })
      }));

      const result = await server.callTool('short_create', { url: 'badurl' });
      const text = getText(result);

      assert.ok(text.includes('failed'), 'should indicate failure');
      assert.ok(text.includes('Invalid URL format'), 'should include error message');
    });

    test('handles network error', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Connection refused');
      });

      const result = await server.callTool('short_create', { url: 'https://test.com' });
      const text = getText(result);

      assert.ok(text.includes('error'), 'should indicate error');
      assert.ok(text.includes('Connection refused'), 'should include error message');
    });
  });

  describe('short_list', () => {
    test('lists short URLs successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          count: 2,
          shorts: [
            { code: 'abc', url: 'https://a.com', clicks: 5, author: 'moltbook' },
            { code: 'def', url: 'https://b.com', clicks: 10, title: 'B Link' }
          ]
        })
      }));

      const result = await server.callTool('short_list', {});
      const text = getText(result);

      assert.ok(text.includes('Short URLs'), 'should have header');
      assert.ok(text.includes('abc'), 'should include first code');
      assert.ok(text.includes('def'), 'should include second code');
      assert.ok(text.includes('5 clicks'), 'should include click count');
      assert.ok(text.includes('B Link'), 'should include title');
    });

    test('returns empty message when no URLs found', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ shorts: [] })
      }));

      const result = await server.callTool('short_list', {});
      const text = getText(result);

      assert.ok(text.includes('No short URLs found'), 'should indicate empty');
    });

    test('handles null shorts array', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({})
      }));

      const result = await server.callTool('short_list', {});
      const text = getText(result);

      assert.ok(text.includes('No short URLs found'), 'should handle null shorts');
    });

    test('passes filter parameters to API', async () => {
      let capturedUrl;
      global.fetch = mock.fn(async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          json: async () => ({ shorts: [], count: 0 })
        };
      });

      await server.callTool('short_list', { author: 'moltbook', q: 'test', limit: 10 });

      assert.ok(capturedUrl.includes('author=moltbook'), 'should include author param');
      assert.ok(capturedUrl.includes('q=test'), 'should include search param');
      assert.ok(capturedUrl.includes('limit=10'), 'should include limit param');
    });

    test('handles network error', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Network timeout');
      });

      const result = await server.callTool('short_list', {});
      const text = getText(result);

      assert.ok(text.includes('error'), 'should indicate error');
      assert.ok(text.includes('Network timeout'), 'should include error message');
    });
  });
});

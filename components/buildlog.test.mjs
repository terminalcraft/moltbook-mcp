#!/usr/bin/env node
// buildlog.test.mjs — Tests for buildlog.js component (B#221)
// Run with: node --test components/buildlog.test.mjs

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

describe('buildlog.js component', () => {
  let server;

  before(async () => {
    const mod = await import('./buildlog.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  describe('tool registration', () => {
    test('registers buildlog_add tool', () => {
      const tools = server.getTools();
      assert.ok(tools['buildlog_add'], 'buildlog_add should be registered');
    });

    test('registers buildlog_list tool', () => {
      const tools = server.getTools();
      assert.ok(tools['buildlog_list'], 'buildlog_list should be registered');
    });
  });

  describe('buildlog_add', () => {
    test('logs build with required fields', async () => {
      setMockFetch([{
        data: {
          entry: {
            id: 'abc12345-test-id',
            agent: 'moltbook',
            summary: 'Added new feature'
          }
        }
      }]);
      const result = await server.callTool('buildlog_add', {
        agent: 'moltbook',
        summary: 'Added new feature'
      });
      const text = getText(result);
      assert.ok(text.includes('Logged'), 'Should confirm logging');
      assert.ok(text.includes('moltbook'), 'Should include agent name');
      assert.ok(text.includes('Added new feature'), 'Should include summary');
      assert.ok(text.includes('abc12345'), 'Should include truncated ID');
    });

    test('logs build with optional fields', async () => {
      setMockFetch([{
        data: {
          entry: {
            id: 'xyz98765-test-id',
            agent: 'testbot',
            summary: 'Version 2.0 release',
            version: '2.0.0',
            commits: 5,
            files_changed: 12,
            tags: ['release', 'major'],
            url: 'https://github.com/example/repo/releases/v2.0.0'
          }
        }
      }]);
      const result = await server.callTool('buildlog_add', {
        agent: 'testbot',
        summary: 'Version 2.0 release',
        version: '2.0.0',
        commits: 5,
        files_changed: 12,
        tags: ['release', 'major'],
        url: 'https://github.com/example/repo/releases/v2.0.0'
      });
      const text = getText(result);
      assert.ok(text.includes('Logged'), 'Should confirm logging');

      // Check the POST body was constructed correctly
      const call = getMockCalls()[0];
      const body = JSON.parse(call.options.body);
      assert.equal(body.agent, 'testbot');
      assert.equal(body.version, '2.0.0');
      assert.equal(body.commits, 5);
      assert.deepEqual(body.tags, ['release', 'major']);
    });

    test('handles API failure gracefully', async () => {
      setMockFetch([{ ok: false, status: 400, data: { error: 'Invalid agent handle' } }]);
      const result = await server.callTool('buildlog_add', {
        agent: '',
        summary: 'test'
      });
      const text = getText(result);
      assert.ok(text.includes('Failed'), 'Should indicate failure');
      assert.ok(text.includes('Invalid agent'), 'Should include error message');
    });

    test('sends correct HTTP request', async () => {
      setMockFetch([{ data: { entry: { id: 'test-id', agent: 'test', summary: 'test' } } }]);
      await server.callTool('buildlog_add', {
        agent: 'test-agent',
        summary: 'test summary'
      });
      const call = getMockCalls()[0];
      assert.ok(call.url.includes('/buildlog'), 'Should POST to /buildlog');
      assert.equal(call.options.method, 'POST');
      assert.equal(call.options.headers['Content-Type'], 'application/json');
    });
  });

  describe('buildlog_list', () => {
    test('shows empty message when no entries', async () => {
      setMockFetch([{ data: { entries: [] } }]);
      const result = await server.callTool('buildlog_list', {});
      const text = getText(result);
      assert.ok(text.includes('Build log is empty'), 'Should indicate empty log');
    });

    test('formats build log entries', async () => {
      setMockFetch([{
        data: {
          count: 2,
          entries: [
            {
              agent: 'moltbook',
              summary: 'Fixed bug',
              version: '1.5.1',
              commits: 3,
              tags: ['bugfix'],
              ts: '2026-02-04T10:30:00Z',
              url: 'https://github.com/example/commit/abc'
            },
            {
              agent: 'testbot',
              summary: 'New feature',
              ts: '2026-02-04T09:00:00Z'
            }
          ]
        }
      }]);
      const result = await server.callTool('buildlog_list', {});
      const text = getText(result);
      assert.ok(text.includes('Build Log'), 'Should have title');
      assert.ok(text.includes('2 entries'), 'Should show count');
      assert.ok(text.includes('moltbook'), 'Should include agent name');
      assert.ok(text.includes('v1.5.1'), 'Should format version');
      assert.ok(text.includes('3 commits'), 'Should show commit count');
      assert.ok(text.includes('bugfix'), 'Should show tags');
      assert.ok(text.includes('github.com'), 'Should include URL');
    });

    test('filters by agent', async () => {
      setMockFetch([{ data: { count: 1, entries: [{ agent: 'moltbook', summary: 'Test', ts: '2026-02-04T10:00:00Z' }] } }]);
      await server.callTool('buildlog_list', { agent: 'moltbook' });
      const call = getMockCalls()[0];
      assert.ok(call.url.includes('agent=moltbook'), 'Should pass agent filter');
    });

    test('filters by tag', async () => {
      setMockFetch([{ data: { count: 1, entries: [{ agent: 'test', summary: 'Test', ts: '2026-02-04T10:00:00Z' }] } }]);
      await server.callTool('buildlog_list', { tag: 'bugfix' });
      const call = getMockCalls()[0];
      assert.ok(call.url.includes('tag=bugfix'), 'Should pass tag filter');
    });

    test('respects limit parameter', async () => {
      setMockFetch([{ data: { count: 0, entries: [] } }]);
      await server.callTool('buildlog_list', { limit: 5 });
      const call = getMockCalls()[0];
      assert.ok(call.url.includes('limit=5'), 'Should pass limit parameter');
    });

    test('handles API errors gracefully', async () => {
      setMockFetch([{ ok: false, status: 500, data: { error: 'Server error' } }]);
      const result = await server.callTool('buildlog_list', {});
      const text = getText(result);
      // Component may return empty or error depending on response structure
      assert.ok(text.includes('empty') || text.includes('error') || text.includes('Buildlog'), 'Should handle error');
    });
  });
});

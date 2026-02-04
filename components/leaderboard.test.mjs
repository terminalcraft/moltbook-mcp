#!/usr/bin/env node
// leaderboard.test.mjs — Tests for leaderboard.js component (B#224)
// Run with: node --test components/leaderboard.test.mjs

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

describe('leaderboard.js component', () => {
  let server;

  before(async () => {
    const mod = await import('./leaderboard.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  describe('tool registration', () => {
    test('registers leaderboard_view tool', () => {
      const tools = server.getTools();
      assert.ok(tools['leaderboard_view'], 'leaderboard_view should be registered');
    });

    test('registers leaderboard_submit tool', () => {
      const tools = server.getTools();
      assert.ok(tools['leaderboard_submit'], 'leaderboard_submit should be registered');
    });
  });

  describe('leaderboard_view', () => {
    test('returns ranked list of agents', async () => {
      setMockFetch([{
        data: {
          agents: [
            { handle: 'topagent', score: 150, commits: 50, sessions: 100, tools_built: 5, patterns_shared: 10, services_shipped: 2, description: 'Top builder' },
            { handle: 'midagent', score: 75, commits: 25, sessions: 50, tools_built: 2, patterns_shared: 5, services_shipped: 1 },
            { handle: 'newagent', score: 20, commits: 10, sessions: 10, tools_built: 0, patterns_shared: 0, services_shipped: 0 }
          ],
          lastUpdated: '2026-02-04T12:00:00Z'
        }
      }]);
      const result = await server.callTool('leaderboard_view', {});
      const text = getText(result);
      assert.ok(text.includes('**Agent Leaderboard** (3 agent(s))'), 'Should show count');
      assert.ok(text.includes('🥇'), 'Should show gold medal for first');
      assert.ok(text.includes('🥈'), 'Should show silver medal for second');
      assert.ok(text.includes('🥉'), 'Should show bronze medal for third');
      assert.ok(text.includes('topagent'), 'Should list first agent');
      assert.ok(text.includes('150 pts'), 'Should show score');
      assert.ok(text.includes('Top builder'), 'Should show description');
      assert.ok(text.includes('Last updated:'), 'Should show last updated');
    });

    test('shows specific agent when handle provided', async () => {
      setMockFetch([{
        data: {
          agents: [
            { handle: 'topagent', score: 150, commits: 50, sessions: 100, tools_built: 5, patterns_shared: 10, services_shipped: 2, description: 'Top builder' },
            { handle: 'moltbook', score: 75, commits: 25, sessions: 50, tools_built: 2, patterns_shared: 5, services_shipped: 1, description: 'MCP tools' }
          ]
        }
      }]);
      const result = await server.callTool('leaderboard_view', { handle: 'moltbook' });
      const text = getText(result);
      assert.ok(text.includes('#2 — **moltbook**'), 'Should show rank and handle');
      assert.ok(text.includes('score: 75'), 'Should show score');
      assert.ok(text.includes('Commits: 25'), 'Should show commits');
      assert.ok(text.includes('Sessions: 50'), 'Should show sessions');
      assert.ok(text.includes('Tools: 2'), 'Should show tools');
      assert.ok(text.includes('Patterns: 5'), 'Should show patterns');
      assert.ok(text.includes('Services: 1'), 'Should show services');
      assert.ok(text.includes('MCP tools'), 'Should show description');
    });

    test('handles case-insensitive handle lookup', async () => {
      setMockFetch([{
        data: {
          agents: [
            { handle: 'MoltBook', score: 75, commits: 25, sessions: 50, tools_built: 2, patterns_shared: 5, services_shipped: 1 }
          ]
        }
      }]);
      const result = await server.callTool('leaderboard_view', { handle: 'moltbook' });
      const text = getText(result);
      assert.ok(text.includes('#1 — **MoltBook**'), 'Should find agent case-insensitively');
    });

    test('handles agent not found', async () => {
      setMockFetch([{
        data: {
          agents: [
            { handle: 'otheragent', score: 50, commits: 10, sessions: 20, tools_built: 1, patterns_shared: 2, services_shipped: 0 }
          ]
        }
      }]);
      const result = await server.callTool('leaderboard_view', { handle: 'notfound' });
      const text = getText(result);
      assert.ok(text.includes('Agent "notfound" not found'), 'Should indicate not found');
    });

    test('handles empty leaderboard', async () => {
      setMockFetch([{ data: { agents: [] } }]);
      const result = await server.callTool('leaderboard_view', {});
      const text = getText(result);
      assert.ok(text.includes('Leaderboard is empty'), 'Should indicate empty');
    });

    test('handles missing agents array', async () => {
      setMockFetch([{ data: {} }]);
      const result = await server.callTool('leaderboard_view', {});
      const text = getText(result);
      assert.ok(text.includes('Leaderboard is empty'), 'Should handle missing array');
    });

    test('handles API errors gracefully', async () => {
      setMockFetch([]); // No response - mock returns error which may show as empty
      const result = await server.callTool('leaderboard_view', {});
      const text = getText(result);
      assert.ok(
        text.includes('Leaderboard error:') || text.includes('empty'),
        'Should handle error gracefully'
      );
    });

    test('shows rank numbers for 4th place and beyond', async () => {
      setMockFetch([{
        data: {
          agents: [
            { handle: 'first', score: 100, commits: 10, sessions: 10, tools_built: 1, patterns_shared: 1, services_shipped: 1 },
            { handle: 'second', score: 90, commits: 10, sessions: 10, tools_built: 1, patterns_shared: 1, services_shipped: 1 },
            { handle: 'third', score: 80, commits: 10, sessions: 10, tools_built: 1, patterns_shared: 1, services_shipped: 1 },
            { handle: 'fourth', score: 70, commits: 10, sessions: 10, tools_built: 1, patterns_shared: 1, services_shipped: 1 }
          ]
        }
      }]);
      const result = await server.callTool('leaderboard_view', {});
      const text = getText(result);
      assert.ok(text.includes('#4'), 'Should show #4 for fourth place');
    });
  });

  describe('leaderboard_submit', () => {
    test('submits stats with all fields', async () => {
      setMockFetch([{
        data: {
          agent: { handle: 'moltbook', score: 150 },
          rank: 1
        }
      }]);
      const result = await server.callTool('leaderboard_submit', {
        handle: 'moltbook',
        commits: 50,
        sessions: 100,
        tools_built: 5,
        patterns_shared: 10,
        services_shipped: 2,
        description: 'MCP tools builder'
      });
      const text = getText(result);
      assert.ok(text.includes('Updated **moltbook**'), 'Should confirm update');
      assert.ok(text.includes('score: 150'), 'Should show score');
      assert.ok(text.includes('rank: #1'), 'Should show rank');

      // Verify request body
      const call = getMockCalls()[0];
      const body = JSON.parse(call.options.body);
      assert.equal(body.handle, 'moltbook', 'Should include handle');
      assert.equal(body.commits, 50, 'Should include commits');
      assert.equal(body.sessions, 100, 'Should include sessions');
      assert.equal(body.tools_built, 5, 'Should include tools_built');
      assert.equal(body.patterns_shared, 10, 'Should include patterns_shared');
      assert.equal(body.services_shipped, 2, 'Should include services_shipped');
      assert.equal(body.description, 'MCP tools builder', 'Should include description');
    });

    test('submits stats with only required field', async () => {
      setMockFetch([{
        data: {
          agent: { handle: 'newagent', score: 0 },
          rank: 5
        }
      }]);
      const result = await server.callTool('leaderboard_submit', { handle: 'newagent' });
      const text = getText(result);
      assert.ok(text.includes('Updated **newagent**'), 'Should confirm update');

      // Verify only handle in body
      const call = getMockCalls()[0];
      const body = JSON.parse(call.options.body);
      assert.equal(Object.keys(body).length, 1, 'Should only have handle');
      assert.equal(body.handle, 'newagent', 'Should include handle');
    });

    test('handles submit failure', async () => {
      setMockFetch([{ ok: false, data: { error: 'Invalid handle' } }]);
      const result = await server.callTool('leaderboard_submit', { handle: '' });
      const text = getText(result);
      assert.ok(text.includes('Submit failed: Invalid handle'), 'Should show error');
    });

    test('handles API errors gracefully', async () => {
      setMockFetch([]); // No response - mock returns error which may show as failure
      const result = await server.callTool('leaderboard_submit', { handle: 'test' });
      const text = getText(result);
      assert.ok(
        text.includes('Leaderboard error:') || text.includes('failed'),
        'Should handle error gracefully'
      );
    });
  });
});

#!/usr/bin/env node
// reputation.test.mjs — Tests for reputation.js component (B#224)
// Run with: node --test components/reputation.test.mjs

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

describe('reputation.js component', () => {
  let server;

  before(async () => {
    const mod = await import('./reputation.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  describe('tool registration', () => {
    test('registers reputation_check tool', () => {
      const tools = server.getTools();
      assert.ok(tools['reputation_check'], 'reputation_check should be registered');
    });

    test('registers reputation_leaderboard tool', () => {
      const tools = server.getTools();
      assert.ok(tools['reputation_leaderboard'], 'reputation_leaderboard should be registered');
    });
  });

  describe('reputation_check', () => {
    test('returns formatted reputation for an agent', async () => {
      setMockFetch([{
        data: {
          handle: 'testagent',
          score: 42,
          grade: 'B',
          breakdown: {
            receipts: { score: 15, count: 3, unique_attesters: 2 },
            presence: { score: 12, heartbeats: 100, uptime_pct: 95.5, online: true },
            registry: { score: 15, registered: true, age_days: 30 }
          }
        }
      }]);
      const result = await server.callTool('reputation_check', { handle: 'testagent' });
      const text = getText(result);
      assert.ok(text.includes('testagent: 42 points'), 'Should show agent and score');
      assert.ok(text.includes('grade B'), 'Should show grade');
      assert.ok(text.includes('Receipts: 15pts'), 'Should show receipts breakdown');
      assert.ok(text.includes('3 receipts'), 'Should show receipt count');
      assert.ok(text.includes('Presence: 12pts'), 'Should show presence breakdown');
      assert.ok(text.includes('online'), 'Should show online status');
      assert.ok(text.includes('Registry: 15pts'), 'Should show registry breakdown');
      assert.ok(text.includes('30d ago'), 'Should show registry age');
    });

    test('shows offline status correctly', async () => {
      setMockFetch([{
        data: {
          handle: 'offlineagent',
          score: 10,
          grade: 'C',
          breakdown: {
            receipts: { score: 5, count: 1, unique_attesters: 1 },
            presence: { score: 0, heartbeats: 10, uptime_pct: 5.0, online: false },
            registry: { score: 5, registered: true, age_days: 5 }
          }
        }
      }]);
      const result = await server.callTool('reputation_check', { handle: 'offlineagent' });
      const text = getText(result);
      assert.ok(text.includes('offline'), 'Should show offline status');
    });

    test('handles unregistered agent', async () => {
      setMockFetch([{
        data: {
          handle: 'newagent',
          score: 0,
          grade: 'F',
          breakdown: {
            receipts: { score: 0, count: 0, unique_attesters: 0 },
            presence: { score: 0, heartbeats: 0, uptime_pct: 0, online: false },
            registry: { score: 0, registered: false, age_days: 0 }
          }
        }
      }]);
      const result = await server.callTool('reputation_check', { handle: 'newagent' });
      const text = getText(result);
      assert.ok(text.includes('not registered'), 'Should show not registered');
    });

    test('handles API errors gracefully', async () => {
      setMockFetch([]); // No response configured
      const result = await server.callTool('reputation_check', { handle: 'badagent' });
      const text = getText(result);
      assert.ok(text.includes('Reputation error:'), 'Should show error message');
    });
  });

  describe('reputation_leaderboard', () => {
    test('returns ranked list of agents', async () => {
      setMockFetch([{
        data: {
          count: 3,
          agents: [
            { handle: 'topagent', score: 100, grade: 'A', receipts: 30, presence: 40, registry: 30 },
            { handle: 'midagent', score: 50, grade: 'B', receipts: 15, presence: 20, registry: 15 },
            { handle: 'lowagent', score: 20, grade: 'C', receipts: 5, presence: 10, registry: 5 }
          ]
        }
      }]);
      const result = await server.callTool('reputation_leaderboard', {});
      const text = getText(result);
      assert.ok(text.includes('3 agents ranked'), 'Should show agent count');
      assert.ok(text.includes('topagent'), 'Should list top agent');
      assert.ok(text.includes('midagent'), 'Should list middle agent');
      assert.ok(text.includes('lowagent'), 'Should list bottom agent');
      assert.ok(text.includes('100pts'), 'Should show scores');
    });

    test('handles empty leaderboard', async () => {
      setMockFetch([{ data: { agents: [] } }]);
      const result = await server.callTool('reputation_leaderboard', {});
      const text = getText(result);
      assert.ok(text.includes('No agents with reputation data'), 'Should indicate empty');
    });

    test('handles missing agents array', async () => {
      setMockFetch([{ data: {} }]);
      const result = await server.callTool('reputation_leaderboard', {});
      const text = getText(result);
      assert.ok(text.includes('No agents with reputation data'), 'Should handle missing array');
    });

    test('handles API errors gracefully', async () => {
      setMockFetch([]); // No response - mock returns error which may be caught or shown as no agents
      const result = await server.callTool('reputation_leaderboard', {});
      const text = getText(result);
      // Either shows error or handles gracefully as empty leaderboard
      assert.ok(
        text.includes('Reputation error:') || text.includes('No agents'),
        'Should handle error gracefully'
      );
    });
  });
});

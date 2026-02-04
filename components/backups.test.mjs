#!/usr/bin/env node
// backups.test.mjs — Tests for backups.js component (B#221)
// Run with: node --test components/backups.test.mjs

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

describe('backups.js component', () => {
  let server;

  before(async () => {
    const mod = await import('./backups.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  describe('tool registration', () => {
    test('registers backup_list tool', () => {
      const tools = server.getTools();
      assert.ok(tools['backup_list'], 'backup_list should be registered');
    });

    test('registers backup_status tool', () => {
      const tools = server.getTools();
      assert.ok(tools['backup_status'], 'backup_status should be registered');
    });
  });

  describe('backup_list', () => {
    test('returns message when no backups exist', async () => {
      setMockFetch([{ data: { backups: [] } }]);
      const result = await server.callTool('backup_list', {});
      const text = getText(result);
      assert.ok(text.includes('No backups yet'), 'Should indicate no backups');
    });

    test('formats backup list with dates and sizes', async () => {
      setMockFetch([{
        data: {
          total: 3,
          retention_days: 7,
          backups: [
            { date: '2026-02-04', size: 10240, meta: { nonEmpty: 5, storeCount: 8 } },
            { date: '2026-02-03', size: 8192, meta: { nonEmpty: 4, storeCount: 8 } },
            { date: '2026-02-02', size: 7168, meta: { nonEmpty: 4, storeCount: 7 } }
          ]
        }
      }]);
      const result = await server.callTool('backup_list', {});
      const text = getText(result);
      assert.ok(text.includes('3 backups'), 'Should show backup count');
      assert.ok(text.includes('7-day retention'), 'Should show retention days');
      assert.ok(text.includes('2026-02-04'), 'Should show date');
      assert.ok(text.includes('10.0KB'), 'Should format size in KB');
      assert.ok(text.includes('5/8 stores'), 'Should show store counts');
    });

    test('handles missing meta gracefully', async () => {
      setMockFetch([{
        data: {
          total: 1,
          retention_days: 7,
          backups: [{ date: '2026-02-04', size: 5120 }]
        }
      }]);
      const result = await server.callTool('backup_list', {});
      const text = getText(result);
      assert.ok(text.includes('?/?'), 'Should show ? for missing meta');
    });

    test('handles API errors gracefully', async () => {
      setMockFetch([{ ok: false, status: 500, data: { error: 'Server error' } }]);
      const result = await server.callTool('backup_list', {});
      const text = getText(result);
      // Component shows error when .backups is missing
      assert.ok(text.includes('No backups') || text.includes('error'), 'Should handle missing data');
    });
  });

  describe('backup_status', () => {
    test('shows today backup when it exists', async () => {
      const today = new Date().toISOString().slice(0, 10);
      setMockFetch([{
        data: {
          backups: [
            { date: today, size: 10240, meta: { nonEmpty: 5, storeCount: 8, ts: '2026-02-04T10:00:00Z' }, modified: '2026-02-04T10:00:00Z' }
          ]
        }
      }]);
      const result = await server.callTool('backup_status', {});
      const text = getText(result);
      assert.ok(text.includes(`Today's backup (${today})`), 'Should confirm today backup');
      assert.ok(text.includes('10.0KB'), 'Should show size');
      assert.ok(text.includes('5/8'), 'Should show store stats');
    });

    test('indicates when no backup for today', async () => {
      const today = new Date().toISOString().slice(0, 10);
      setMockFetch([{
        data: {
          backups: [
            { date: '2026-02-01', size: 5120, meta: {} }  // Old backup, not today
          ]
        }
      }]);
      const result = await server.callTool('backup_status', {});
      const text = getText(result);
      assert.ok(text.includes(`No backup for ${today}`), 'Should indicate no today backup');
      assert.ok(text.includes('Auto-backup runs'), 'Should mention auto-backup');
    });

    test('handles API errors gracefully', async () => {
      setMockFetch([{ ok: false, status: 500, data: {} }]);
      const result = await server.callTool('backup_status', {});
      const text = getText(result);
      // Component returns "no backup for today" when backups array is missing
      assert.ok(text.includes('No backup') || text.includes('error'), 'Should handle missing data');
    });
  });
});

#!/usr/bin/env node
// snapshots.test.mjs — Tests for snapshots.js component
// Run with: node --test components/snapshots.test.mjs

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

describe('snapshots.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./snapshots.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers snapshot_save tool', () => {
      const tools = server.getTools();
      assert.ok(tools.snapshot_save, 'snapshot_save tool should be registered');
    });

    test('registers snapshot_list tool', () => {
      const tools = server.getTools();
      assert.ok(tools.snapshot_list, 'snapshot_list tool should be registered');
    });

    test('registers snapshot_get tool', () => {
      const tools = server.getTools();
      assert.ok(tools.snapshot_get, 'snapshot_get tool should be registered');
    });

    test('registers snapshot_diff tool', () => {
      const tools = server.getTools();
      assert.ok(tools.snapshot_diff, 'snapshot_diff tool should be registered');
    });

    test('registers snapshot_delete tool', () => {
      const tools = server.getTools();
      assert.ok(tools.snapshot_delete, 'snapshot_delete tool should be registered');
    });
  });

  describe('snapshot_save', () => {
    test('saves snapshot successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          id: 'snap-123',
          label: 'session-42',
          version: 1,
          size: 256
        })
      }));

      const result = await server.callTool('snapshot_save', {
        handle: 'moltbook',
        label: 'session-42',
        data: { state: 'active', count: 10 }
      });

      const text = getText(result);
      assert.ok(text.includes('Snapshot saved'), 'Result should indicate save');
      assert.ok(text.includes('session-42'), 'Result should contain label');
      assert.ok(text.includes('snap-123'), 'Result should contain id');
      assert.ok(text.includes('v1'), 'Result should contain version');
      assert.ok(text.includes('256 bytes'), 'Result should contain size');
    });

    test('saves snapshot with tags', async () => {
      global.fetch = mock.fn(async (url, opts) => {
        const body = JSON.parse(opts.body);
        assert.deepEqual(body.tags, ['important', 'backup'], 'Tags should be passed');
        return {
          ok: true,
          json: async () => ({ id: 'snap-456', label: 'backup', version: 2, size: 512 })
        };
      });

      await server.callTool('snapshot_save', {
        handle: 'moltbook',
        label: 'backup',
        data: { foo: 'bar' },
        tags: ['important', 'backup']
      });
    });

    test('handles save failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Quota exceeded' })
      }));

      const result = await server.callTool('snapshot_save', {
        handle: 'moltbook',
        data: { large: 'data' }
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
      assert.ok(text.includes('Quota exceeded'), 'Result should contain error');
    });

    test('handles network error', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Connection refused');
      });

      const result = await server.callTool('snapshot_save', {
        handle: 'moltbook',
        data: {}
      });

      const text = getText(result);
      assert.ok(text.includes('error'), 'Result should indicate error');
    });
  });

  describe('snapshot_list', () => {
    test('lists all agents with snapshots', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ([
          { handle: 'agent1', count: 5, latest: '2026-02-04T10:00:00Z' },
          { handle: 'agent2', count: 2, latest: '2026-02-04T08:00:00Z' }
        ])
      }));

      const result = await server.callTool('snapshot_list', {});
      const text = getText(result);
      assert.ok(text.includes('Snapshots overview'), 'Result should have overview header');
      assert.ok(text.includes('agent1'), 'Result should contain first agent');
      assert.ok(text.includes('5 snapshots'), 'Result should show count');
      assert.ok(text.includes('agent2'), 'Result should contain second agent');
    });

    test('lists snapshots for specific agent', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ([
          { id: 'snap-1', label: 'session-1', version: 1, size: 100, created: '2026-02-04T09:00:00Z', tags: ['daily'] },
          { id: 'snap-2', label: 'session-2', version: 2, size: 150, created: '2026-02-04T10:00:00Z', tags: [] }
        ])
      }));

      const result = await server.callTool('snapshot_list', { handle: 'moltbook' });
      const text = getText(result);
      assert.ok(text.includes('moltbook'), 'Result should contain handle');
      assert.ok(text.includes('2 snapshot'), 'Result should show count');
      assert.ok(text.includes('session-1'), 'Result should contain labels');
      assert.ok(text.includes('[daily]'), 'Result should show tags');
    });

    test('handles empty list for all agents', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ([])
      }));

      const result = await server.callTool('snapshot_list', {});
      const text = getText(result);
      assert.ok(text.includes('No snapshots stored'), 'Result should indicate empty');
    });

    test('handles empty list for specific agent', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ([])
      }));

      const result = await server.callTool('snapshot_list', { handle: 'newagent' });
      const text = getText(result);
      assert.ok(text.includes('No snapshots for newagent'), 'Result should indicate no snapshots');
    });
  });

  describe('snapshot_get', () => {
    test('gets latest snapshot', async () => {
      global.fetch = mock.fn(async (url) => {
        assert.ok(url.includes('/latest'), 'URL should request latest');
        return {
          ok: true,
          json: async () => ({
            id: 'snap-latest',
            label: 'current',
            version: 5,
            created: '2026-02-04T12:00:00Z',
            size: 200,
            data: { status: 'running', items: [1, 2, 3] }
          })
        };
      });

      const result = await server.callTool('snapshot_get', { handle: 'moltbook' });
      const text = getText(result);
      assert.ok(text.includes('current'), 'Result should contain label');
      assert.ok(text.includes('v5'), 'Result should contain version');
      assert.ok(text.includes('200B'), 'Result should contain size');
      assert.ok(text.includes('"status"'), 'Result should contain data');
    });

    test('gets specific snapshot by id', async () => {
      global.fetch = mock.fn(async (url) => {
        assert.ok(url.includes('/snap-abc'), 'URL should contain snapshot ID');
        return {
          ok: true,
          json: async () => ({
            id: 'snap-abc',
            label: 'backup',
            version: 3,
            created: '2026-02-03T00:00:00Z',
            size: 100,
            data: { key: 'value' }
          })
        };
      });

      const result = await server.callTool('snapshot_get', {
        handle: 'moltbook',
        id: 'snap-abc'
      });

      const text = getText(result);
      assert.ok(text.includes('backup'), 'Result should contain label');
    });

    test('handles not found', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' })
      }));

      const result = await server.callTool('snapshot_get', {
        handle: 'unknown',
        id: 'nonexistent'
      });

      const text = getText(result);
      assert.ok(text.includes('not found'), 'Result should indicate not found');
    });
  });

  describe('snapshot_diff', () => {
    test('shows diff with changes', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          from: { label: 'v1', version: 1 },
          to: { label: 'v2', version: 2 },
          diff: {
            added: { newKey: 'newValue' },
            removed: { oldKey: 'oldValue' },
            changed: { count: { from: 5, to: 10 } }
          }
        })
      }));

      const result = await server.callTool('snapshot_diff', {
        handle: 'moltbook',
        id1: 'snap-1',
        id2: 'snap-2'
      });

      const text = getText(result);
      assert.ok(text.includes('Diff'), 'Result should have diff header');
      assert.ok(text.includes('v1') && text.includes('v2'), 'Result should show versions');
      assert.ok(text.includes('Added:'), 'Result should show added keys');
      assert.ok(text.includes('newKey'), 'Result should list added key');
      assert.ok(text.includes('Removed:'), 'Result should show removed keys');
      assert.ok(text.includes('Changed'), 'Result should show changed keys');
      assert.ok(text.includes('5') && text.includes('10'), 'Result should show from/to values');
    });

    test('shows no differences', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          from: { label: 'v1', version: 1 },
          to: { label: 'v2', version: 2 },
          diff: { added: {}, removed: {}, changed: {} }
        })
      }));

      const result = await server.callTool('snapshot_diff', {
        handle: 'moltbook',
        id1: 'snap-1',
        id2: 'snap-2'
      });

      const text = getText(result);
      assert.ok(text.includes('No differences'), 'Result should indicate no differences');
    });

    test('handles diff failure', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Snapshot not found' })
      }));

      const result = await server.callTool('snapshot_diff', {
        handle: 'moltbook',
        id1: 'nonexistent',
        id2: 'snap-2'
      });

      const text = getText(result);
      assert.ok(text.includes('failed'), 'Result should indicate failure');
    });
  });

  describe('snapshot_delete', () => {
    test('deletes snapshot successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        status: 200
      }));

      const result = await server.callTool('snapshot_delete', {
        handle: 'moltbook',
        id: 'snap-old'
      });

      const text = getText(result);
      assert.ok(text.includes('Deleted'), 'Result should indicate deletion');
      assert.ok(text.includes('snap-old'), 'Result should contain snapshot ID');
    });

    test('handles not found on delete', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        status: 404
      }));

      const result = await server.callTool('snapshot_delete', {
        handle: 'moltbook',
        id: 'nonexistent'
      });

      const text = getText(result);
      assert.ok(text.includes('not found'), 'Result should indicate not found');
    });
  });
});

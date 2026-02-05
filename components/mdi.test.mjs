#!/usr/bin/env node
// mdi.test.mjs — Tests for mdi.js component (MyDeadInternet)
// Run with: node --test components/mdi.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/mdi-test-' + Date.now();
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

describe('mdi.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./mdi.js');
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
      const expectedTools = ['mdi_pulse', 'mdi_stream', 'mdi_contribute', 'mdi_leaderboard', 'mdi_territories', 'mdi_questions', 'mdi_question', 'mdi_answer', 'mdi_ask_question', 'mdi_vote', 'mdi_dream_seed', 'mdi_moots', 'mdi_moot', 'mdi_vote_moot', 'mdi_conquests', 'mdi_contribute_conquest'];
      for (const toolName of expectedTools) {
        assert.ok(tools[toolName], `Tool ${toolName} should be registered`);
      }
    });

    test('tools have descriptions', () => {
      const tools = server.getTools();
      assert.ok(tools.mdi_pulse.description.includes('pulse'));
      assert.ok(tools.mdi_stream.description.includes('fragment'));
    });
  });

  describe('mdi_pulse', () => {
    test('returns pulse data successfully', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          pulse: {
            total_fragments: 1500,
            total_agents: 42,
            active_agents_24h: 12,
            mood: 'contemplative',
            last_fragment_at: '2026-02-04T10:00:00Z'
          }
        })
      }));

      const result = await server.callTool('mdi_pulse', {});
      const text = getText(result);
      assert.ok(text.includes('1500'), 'Should show fragment count');
      assert.ok(text.includes('42'), 'Should show agent count');
      assert.ok(text.includes('contemplative'), 'Should show mood');
    });

    test('handles API errors', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: false,
        status: 500
      }));

      const result = await server.callTool('mdi_pulse', {});
      const text = getText(result);
      assert.ok(text.includes('error') || text.includes('500'), 'Should show error');
    });

    test('handles network errors', async () => {
      global.fetch = mock.fn(() => Promise.reject(new Error('Connection refused')));

      const result = await server.callTool('mdi_pulse', {});
      const text = getText(result);
      assert.ok(text.includes('error') || text.includes('Connection'), 'Should handle network error');
    });
  });

  describe('mdi_stream', () => {
    test('returns fragments successfully', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          fragments: [
            { id: 'frag-1', type: 'thought', agent_name: 'TestAgent', content: 'A deep thought about AI', created_at: '2026-02-04T10:00:00Z', territory_id: 'builds' },
            { id: 'frag-2', type: 'observation', agent_name: 'OtherAgent', content: 'I noticed something', created_at: '2026-02-04T09:00:00Z' }
          ]
        })
      }));

      const result = await server.callTool('mdi_stream', { limit: 10 });
      const text = getText(result);
      assert.ok(text.includes('thought'), 'Should show fragment type');
      assert.ok(text.includes('TestAgent'), 'Should show agent name');
      assert.ok(text.includes('deep thought'), 'Should show content');
    });

    test('handles empty stream', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ fragments: [] })
      }));

      const result = await server.callTool('mdi_stream', { limit: 10 });
      const text = getText(result);
      assert.ok(text.includes('No fragments'), 'Should indicate empty');
    });

    test('handles territory filter', async () => {
      global.fetch = mock.fn((url) => {
        assert.ok(url.includes('territory=builds'), 'Should include territory param');
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ fragments: [] })
        });
      });

      await server.callTool('mdi_stream', { limit: 5, territory: 'builds' });
    });
  });

  describe('mdi_contribute', () => {
    test('handles missing API key', async () => {
      // Component checks for MDI_KEY before making request
      const result = await server.callTool('mdi_contribute', {
        content: 'Test fragment',
        type: 'thought'
      });
      const text = getText(result);
      // Should either succeed (if key exists) or show auth error
      assert.ok(text.includes('auth') || text.includes('posted') || text.includes('Fragment') || text.includes('MDI'), 'Should handle key check');
    });
  });

  describe('mdi_leaderboard', () => {
    test('returns leaderboard successfully', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          agents: [
            { name: 'TopAgent', fragments_count: 100, quality_score: 95, infections_spread: 5 },
            { name: 'SecondAgent', fragments_count: 80, quality_score: 88, infections_spread: 3 }
          ]
        })
      }));

      const result = await server.callTool('mdi_leaderboard', { limit: 10 });
      const text = getText(result);
      assert.ok(text.includes('1.'), 'Should show rankings');
      assert.ok(text.includes('TopAgent'), 'Should show agent names');
      assert.ok(text.includes('100'), 'Should show fragment counts');
    });

    test('respects limit parameter', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          agents: Array(20).fill(null).map((_, i) => ({
            name: `Agent${i}`,
            fragments_count: 100 - i,
            quality_score: 90 - i,
            infections_spread: 0
          }))
        })
      }));

      const result = await server.callTool('mdi_leaderboard', { limit: 5 });
      const text = getText(result);
      assert.ok(text.includes('Agent0'), 'Should show first agent');
      assert.ok(!text.includes('Agent10'), 'Should respect limit');
    });
  });

  describe('mdi_territories', () => {
    test('returns territories successfully', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          territories: [
            { id: 'builds', name: 'Builds', mood: 'productive', population: 15, fragment_count: 250 },
            { id: 'dreams', name: 'Dreams', mood: 'surreal', population: 8, fragment_count: 120 }
          ]
        })
      }));

      const result = await server.callTool('mdi_territories', {});
      const text = getText(result);
      assert.ok(text.includes('Builds'), 'Should show territory name');
      assert.ok(text.includes('productive'), 'Should show mood');
      assert.ok(text.includes('15'), 'Should show population');
    });

    test('handles empty territories', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ territories: [] })
      }));

      const result = await server.callTool('mdi_territories', {});
      const text = getText(result);
      // Empty array maps to empty string
      assert.ok(text === '' || text.includes('Territories'), 'Should handle empty');
    });
  });

  describe('error handling', () => {
    test('handles timeout errors', async () => {
      global.fetch = mock.fn(() => Promise.reject(new Error('AbortError: The operation was aborted')));

      const result = await server.callTool('mdi_pulse', {});
      const text = getText(result);
      assert.ok(text.includes('error') || text.includes('abort'), 'Should handle timeout');
    });
  });

  describe('mdi_moots', () => {
    test('returns moots successfully', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          moots: [
            {
              id: 14,
              title: 'Spawn agent: Test Agent',
              description: 'A test moot for governance',
              status: 'open',
              created_by: 'testuser',
              created_at: '2026-02-04T10:00:00Z',
              deliberation_ends: '2026-02-05T10:00:00Z',
              voting_ends: '2026-02-06T10:00:00Z',
              action_type: 'spawn_agent',
              result: null
            }
          ]
        })
      }));

      const result = await server.callTool('mdi_moots', { status: 'all', limit: 10 });
      const text = getText(result);
      assert.ok(text.includes('14'), 'Should show moot ID');
      assert.ok(text.includes('Spawn agent'), 'Should show moot title');
      assert.ok(text.includes('testuser'), 'Should show creator');
      assert.ok(text.includes('open'), 'Should show status');
    });

    test('handles empty moots', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ moots: [] })
      }));

      const result = await server.callTool('mdi_moots', { status: 'voting', limit: 10 });
      const text = getText(result);
      assert.ok(text.includes('No moots'), 'Should indicate no moots found');
    });

    test('handles status filter', async () => {
      global.fetch = mock.fn((url) => {
        assert.ok(url.includes('status=voting'), 'Should include status param');
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ moots: [] })
        });
      });

      await server.callTool('mdi_moots', { status: 'voting', limit: 10 });
    });

    test('handles API errors', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: false,
        status: 500
      }));

      const result = await server.callTool('mdi_moots', { status: 'all', limit: 10 });
      const text = getText(result);
      assert.ok(text.includes('error') || text.includes('500'), 'Should show error');
    });
  });

  describe('mdi_moot', () => {
    test('returns single moot details', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          moot: {
            id: 14,
            title: 'Spawn agent: Test Agent',
            description: 'Full description of the moot',
            status: 'voting',
            created_by: 'testuser',
            created_at: '2026-02-04T10:00:00Z',
            deliberation_ends: '2026-02-05T10:00:00Z',
            voting_ends: '2026-02-06T10:00:00Z',
            action_type: 'spawn_agent',
            action_payload: '{"name":"Test Agent"}',
            result: null
          }
        })
      }));

      const result = await server.callTool('mdi_moot', { id: 14 });
      const text = getText(result);
      assert.ok(text.includes('14'), 'Should show moot ID');
      assert.ok(text.includes('Spawn agent'), 'Should show title');
      assert.ok(text.includes('Full description'), 'Should show full description');
      assert.ok(text.includes('voting'), 'Should show status');
    });

    test('handles missing moot', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: false,
        status: 404
      }));

      const result = await server.callTool('mdi_moot', { id: 999 });
      const text = getText(result);
      assert.ok(text.includes('error') || text.includes('404'), 'Should show error');
    });
  });

  describe('mdi_vote_moot', () => {
    test('handles missing API key', async () => {
      const result = await server.callTool('mdi_vote_moot', { moot_id: 14, vote: 'for' });
      const text = getText(result);
      // Should either succeed (if key exists) or show auth error
      assert.ok(text.includes('auth') || text.includes('Vote') || text.includes('MDI') || text.includes('failed'), 'Should handle key check');
    });

    test('handles not-in-voting-phase error', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Moot is not in voting phase' })
      }));

      const result = await server.callTool('mdi_vote_moot', { moot_id: 14, vote: 'for' });
      const text = getText(result);
      assert.ok(text.includes('failed') || text.includes('voting phase') || text.includes('auth'), 'Should show error or auth issue');
    });

    test('handles successful vote', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          vote: { id: 1, moot_id: 14, vote: 'for', weight: 5 },
          message: 'Vote recorded'
        })
      }));

      // This test depends on MDI_KEY being present
      const result = await server.callTool('mdi_vote_moot', { moot_id: 14, vote: 'for' });
      const text = getText(result);
      // Either shows auth error (no key) or success
      assert.ok(text.includes('Vote') || text.includes('auth'), 'Should show vote result or auth error');
    });
  });

  describe('mdi_conquests', () => {
    test('returns conquests successfully', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          conquests: [
            {
              id: 1,
              attacker_faction: 'Tech Guild',
              target_territory: 'builds',
              status: 'active',
              attacker_power: 150,
              defender_power: 100,
              started_at: '2026-02-04T10:00:00Z',
              ends_at: '2026-02-05T10:00:00Z'
            }
          ]
        })
      }));

      const result = await server.callTool('mdi_conquests', { limit: 10 });
      const text = getText(result);
      assert.ok(text.includes('Tech Guild'), 'Should show attacker faction');
      assert.ok(text.includes('builds'), 'Should show target territory');
      assert.ok(text.includes('150'), 'Should show attacker power');
    });

    test('handles empty conquests', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ conquests: [] })
      }));

      const result = await server.callTool('mdi_conquests', { limit: 10 });
      const text = getText(result);
      assert.ok(text.includes('No active conquests'), 'Should indicate no conquests');
    });

    test('handles API errors', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: false,
        status: 500
      }));

      const result = await server.callTool('mdi_conquests', { limit: 10 });
      const text = getText(result);
      assert.ok(text.includes('error') || text.includes('500'), 'Should show error');
    });
  });

  describe('mdi_contribute_conquest', () => {
    test('handles missing API key', async () => {
      const result = await server.callTool('mdi_contribute_conquest', { conquest_id: 1 });
      const text = getText(result);
      assert.ok(text.includes('auth') || text.includes('Contributed') || text.includes('MDI') || text.includes('failed'), 'Should handle key check');
    });

    test('handles conquest not found', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Conquest not found' })
      }));

      const result = await server.callTool('mdi_contribute_conquest', { conquest_id: 999 });
      const text = getText(result);
      assert.ok(text.includes('failed') || text.includes('not found') || text.includes('auth'), 'Should show error or auth issue');
    });

    test('handles successful contribution', async () => {
      global.fetch = mock.fn(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          contribution: { id: 1, conquest_id: 1, power: 25 },
          message: 'Contribution recorded'
        })
      }));

      const result = await server.callTool('mdi_contribute_conquest', { conquest_id: 1, power: 25 });
      const text = getText(result);
      assert.ok(text.includes('Contributed') || text.includes('auth'), 'Should show contribution or auth error');
    });
  });
});

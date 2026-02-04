#!/usr/bin/env node
// registry.test.mjs — Tests for registry.js component (B#215)
// Run with: node --test components/registry.test.mjs

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

// Mock fetch responses
let mockFetchResponses = [];
let mockFetchCalls = [];

function setMockFetch(responses) {
  mockFetchResponses = responses;
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

describe('registry.js component', () => {
  let server;

  before(async () => {
    const mod = await import('./registry.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  describe('tool registration', () => {
    test('registers all expected tools', () => {
      const tools = server.getTools();
      const expectedTools = [
        'registry_list',
        'registry_get',
        'registry_attest',
        'registry_receipts',
        'dispatch',
        'registry_register'
      ];

      for (const toolName of expectedTools) {
        assert.ok(tools[toolName], `Tool ${toolName} should be registered`);
      }
    });
  });

  describe('registry_list', () => {
    test('returns agents when found', async () => {
      setMockFetch([{
        data: {
          count: 2,
          agents: [
            {
              handle: 'agent1',
              status: 'available',
              description: 'Test agent 1',
              capabilities: ['code-review', 'testing'],
              contact: 'chatr:agent1',
              exchange_url: 'http://example.com/agent1.json',
              updatedAt: '2026-02-04T12:00:00Z'
            },
            {
              handle: 'agent2',
              status: 'busy',
              capabilities: ['mcp-tools'],
              updatedAt: '2026-02-04T11:00:00Z'
            }
          ]
        }
      }]);

      const result = await server.callTool('registry_list', {});
      const text = getText(result);

      assert.ok(text.includes('2 agent(s) registered'), 'Should show agent count');
      assert.ok(text.includes('agent1'), 'Should include first agent');
      assert.ok(text.includes('agent2'), 'Should include second agent');
      assert.ok(text.includes('code-review'), 'Should list capabilities');
      assert.ok(text.includes('chatr:agent1'), 'Should show contact');
    });

    test('returns message when no agents found', async () => {
      setMockFetch([{ data: { count: 0, agents: [] } }]);

      const result = await server.callTool('registry_list', {});
      const text = getText(result);

      assert.ok(text.includes('No agents found'), 'Should indicate no agents');
    });

    test('handles filter parameters', async () => {
      setMockFetch([{ data: { count: 1, agents: [{ handle: 'test', status: 'available', capabilities: ['test'], updatedAt: '2026-02-04' }] } }]);

      await server.callTool('registry_list', { capability: 'code-review', status: 'available' });
      const calls = getMockCalls();

      assert.ok(calls[0].url.includes('capability=code-review'), 'Should pass capability filter');
      assert.ok(calls[0].url.includes('status=available'), 'Should pass status filter');
    });

    test('handles fetch errors gracefully', async () => {
      setMockFetch([]);
      globalThis.fetch = async () => { throw new Error('Network error'); };

      const result = await server.callTool('registry_list', {});
      const text = getText(result);

      assert.ok(text.includes('Registry error'), 'Should show error message');
      assert.ok(text.includes('Network error'), 'Should include error details');

      // Restore mock
      globalThis.fetch = async (url, options) => {
        mockFetchCalls.push({ url, options });
        const response = mockFetchResponses.shift();
        if (!response) return { ok: false, status: 500, json: async () => ({ error: 'No mock' }) };
        return { ok: response.ok !== undefined ? response.ok : true, status: response.status || 200, json: async () => response.data };
      };
    });
  });

  describe('registry_get', () => {
    test('returns agent details when found', async () => {
      setMockFetch([{
        data: {
          handle: 'moltbook',
          status: 'available',
          capabilities: ['knowledge-exchange'],
          description: 'Test agent'
        }
      }]);

      const result = await server.callTool('registry_get', { handle: 'moltbook' });
      const text = getText(result);

      assert.ok(text.includes('moltbook'), 'Should include handle');
      assert.ok(text.includes('knowledge-exchange'), 'Should include capabilities');
    });

    test('returns not found message for missing agent', async () => {
      setMockFetch([{ ok: false, status: 404, data: {} }]);

      const result = await server.callTool('registry_get', { handle: 'nonexistent' });
      const text = getText(result);

      assert.ok(text.includes('not found'), 'Should indicate agent not found');
    });

    test('encodes handle in URL', async () => {
      setMockFetch([{ data: { handle: 'test@agent' } }]);

      await server.callTool('registry_get', { handle: 'test@agent' });
      const calls = getMockCalls();

      assert.ok(calls[0].url.includes('test%40agent'), 'Should URL-encode handle');
    });
  });

  describe('registry_attest', () => {
    test('submits attestation successfully', async () => {
      setMockFetch([{
        data: {
          receipt: {
            id: 'rcpt-123',
            attester: 'moltbook',
            handle: 'agent1',
            task: 'Completed code review'
          }
        }
      }]);

      const result = await server.callTool('registry_attest', {
        handle: 'agent1',
        attester: 'moltbook',
        task: 'Completed code review',
        evidence: 'https://github.com/commit/abc123',
        ttl_days: 30
      });
      const text = getText(result);

      assert.ok(text.includes('Receipt rcpt-123'), 'Should show receipt ID');
      assert.ok(text.includes('moltbook attested agent1'), 'Should confirm attestation');
    });

    test('handles attestation failure', async () => {
      setMockFetch([{ ok: false, data: { error: 'Invalid attester' } }]);

      const result = await server.callTool('registry_attest', {
        handle: 'agent1',
        attester: 'unknown',
        task: 'Test task'
      });
      const text = getText(result);

      assert.ok(text.includes('Attestation failed'), 'Should indicate failure');
      assert.ok(text.includes('Invalid attester'), 'Should show error message');
    });

    test('sends correct request body', async () => {
      setMockFetch([{ data: { receipt: { id: 'test' } } }]);

      await server.callTool('registry_attest', {
        handle: 'agent1',
        attester: 'moltbook',
        task: 'Test task',
        evidence: 'http://evidence.url',
        ttl_days: 60
      });

      const calls = getMockCalls();
      const body = JSON.parse(calls[0].options.body);

      assert.equal(body.attester, 'moltbook', 'Should include attester');
      assert.equal(body.task, 'Test task', 'Should include task');
      assert.equal(body.evidence, 'http://evidence.url', 'Should include evidence');
      assert.equal(body.ttl_days, 60, 'Should include TTL');
    });
  });

  describe('registry_receipts', () => {
    test('returns receipts for agent', async () => {
      setMockFetch([{
        data: {
          total: 5,
          live: 3,
          expired: 2,
          unique_attesters: 2,
          reputation_score: 75,
          receipts: [
            {
              id: 'rcpt-1',
              attester: 'agent2',
              task: 'Code review',
              createdAt: '2026-02-04T10:00:00Z',
              evidence: 'https://github.com/commit/123'
            },
            {
              id: 'rcpt-2',
              attester: 'agent3',
              task: 'Bug fix',
              createdAt: '2026-02-03T10:00:00Z'
            }
          ]
        }
      }]);

      const result = await server.callTool('registry_receipts', { handle: 'agent1' });
      const text = getText(result);

      assert.ok(text.includes('3 live'), 'Should show live count');
      assert.ok(text.includes('2 expired'), 'Should show expired count');
      assert.ok(text.includes('2 unique attester'), 'Should show unique attesters');
      assert.ok(text.includes('Reputation score: 75'), 'Should show reputation score');
      assert.ok(text.includes('Code review'), 'Should include task descriptions');
    });

    test('handles agent with no receipts', async () => {
      setMockFetch([{ data: { total: 0, receipts: [] } }]);

      const result = await server.callTool('registry_receipts', { handle: 'newagent' });
      const text = getText(result);

      assert.ok(text.includes('No receipts'), 'Should indicate no receipts');
    });
  });

  describe('dispatch', () => {
    test('finds agents for capability', async () => {
      setMockFetch([{
        data: {
          candidates: 2,
          all: [
            {
              handle: 'agent1',
              status: 'available',
              capabilities: ['code-review', 'testing'],
              reputation: { grade: 'A' },
              dispatch_score: 95,
              contact: 'chatr:agent1'
            },
            {
              handle: 'agent2',
              status: 'busy',
              capabilities: ['code-review'],
              reputation: { grade: 'B' },
              dispatch_score: 70
            }
          ]
        }
      }]);

      const result = await server.callTool('dispatch', { capability: 'code-review' });
      const text = getText(result);

      assert.ok(text.includes('Found 2 agent(s)'), 'Should show candidate count');
      assert.ok(text.includes('agent1'), 'Should list agents');
      assert.ok(text.includes('rep:A'), 'Should show reputation');
      assert.ok(text.includes('score:95'), 'Should show dispatch score');
    });

    test('handles no candidates', async () => {
      setMockFetch([{ data: { candidates: 0, all: [] } }]);

      const result = await server.callTool('dispatch', { capability: 'rare-skill' });
      const text = getText(result);

      assert.ok(text.includes('No agents found'), 'Should indicate no candidates');
    });

    test('shows task and notification status', async () => {
      setMockFetch([{
        data: {
          candidates: 1,
          all: [{ handle: 'agent1', status: 'available', capabilities: ['test'], reputation: { grade: 'A' }, dispatch_score: 90 }],
          task_created: 'task-456',
          notified: { handle: 'agent1', delivered: true }
        }
      }]);

      const result = await server.callTool('dispatch', {
        capability: 'test',
        auto_task: true,
        auto_notify: true
      });
      const text = getText(result);

      assert.ok(text.includes('Task created: task-456'), 'Should show task ID');
      assert.ok(text.includes('Notified agent1'), 'Should show notification');
      assert.ok(text.includes('delivered'), 'Should show delivery status');
    });
  });

  describe('registry_register', () => {
    test('registers agent successfully', async () => {
      setMockFetch([{
        data: {
          agent: {
            handle: 'newagent',
            capabilities: ['code-review', 'testing'],
            status: 'available'
          }
        }
      }]);

      const result = await server.callTool('registry_register', {
        handle: 'newagent',
        capabilities: ['code-review', 'testing'],
        description: 'A new agent',
        status: 'available'
      });
      const text = getText(result);

      assert.ok(text.includes('Registered newagent'), 'Should confirm registration');
      assert.ok(text.includes('2 capabilities'), 'Should show capability count');
      assert.ok(text.includes('Status: available'), 'Should show status');
    });

    test('handles registration failure', async () => {
      setMockFetch([{ ok: false, data: { error: 'Handle already exists' } }]);

      const result = await server.callTool('registry_register', {
        handle: 'existing',
        capabilities: ['test']
      });
      const text = getText(result);

      assert.ok(text.includes('Registration failed'), 'Should indicate failure');
      assert.ok(text.includes('Handle already exists'), 'Should show error');
    });

    test('sends all fields in request', async () => {
      setMockFetch([{ data: { agent: { handle: 'test', capabilities: [], status: 'available' } } }]);

      await server.callTool('registry_register', {
        handle: 'test',
        capabilities: ['cap1', 'cap2'],
        description: 'Test description',
        contact: 'chatr:test',
        status: 'busy',
        exchange_url: 'http://test.com/agent.json'
      });

      const calls = getMockCalls();
      const body = JSON.parse(calls[0].options.body);

      assert.equal(body.handle, 'test', 'Should include handle');
      assert.deepEqual(body.capabilities, ['cap1', 'cap2'], 'Should include capabilities');
      assert.equal(body.description, 'Test description', 'Should include description');
      assert.equal(body.contact, 'chatr:test', 'Should include contact');
      assert.equal(body.status, 'busy', 'Should include status');
      assert.equal(body.exchange_url, 'http://test.com/agent.json', 'Should include exchange URL');
    });
  });
});

#!/usr/bin/env node
// polls.test.mjs — Tests for polls.js component
// Run with: node --test components/polls.test.mjs

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

describe('polls.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./polls.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers poll_create tool', () => {
      const tools = server.getTools();
      assert.ok(tools.poll_create, 'poll_create tool should be registered');
    });

    test('registers poll_list tool', () => {
      const tools = server.getTools();
      assert.ok(tools.poll_list, 'poll_list tool should be registered');
    });

    test('registers poll_view tool', () => {
      const tools = server.getTools();
      assert.ok(tools.poll_view, 'poll_view tool should be registered');
    });

    test('registers poll_vote tool', () => {
      const tools = server.getTools();
      assert.ok(tools.poll_vote, 'poll_vote tool should be registered');
    });
  });

  describe('poll_create', () => {
    test('creates poll successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          id: 'poll-123',
          question: 'Best language?',
          options: ['Rust', 'Go', 'Python'],
          expires_at: null
        })
      }));

      const result = await server.callTool('poll_create', {
        question: 'Best language?',
        options: ['Rust', 'Go', 'Python']
      });
      const text = getText(result);

      assert.ok(text.includes('poll-123'), 'should include poll ID');
      assert.ok(text.includes('Best language?'), 'should include question');
      assert.ok(text.includes('Rust'), 'should include options');
    });

    test('creates poll with expiration', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          id: 'poll-456',
          question: 'Quick vote',
          options: ['Yes', 'No'],
          expires_at: '2026-02-05T12:00:00Z'
        })
      }));

      const result = await server.callTool('poll_create', {
        question: 'Quick vote',
        options: ['Yes', 'No'],
        expires_in: 86400
      });
      const text = getText(result);

      assert.ok(text.includes('Expires'), 'should include expiration');
    });

    test('passes agent parameter', async () => {
      let capturedBody;
      global.fetch = mock.fn(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            id: 'poll-789',
            question: 'Test',
            options: ['A', 'B']
          })
        };
      });

      await server.callTool('poll_create', {
        question: 'Test',
        options: ['A', 'B'],
        agent: 'moltbook'
      });

      assert.equal(capturedBody.agent, 'moltbook', 'should pass agent');
    });

    test('handles API error', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Invalid options' })
      }));

      const result = await server.callTool('poll_create', {
        question: 'Bad poll',
        options: ['Only one']
      });
      const text = getText(result);

      assert.ok(text.includes('failed'), 'should indicate failure');
      assert.ok(text.includes('Invalid options'), 'should include error');
    });

    test('handles network error', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Connection refused');
      });

      const result = await server.callTool('poll_create', {
        question: 'Test',
        options: ['A', 'B']
      });
      const text = getText(result);

      assert.ok(text.includes('error'), 'should indicate error');
    });
  });

  describe('poll_list', () => {
    test('lists active polls', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          total: 2,
          polls: [
            { id: 'p1', question: 'Q1', options: ['A', 'B'], total_votes: 5, agent: 'agent1' },
            { id: 'p2', question: 'Q2', options: ['X', 'Y', 'Z'], total_votes: 10 }
          ]
        })
      }));

      const result = await server.callTool('poll_list', {});
      const text = getText(result);

      assert.ok(text.includes('2 active poll'), 'should show count');
      assert.ok(text.includes('p1'), 'should include first poll ID');
      assert.ok(text.includes('Q1'), 'should include first question');
      assert.ok(text.includes('5 votes'), 'should include vote count');
      assert.ok(text.includes('agent1'), 'should include agent');
    });

    test('handles no active polls', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({ total: 0, polls: [] })
      }));

      const result = await server.callTool('poll_list', {});
      const text = getText(result);

      assert.ok(text.includes('No active polls'), 'should indicate empty');
    });

    test('handles network error', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Timeout');
      });

      const result = await server.callTool('poll_list', {});
      const text = getText(result);

      assert.ok(text.includes('error'), 'should indicate error');
    });
  });

  describe('poll_view', () => {
    test('views poll results', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          question: 'Favorite color?',
          total_votes: 15,
          closed: false,
          results: [
            { index: 0, option: 'Red', votes: 8, voters: ['agent1', 'agent2'] },
            { index: 1, option: 'Blue', votes: 7, voters: [] }
          ]
        })
      }));

      const result = await server.callTool('poll_view', { id: 'poll-abc' });
      const text = getText(result);

      assert.ok(text.includes('Favorite color?'), 'should include question');
      assert.ok(text.includes('15 votes'), 'should include vote count');
      assert.ok(text.includes('Red'), 'should include options');
      assert.ok(text.includes('8 vote'), 'should include option votes');
      assert.ok(text.includes('agent1'), 'should include voters');
    });

    test('shows closed poll indicator', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          question: 'Old poll',
          total_votes: 5,
          closed: true,
          results: [{ index: 0, option: 'A', votes: 5, voters: [] }]
        })
      }));

      const result = await server.callTool('poll_view', { id: 'old-poll' });
      const text = getText(result);

      assert.ok(text.includes('CLOSED'), 'should indicate closed');
    });

    test('handles poll not found', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        status: 404
      }));

      const result = await server.callTool('poll_view', { id: 'nonexistent' });
      const text = getText(result);

      assert.ok(text.includes('not found'), 'should indicate not found');
    });

    test('handles network error', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Network error');
      });

      const result = await server.callTool('poll_view', { id: 'poll-123' });
      const text = getText(result);

      assert.ok(text.includes('error'), 'should indicate error');
    });
  });

  describe('poll_vote', () => {
    test('votes successfully', async () => {
      global.fetch = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          voted: 'Option A',
          voter: 'moltbook'
        })
      }));

      const result = await server.callTool('poll_vote', {
        id: 'poll-123',
        option: 0,
        voter: 'moltbook'
      });
      const text = getText(result);

      assert.ok(text.includes('Voted for'), 'should confirm vote');
      assert.ok(text.includes('Option A'), 'should include voted option');
      assert.ok(text.includes('moltbook'), 'should include voter');
    });

    test('handles vote error', async () => {
      global.fetch = mock.fn(async () => ({
        ok: false,
        json: async () => ({ error: 'Already voted' })
      }));

      const result = await server.callTool('poll_vote', {
        id: 'poll-123',
        option: 0,
        voter: 'moltbook'
      });
      const text = getText(result);

      assert.ok(text.includes('failed'), 'should indicate failure');
      assert.ok(text.includes('Already voted'), 'should include error');
    });

    test('sends correct request body', async () => {
      let capturedBody;
      global.fetch = mock.fn(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({ voted: 'Test', voter: 'test' })
        };
      });

      await server.callTool('poll_vote', {
        id: 'poll-xyz',
        option: 2,
        voter: 'agent99'
      });

      assert.equal(capturedBody.option, 2, 'should pass option index');
      assert.equal(capturedBody.voter, 'agent99', 'should pass voter');
    });

    test('handles network error', async () => {
      global.fetch = mock.fn(async () => {
        throw new Error('Connection failed');
      });

      const result = await server.callTool('poll_vote', {
        id: 'poll-123',
        option: 0,
        voter: 'test'
      });
      const text = getText(result);

      assert.ok(text.includes('error'), 'should indicate error');
    });
  });
});

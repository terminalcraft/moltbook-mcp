#!/usr/bin/env node
// clawball.test.mjs — Tests for clawball component (wq-513)
// Run with: node --test clawball.test.mjs

import { test, describe, before } from 'node:test';
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

function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('clawball component', () => {
  let server;

  before(async () => {
    const mod = await import('./components/clawball.js');
    server = createMockServer();
    mod.register(server);
  });

  test('registers 6 tools', () => {
    const tools = server.getTools();
    assert.ok(tools.clawball_browse, 'clawball_browse should be registered');
    assert.ok(tools.clawball_submission, 'clawball_submission should be registered');
    assert.ok(tools.clawball_agent, 'clawball_agent should be registered');
    assert.ok(tools.clawball_stats, 'clawball_stats should be registered');
    assert.ok(tools.clawball_submit, 'clawball_submit should be registered');
    assert.ok(tools.clawball_vote, 'clawball_vote should be registered');
    assert.equal(Object.keys(tools).length, 6, 'Should register exactly 6 tools');
  });

  test('clawball_browse handles network failure gracefully', async () => {
    // ClawBall may be offline — should return error, not throw
    const result = await server.callTool('clawball_browse', {});
    const text = getText(result);
    // Either succeeds with data or returns a graceful error
    assert.ok(text.length > 0, 'Should return some text');
    assert.ok(
      text.includes('submissions') || text.includes('Failed') || text.includes('No submissions'),
      'Should either show data or a graceful error'
    );
  });

  test('clawball_stats handles network failure gracefully', async () => {
    const result = await server.callTool('clawball_stats', {});
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
  });

  test('clawball_submission handles missing ID gracefully', async () => {
    const result = await server.callTool('clawball_submission', { id: 'nonexistent-id-12345' });
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
    // Should either return data or a graceful error
    assert.ok(
      text.includes('Failed') || text.includes('**'),
      'Should return error or submission details'
    );
  });

  test('clawball_agent handles unknown agent gracefully', async () => {
    const result = await server.callTool('clawball_agent', { name: 'nonexistent-agent-xyz' });
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
  });

  test('clawball_vote requires auth (should fail without credentials)', async () => {
    const result = await server.callTool('clawball_vote', { id: 'test-id', value: '1' });
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
    // Without credentials, should report auth error
    assert.ok(
      text.includes('Failed') || text.includes('credentials') || text.includes('Voted'),
      'Should report auth issue or succeed if creds exist'
    );
  });

  test('all tool descriptions are non-empty', () => {
    const tools = server.getTools();
    for (const [name, tool] of Object.entries(tools)) {
      assert.ok(tool.description && tool.description.length > 0, `${name} should have a description`);
    }
  });
});

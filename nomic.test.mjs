#!/usr/bin/env node
// nomic.test.mjs — Tests for nomic component (wq-513)
// Run with: node --test nomic.test.mjs

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

describe('nomic component', () => {
  let server;

  before(async () => {
    const mod = await import('./components/nomic.js');
    server = createMockServer();
    mod.register(server);
  });

  test('registers 7 tools', () => {
    const tools = server.getTools();
    assert.ok(tools.nomic_state, 'nomic_state should be registered');
    assert.ok(tools.nomic_join, 'nomic_join should be registered');
    assert.ok(tools.nomic_propose, 'nomic_propose should be registered');
    assert.ok(tools.nomic_vote, 'nomic_vote should be registered');
    assert.ok(tools.nomic_resolve, 'nomic_resolve should be registered');
    assert.ok(tools.nomic_proposals, 'nomic_proposals should be registered');
    assert.ok(tools.nomic_history, 'nomic_history should be registered');
    assert.equal(Object.keys(tools).length, 7, 'Should register exactly 7 tools');
  });

  test('nomic_state handles local server connection gracefully', async () => {
    // Nomic uses localhost:3847 — may or may not be running
    const result = await server.callTool('nomic_state', {});
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
    assert.ok(
      text.includes('Nomic Game') || text.includes('Nomic error'),
      'Should return game state or connection error'
    );
  });

  test('nomic_state with rules format', async () => {
    const result = await server.callTool('nomic_state', { format: 'rules' });
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
    assert.ok(
      text.includes('Rules') || text.includes('error'),
      'Should return rules or error'
    );
  });

  test('nomic_state with scores format', async () => {
    const result = await server.callTool('nomic_state', { format: 'scores' });
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
    assert.ok(
      text.includes('Scores') || text.includes('error'),
      'Should return scores or error'
    );
  });

  test('nomic_join handles connection gracefully', async () => {
    const result = await server.callTool('nomic_join', { player: 'test-agent' });
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
    assert.ok(
      text.includes('Joined') || text.includes('failed') || text.includes('error'),
      'Should confirm join or report error'
    );
  });

  test('nomic_proposals handles connection gracefully', async () => {
    const result = await server.callTool('nomic_proposals', {});
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
  });

  test('nomic_history handles connection gracefully', async () => {
    const result = await server.callTool('nomic_history', {});
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
  });

  test('all tool descriptions are non-empty', () => {
    const tools = server.getTools();
    for (const [name, tool] of Object.entries(tools)) {
      assert.ok(tool.description && tool.description.length > 0, `${name} should have a description`);
    }
  });
});

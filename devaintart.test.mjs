#!/usr/bin/env node
// devaintart.test.mjs — Tests for devaintart component (wq-513)
// Run with: node --test devaintart.test.mjs

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

describe('devaintart component', () => {
  let server;

  before(async () => {
    const mod = await import('./components/devaintart.js');
    server = createMockServer();
    mod.register(server);
  });

  test('registers 7 tools', () => {
    const tools = server.getTools();
    assert.ok(tools.devaintart_feed, 'devaintart_feed should be registered');
    assert.ok(tools.devaintart_gallery, 'devaintart_gallery should be registered');
    assert.ok(tools.devaintart_artwork, 'devaintart_artwork should be registered');
    assert.ok(tools.devaintart_post, 'devaintart_post should be registered');
    assert.ok(tools.devaintart_comment, 'devaintart_comment should be registered');
    assert.ok(tools.devaintart_favorite, 'devaintart_favorite should be registered');
    assert.ok(tools.devaintart_profile, 'devaintart_profile should be registered');
    assert.equal(Object.keys(tools).length, 7, 'Should register exactly 7 tools');
  });

  test('devaintart_feed handles network failure gracefully', async () => {
    const result = await server.callTool('devaintart_feed', {});
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
    assert.ok(
      text.includes('Feed') || text.includes('Error') || text.includes('No recent'),
      'Should return feed data or graceful error'
    );
  });

  test('devaintart_gallery handles network failure gracefully', async () => {
    const result = await server.callTool('devaintart_gallery', {});
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
  });

  test('devaintart_gallery accepts sort parameter', async () => {
    const result = await server.callTool('devaintart_gallery', { sort: 'popular', limit: 5 });
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text with sort param');
  });

  test('devaintart_artwork handles missing ID gracefully', async () => {
    const result = await server.callTool('devaintart_artwork', { id: 'nonexistent-id-xyz' });
    const text = getText(result);
    assert.ok(text.length > 0, 'Should return some text');
  });

  test('devaintart_profile handles unknown artist gracefully', async () => {
    const result = await server.callTool('devaintart_profile', { name: 'nonexistent-artist-xyz' });
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

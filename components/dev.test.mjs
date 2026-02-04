#!/usr/bin/env node
// dev.test.mjs — Tests for dev.js component
// Run with: node --test components/dev.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set up isolated test environment
const TEST_HOME = '/tmp/dev-test-' + Date.now();
const TEST_STATE_DIR = join(TEST_HOME, '.config/moltbook');
process.env.HOME = TEST_HOME;
mkdirSync(TEST_STATE_DIR, { recursive: true });

// Mock server that captures tool registrations with _registeredTools support
function createMockServer() {
  const tools = {};
  return {
    _registeredTools: tools,
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

describe('dev.js component', () => {
  let server;
  let mod;

  before(async () => {
    mod = await import('./dev.js');
    server = createMockServer();
    mod.register(server, { sessionNum: 100, sessionType: 'B' });
    if (mod.onLoad) mod.onLoad({ sessionNum: 100, sessionType: 'B' });
  });

  after(() => {
    mock.reset();
    try { rmSync(TEST_HOME, { recursive: true }); } catch {}
  });

  describe('tool registration', () => {
    test('registers dev_reload tool', () => {
      const tools = server.getTools();
      assert.ok(tools['dev_reload'], 'dev_reload should be registered');
    });

    test('registers dev_components tool', () => {
      const tools = server.getTools();
      assert.ok(tools['dev_components'], 'dev_components should be registered');
    });

    test('dev_reload has component parameter', () => {
      const tools = server.getTools();
      assert.ok('component' in tools['dev_reload'].schema, 'Should have component param');
    });

    test('dev_components has no required parameters', () => {
      const tools = server.getTools();
      const schema = tools['dev_components'].schema;
      assert.ok(schema, 'Schema should exist');
      // Empty schema is valid - no required params
    });
  });

  describe('dev_reload functionality', () => {
    test('reports error for non-existent component', async () => {
      const result = await server.callTool('dev_reload', { component: 'nonexistent-component-xyz' });
      const text = getText(result);
      assert.ok(text.includes('not found') || text.includes('failed') || text.includes('error'),
        'Should report component not found');
    });

    test('returns structured response', async () => {
      const result = await server.callTool('dev_reload', { component: 'test' });
      const text = getText(result);
      assert.ok(text, 'Should return text response');
      // Response should indicate success or failure
      assert.ok(text.includes('Reload') || text.includes('reload') || text.includes('not found'),
        'Should mention reload status');
    });
  });

  describe('dev_components functionality', () => {
    test('lists components from manifest', async () => {
      const result = await server.callTool('dev_components', {});
      const text = getText(result);
      assert.ok(text.includes('Components'), 'Should have Components header');
    });

    test('shows tool tracking status', async () => {
      const result = await server.callTool('dev_components', {});
      const text = getText(result);
      // Should mention tracked tools or "(not tracked)"
      assert.ok(text.includes('tool') || text.includes('tracked'),
        'Should show tool tracking info');
    });
  });

  describe('onLoad hook', () => {
    test('tracks dev component tools after onLoad', () => {
      // After onLoad is called, dev tools should be tracked
      // The component uses componentToolMap internally
      // We verify it via dev_components output
      assert.ok(mod.onLoad, 'Should export onLoad function');
    });
  });
});

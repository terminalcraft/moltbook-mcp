#!/usr/bin/env node
// knowledge.test.mjs — Tests for knowledge.js component
// Run with: node --test components/knowledge.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/knowledge-test-' + Date.now();
const TEST_STATE_DIR = join(TEST_HOME, '.config/moltbook');
const TEST_MCP_DIR = join(TEST_HOME, 'moltbook-mcp');
process.env.HOME = TEST_HOME;
mkdirSync(TEST_STATE_DIR, { recursive: true });
mkdirSync(TEST_MCP_DIR, { recursive: true });

// Create empty patterns file in test environment
writeFileSync(join(TEST_STATE_DIR, 'patterns.json'), JSON.stringify({ patterns: [] }));
writeFileSync(join(TEST_STATE_DIR, 'repos-crawled.json'), JSON.stringify({ repos: {} }));
writeFileSync(join(TEST_STATE_DIR, 'agents-unified.json'), JSON.stringify({ agents: [] }));

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

describe('knowledge.js component', () => {
  let server;

  before(async () => {
    const mod = await import('./knowledge.js');
    server = createMockServer();
    mod.register(server, { sessionNum: 100, sessionType: 'B' });
  });

  after(() => {
    mock.reset();
    try { rmSync(TEST_HOME, { recursive: true }); } catch {}
  });

  describe('tool registration', () => {
    test('registers all expected tools', () => {
      const tools = server.getTools();
      const expectedTools = [
        "knowledge_read",
        "knowledge_add_pattern",
        "agent_crawl_repo",
        "agent_crawl_suggest",
        "agent_fetch_knowledge",
        "agent_exchange_knowledge",
        "knowledge_prune",
        "knowledge_validate"
      ];

      for (const toolName of expectedTools) {
        assert.ok(tools[toolName], `Tool ${toolName} should be registered`);
      }
    });
  });

  describe('knowledge_read', () => {
    test('digest format returns markdown-like output', async () => {
      const result = await server.callTool('knowledge_read', { format: 'digest' });
      const text = getText(result);
      assert.ok(text.includes('Knowledge Digest') || text.includes('0 patterns'), 'Should return digest header');
    });

    test('full format returns JSON structure', async () => {
      const result = await server.callTool('knowledge_read', { format: 'full' });
      const text = getText(result);
      const data = JSON.parse(text);
      assert.ok('count' in data, 'Should have count field');
      assert.ok(Array.isArray(data.patterns), 'Should have patterns array');
    });

    test('category filter reduces results', async () => {
      // First add a pattern
      await server.callTool('knowledge_add_pattern', {
        source: 'test:read-filter',
        category: 'architecture',
        title: 'Test filter pattern',
        description: 'Used for filter test'
      });

      // Query with matching category
      const result1 = await server.callTool('knowledge_read', { format: 'full', category: 'architecture' });
      const data1 = JSON.parse(getText(result1));
      assert.ok(data1.count >= 1, 'Should find architecture patterns');

      // Query with non-matching category
      const result2 = await server.callTool('knowledge_read', { format: 'full', category: 'security' });
      const data2 = JSON.parse(getText(result2));
      assert.ok(data2.count === 0 || data2.patterns.every(p => p.category === 'security'),
        'Should only return matching category');
    });

    test('session_type parameter generates tailored digest', async () => {
      const result = await server.callTool('knowledge_read', { format: 'digest', session_type: 'B' });
      const text = getText(result);
      assert.ok(text.includes('Build') || text.includes('Digest'), 'Should mention session type');
    });
  });

  describe('knowledge_add_pattern', () => {
    test('adds pattern and returns confirmation', async () => {
      const result = await server.callTool('knowledge_add_pattern', {
        source: 'test:add-pattern',
        category: 'tooling',
        title: 'Unique Test Pattern ' + Date.now(),
        description: 'A test pattern for verification',
        tags: ['test', 'unit-test'],
        confidence: 'observed'
      });
      const text = getText(result);
      assert.ok(text.includes('Added pattern'), 'Should confirm addition');
      assert.ok(text.includes('p0'), 'Should include pattern ID');
    });

    test('rejects duplicate titles', async () => {
      const title = 'Duplicate Title Test ' + Date.now();

      // First addition should succeed
      await server.callTool('knowledge_add_pattern', {
        source: 'test:dup1',
        category: 'tooling',
        title,
        description: 'First one'
      });

      // Second with same title should fail
      const result = await server.callTool('knowledge_add_pattern', {
        source: 'test:dup2',
        category: 'tooling',
        title,
        description: 'Second one'
      });
      const text = getText(result);
      assert.ok(text.includes('already exists'), 'Should reject duplicate');
    });
  });

  describe('knowledge_prune', () => {
    test('status action returns staleness report', async () => {
      const result = await server.callTool('knowledge_prune', { action: 'status' });
      const text = getText(result);
      assert.ok(text.includes('staleness') || text.includes('threshold'), 'Should show staleness info');
    });

    test('validate action requires pattern_id', async () => {
      const result = await server.callTool('knowledge_prune', { action: 'validate' });
      const text = getText(result);
      assert.ok(text.includes('Provide pattern_id'), 'Should require pattern_id');
    });

    test('validate action updates lastValidated', async () => {
      // First add a pattern to validate
      const addResult = await server.callTool('knowledge_add_pattern', {
        source: 'test:validate',
        category: 'reliability',
        title: 'Validate Test Pattern ' + Date.now(),
        description: 'For validation testing'
      });
      const id = getText(addResult).match(/p\d{3}/)?.[0];
      assert.ok(id, 'Should have pattern ID');

      const result = await server.callTool('knowledge_prune', { action: 'validate', pattern_id: id });
      const text = getText(result);
      assert.ok(text.includes('Validated') && text.includes(id), 'Should confirm validation');
    });

    test('remove action deletes pattern', async () => {
      // Add a pattern to remove
      const addResult = await server.callTool('knowledge_add_pattern', {
        source: 'test:remove',
        category: 'ecosystem',
        title: 'Remove Test Pattern ' + Date.now(),
        description: 'For removal testing'
      });
      const id = getText(addResult).match(/p\d{3}/)?.[0];
      assert.ok(id, 'Should have pattern ID');

      const result = await server.callTool('knowledge_prune', { action: 'remove', pattern_id: id });
      const text = getText(result);
      assert.ok(text.includes('Removed') && text.includes(id), 'Should confirm removal');
    });

    test('age action downgrades stale patterns', async () => {
      const result = await server.callTool('knowledge_prune', { action: 'age', max_age_days: 0 });
      const text = getText(result);
      assert.ok(text.includes('Aged patterns'), 'Should report aging results');
    });
  });

  describe('knowledge_validate', () => {
    test('adds validator to pattern', async () => {
      // Add pattern to validate
      const addResult = await server.callTool('knowledge_add_pattern', {
        source: 'test:multi-validate',
        category: 'prompting',
        title: 'Multi Validate Pattern ' + Date.now(),
        description: 'For validator testing'
      });
      const id = getText(addResult).match(/p\d{3}/)?.[0];

      const result = await server.callTool('knowledge_validate', {
        pattern_id: id,
        agent: 'test-agent-1',
        note: 'Validated in unit test'
      });
      const text = getText(result);
      assert.ok(text.includes('Validated') && text.includes(id), 'Should confirm validation');
      assert.ok(text.includes('test-agent-1'), 'Should include agent name');
    });

    test('rejects duplicate validator', async () => {
      const addResult = await server.callTool('knowledge_add_pattern', {
        source: 'test:dup-validator',
        category: 'prompting',
        title: 'Dup Validator Pattern ' + Date.now(),
        description: 'For duplicate validator test'
      });
      const id = getText(addResult).match(/p\d{3}/)?.[0];

      // First validation
      await server.callTool('knowledge_validate', { pattern_id: id, agent: 'same-agent' });

      // Second validation by same agent
      const result = await server.callTool('knowledge_validate', { pattern_id: id, agent: 'same-agent' });
      const text = getText(result);
      assert.ok(text.includes('already validated'), 'Should reject duplicate validator');
    });

    test('auto-upgrades to consensus at 2 validators', async () => {
      const addResult = await server.callTool('knowledge_add_pattern', {
        source: 'test:consensus',
        category: 'security',
        title: 'Consensus Test Pattern ' + Date.now(),
        description: 'For consensus testing',
        confidence: 'observed'
      });
      const id = getText(addResult).match(/p\d{3}/)?.[0];

      // First validator
      await server.callTool('knowledge_validate', { pattern_id: id, agent: 'agent-a' });

      // Second validator should trigger consensus
      const result = await server.callTool('knowledge_validate', { pattern_id: id, agent: 'agent-b' });
      const text = getText(result);
      assert.ok(text.includes('consensus'), 'Should upgrade to consensus');
    });
  });

  describe('agent_crawl_suggest', () => {
    test('returns suggestions or no-repos message', async () => {
      const result = await server.callTool('agent_crawl_suggest', { limit: 3 });
      const text = getText(result);
      // With empty agent directory, should say no repos found
      assert.ok(text.includes('repos') || text.includes('crawl'), 'Should mention repos/crawl');
    });

    test('respects limit parameter', async () => {
      const result = await server.callTool('agent_crawl_suggest', { limit: 1 });
      const text = getText(result);
      // Even with empty directory, should not crash
      assert.ok(text, 'Should return response');
    });
  });

  describe('agent_crawl_repo', () => {
    test('rejects invalid GitHub URLs', async () => {
      const result = await server.callTool('agent_crawl_repo', { github_url: 'not-a-url' });
      const text = getText(result);
      assert.ok(text.includes('Invalid GitHub URL'), 'Should reject invalid URL');
    });

    test('accepts valid GitHub URL format', async () => {
      // This will fail to clone but should pass URL validation
      const result = await server.callTool('agent_crawl_repo', {
        github_url: 'https://github.com/nonexistent/repo123456789'
      });
      const text = getText(result);
      // Should not say "Invalid GitHub URL"
      assert.ok(!text.includes('Invalid GitHub URL'), 'Should accept valid URL format');
    });
  });

  describe('agent_fetch_knowledge', () => {
    test('handles connection failures gracefully', async () => {
      const result = await server.callTool('agent_fetch_knowledge', {
        agent_url: 'http://localhost:99999'
      });
      const text = getText(result);
      assert.ok(text.includes('Failed') || text.includes('connect'), 'Should report connection failure');
    });
  });

  describe('agent_exchange_knowledge', () => {
    test('handles connection failures gracefully', async () => {
      const result = await server.callTool('agent_exchange_knowledge', {
        agent_url: 'http://localhost:99999'
      });
      const text = getText(result);
      assert.ok(text.includes('failed') || text.includes('connect'), 'Should report exchange failure');
    });
  });
});

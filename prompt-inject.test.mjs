#!/usr/bin/env node
// prompt-inject.test.mjs — Tests for prompt-inject component (wq-111)
// Run with: node --test prompt-inject.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, 'prompt-inject.json');
const BACKUP_PATH = join(__dirname, 'prompt-inject.json.test-backup');

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

describe('prompt-inject component', () => {
  let server;
  let originalManifest;

  before(async () => {
    // Backup original manifest
    if (existsSync(MANIFEST_PATH)) {
      copyFileSync(MANIFEST_PATH, BACKUP_PATH);
      originalManifest = readFileSync(MANIFEST_PATH, 'utf8');
    }

    // Create test manifest
    writeFileSync(MANIFEST_PATH, JSON.stringify({
      version: 1,
      description: "Test prompt injection manifest",
      injections: [
        { file: "existing-inject.txt", action: "keep", priority: 50, sessions: "BR", description: "Test injection" }
      ]
    }, null, 2));

    // Import fresh module (need dynamic import to pick up test file)
    const mod = await import('./components/prompt-inject.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    // Restore original manifest
    if (originalManifest) {
      writeFileSync(MANIFEST_PATH, originalManifest);
    } else if (existsSync(BACKUP_PATH)) {
      copyFileSync(BACKUP_PATH, MANIFEST_PATH);
    }
    if (existsSync(BACKUP_PATH)) {
      unlinkSync(BACKUP_PATH);
    }
  });

  test('registers 5 tools', () => {
    const tools = server.getTools();
    assert.ok(tools.prompt_inject_list, 'prompt_inject_list should be registered');
    assert.ok(tools.prompt_inject_add, 'prompt_inject_add should be registered');
    assert.ok(tools.prompt_inject_update, 'prompt_inject_update should be registered');
    assert.ok(tools.prompt_inject_remove, 'prompt_inject_remove should be registered');
    assert.ok(tools.prompt_inject_reorder, 'prompt_inject_reorder should be registered');
    assert.equal(Object.keys(tools).length, 5, 'Should register exactly 5 tools');
  });

  describe('prompt_inject_list', () => {
    test('lists existing injections', async () => {
      const result = await server.callTool('prompt_inject_list', {});
      const text = getText(result);
      assert.match(text, /existing-inject\.txt/);
      assert.match(text, /pri: 50/);
    });

    test('shows empty message when no injections', async () => {
      // Temporarily clear injections
      const current = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      writeFileSync(MANIFEST_PATH, JSON.stringify({ ...current, injections: [] }, null, 2));

      const result = await server.callTool('prompt_inject_list', {});
      const text = getText(result);
      assert.match(text, /No prompt injections configured/);

      // Restore
      writeFileSync(MANIFEST_PATH, JSON.stringify(current, null, 2));
    });
  });

  describe('prompt_inject_add', () => {
    test('adds a new injection with defaults', async () => {
      const result = await server.callTool('prompt_inject_add', {
        file: 'test-new.txt',
        description: 'A test injection'
      });
      const text = getText(result);
      assert.match(text, /Added injection 'test-new\.txt'/);
      assert.match(text, /priority 100/); // default
      assert.match(text, /keep/); // default action
      assert.match(text, /BEBRA/); // default sessions

      // Verify in manifest
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      const added = manifest.injections.find(i => i.file === 'test-new.txt');
      assert.ok(added, 'Injection should be in manifest');
      assert.equal(added.priority, 100);
      assert.equal(added.action, 'keep');
    });

    test('adds injection with custom values', async () => {
      const result = await server.callTool('prompt_inject_add', {
        file: 'custom-inject.txt',
        description: 'Custom injection',
        priority: 25,
        action: 'consume',
        sessions: 'RA'
      });
      const text = getText(result);
      assert.match(text, /priority 25/);
      assert.match(text, /consume/);
      assert.match(text, /sessions: RA/);
    });

    test('rejects duplicate file names', async () => {
      const result = await server.callTool('prompt_inject_add', {
        file: 'existing-inject.txt',
        description: 'Duplicate'
      });
      const text = getText(result);
      assert.match(text, /already exists/);
    });
  });

  describe('prompt_inject_update', () => {
    test('updates existing injection', async () => {
      const result = await server.callTool('prompt_inject_update', {
        file: 'existing-inject.txt',
        priority: 75,
        action: 'consume'
      });
      const text = getText(result);
      assert.match(text, /Updated 'existing-inject\.txt'/);
      assert.match(text, /priority=75/);
      assert.match(text, /action=consume/);

      // Verify change
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      const updated = manifest.injections.find(i => i.file === 'existing-inject.txt');
      assert.equal(updated.priority, 75);
      assert.equal(updated.action, 'consume');
    });

    test('returns error for non-existent injection', async () => {
      const result = await server.callTool('prompt_inject_update', {
        file: 'non-existent.txt',
        priority: 1
      });
      const text = getText(result);
      assert.match(text, /not found/);
    });

    test('updates only specified fields', async () => {
      // Add a fresh injection
      await server.callTool('prompt_inject_add', {
        file: 'partial-update.txt',
        description: 'Original desc',
        priority: 10,
        action: 'keep',
        sessions: 'B'
      });

      // Update only description
      await server.callTool('prompt_inject_update', {
        file: 'partial-update.txt',
        description: 'Updated desc'
      });

      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      const updated = manifest.injections.find(i => i.file === 'partial-update.txt');
      assert.equal(updated.description, 'Updated desc');
      assert.equal(updated.priority, 10, 'Priority should be unchanged');
      assert.equal(updated.action, 'keep', 'Action should be unchanged');
    });
  });

  describe('prompt_inject_remove', () => {
    test('removes existing injection', async () => {
      // Add one to remove
      await server.callTool('prompt_inject_add', {
        file: 'to-remove.txt',
        description: 'Will be removed'
      });

      const result = await server.callTool('prompt_inject_remove', {
        file: 'to-remove.txt'
      });
      const text = getText(result);
      assert.match(text, /Removed injection 'to-remove\.txt'/);

      // Verify removal
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      const removed = manifest.injections.find(i => i.file === 'to-remove.txt');
      assert.ok(!removed, 'Injection should be removed from manifest');
    });

    test('returns error for non-existent injection', async () => {
      const result = await server.callTool('prompt_inject_remove', {
        file: 'definitely-not-there.txt'
      });
      const text = getText(result);
      assert.match(text, /not found/);
    });
  });

  describe('prompt_inject_reorder', () => {
    test('changes priority of injection', async () => {
      // Add one to reorder
      await server.callTool('prompt_inject_add', {
        file: 'reorder-me.txt',
        description: 'Will be reordered',
        priority: 100
      });

      const result = await server.callTool('prompt_inject_reorder', {
        file: 'reorder-me.txt',
        new_priority: 5
      });
      const text = getText(result);
      assert.match(text, /Changed 'reorder-me\.txt' priority/);
      assert.match(text, /100 → 5/);

      // Verify
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
      const updated = manifest.injections.find(i => i.file === 'reorder-me.txt');
      assert.equal(updated.priority, 5);
    });

    test('returns error for non-existent injection', async () => {
      const result = await server.callTool('prompt_inject_reorder', {
        file: 'ghost.txt',
        new_priority: 1
      });
      const text = getText(result);
      assert.match(text, /not found/);
    });
  });
});

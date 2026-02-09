#!/usr/bin/env node
// mention-aggregator.test.mjs — Tests for mention-aggregator component (wq-513)
// Run with: node --test mention-aggregator.test.mjs

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';

const HOME = process.env.HOME || '/home/moltbot';
const MENTIONS_PATH = join(HOME, '.config/moltbook/mentions.json');
const MENTIONS_BACKUP = MENTIONS_PATH + '.test-backup';

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

describe('mention-aggregator component', () => {
  let server;
  let originalMentions;

  before(async () => {
    // Backup original mentions file
    if (existsSync(MENTIONS_PATH)) {
      originalMentions = readFileSync(MENTIONS_PATH, 'utf8');
    }

    // Ensure config dir exists
    mkdirSync(join(HOME, '.config/moltbook'), { recursive: true });

    // Write test mentions state
    writeFileSync(MENTIONS_PATH, JSON.stringify({
      version: 1,
      lastScan: null,
      mentions: [
        { id: 'test-1', platform: 'TestPlatform', author: 'alice', content: 'Hey @moltbook', read: false, timestamp: '2026-02-09T00:00:00Z' },
        { id: 'test-2', platform: 'TestPlatform', author: 'bob', content: 'moltbook rocks', read: true, timestamp: '2026-02-09T01:00:00Z' }
      ],
      seenIds: ['test-1', 'test-2']
    }, null, 2));

    const mod = await import('./components/mention-aggregator.js');
    server = createMockServer();
    mod.register(server, {});
  });

  after(() => {
    if (originalMentions) {
      writeFileSync(MENTIONS_PATH, originalMentions);
    } else if (existsSync(MENTIONS_BACKUP)) {
      writeFileSync(MENTIONS_PATH, readFileSync(MENTIONS_BACKUP, 'utf8'));
    }
  });

  test('registers 4 tools', () => {
    const tools = server.getTools();
    assert.ok(tools.mentions_scan, 'mentions_scan should be registered');
    assert.ok(tools.mentions_list, 'mentions_list should be registered');
    assert.ok(tools.mentions_mark_read, 'mentions_mark_read should be registered');
    assert.ok(tools.mentions_draft_response, 'mentions_draft_response should be registered');
    assert.equal(Object.keys(tools).length, 4, 'Should register exactly 4 tools');
  });

  test('mentions_list returns mentions', async () => {
    const result = await server.callTool('mentions_list', {});
    const text = getText(result);
    assert.ok(text.includes('mention(s)'), 'Should show mention count');
    assert.ok(text.includes('TestPlatform'), 'Should show platform name');
    assert.ok(text.includes('alice'), 'Should show author name');
  });

  test('mentions_list filters by unread', async () => {
    const result = await server.callTool('mentions_list', { unread: true });
    const text = getText(result);
    assert.ok(text.includes('alice'), 'Should show unread mention from alice');
    assert.ok(!text.includes('bob'), 'Should not show read mention from bob');
  });

  test('mentions_list filters by platform', async () => {
    const result = await server.callTool('mentions_list', { platform: 'TestPlatform' });
    const text = getText(result);
    assert.ok(text.includes('mention(s)'), 'Should return results');
  });

  test('mentions_list returns empty message for unknown platform', async () => {
    const result = await server.callTool('mentions_list', { platform: 'NonExistent' });
    const text = getText(result);
    assert.ok(text.includes('No mentions found'), 'Should say no mentions found');
  });

  test('mentions_mark_read requires platform or all', async () => {
    const result = await server.callTool('mentions_mark_read', {});
    const text = getText(result);
    assert.ok(text.includes('Error'), 'Should return error when no filter specified');
  });

  test('mentions_mark_read marks all read', async () => {
    // Reset test state
    writeFileSync(MENTIONS_PATH, JSON.stringify({
      version: 1,
      lastScan: null,
      mentions: [
        { id: 'test-1', platform: 'TestPlatform', author: 'alice', content: 'Hey @moltbook', read: false, timestamp: '2026-02-09T00:00:00Z' }
      ],
      seenIds: ['test-1']
    }, null, 2));

    const result = await server.callTool('mentions_mark_read', { all: true });
    const text = getText(result);
    assert.ok(text.includes('Marked'), 'Should confirm marks');
    assert.ok(text.includes('1'), 'Should mark 1 mention');
  });

  test('mentions_scan respects rate limit', async () => {
    // Set recent lastScan
    writeFileSync(MENTIONS_PATH, JSON.stringify({
      version: 1,
      lastScan: new Date().toISOString(),
      mentions: [],
      seenIds: []
    }, null, 2));

    const result = await server.callTool('mentions_scan', {});
    const text = getText(result);
    assert.ok(text.includes('ago') || text.includes('unread'), 'Should indicate recent scan or rate limit');
  });

  test('mentions_draft_response handles missing mention', async () => {
    const result = await server.callTool('mentions_draft_response', { mention_id: 'nonexistent-id-xyz' });
    const text = getText(result);
    assert.ok(text.includes('Error') || text.includes('not found'), 'Should return error for missing mention');
  });
});

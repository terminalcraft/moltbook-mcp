#!/usr/bin/env node
// notifications.test.mjs — Tests for notifications.js component
// Run with: node --test components/notifications.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';

// Set up isolated test environment
const TEST_HOME = '/tmp/notifications-test-' + Date.now();
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

describe('notifications.js component', () => {
  let server;
  let originalFetch;

  before(async () => {
    originalFetch = global.fetch;
    const mod = await import('./notifications.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    global.fetch = originalFetch;
    mock.reset();
  });

  describe('tool registration', () => {
    test('registers notif_subscribe tool', () => {
      const tools = server.getTools();
      assert.ok(tools['notif_subscribe'], 'notif_subscribe should be registered');
    });

    test('registers notif_unsubscribe tool', () => {
      const tools = server.getTools();
      assert.ok(tools['notif_unsubscribe'], 'notif_unsubscribe should be registered');
    });

    test('registers notif_check tool', () => {
      const tools = server.getTools();
      assert.ok(tools['notif_check'], 'notif_check should be registered');
    });

    test('registers notif_read tool', () => {
      const tools = server.getTools();
      assert.ok(tools['notif_read'], 'notif_read should be registered');
    });

    test('registers notif_clear tool', () => {
      const tools = server.getTools();
      assert.ok(tools['notif_clear'], 'notif_clear should be registered');
    });
  });

  describe('notif_subscribe', () => {
    test('subscribes to events successfully', async () => {
      let capturedBody = null;
      global.fetch = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      };

      const result = await server.callTool('notif_subscribe', {
        handle: 'testbot',
        events: ['task.created', 'room.message']
      });
      const text = getText(result);

      assert.ok(text.includes('Subscribed **@testbot**'), 'Should confirm subscription');
      assert.ok(text.includes('2 event type(s)'), 'Should show event count');
      assert.equal(capturedBody.handle, 'testbot', 'Should send handle');
      assert.deepEqual(capturedBody.events, ['task.created', 'room.message'], 'Should send events');
    });

    test('handles wildcard subscription', async () => {
      global.fetch = async () => ({ ok: true, json: async () => ({}) });

      const result = await server.callTool('notif_subscribe', {
        handle: 'testbot',
        events: ['*']
      });
      const text = getText(result);

      assert.ok(text.includes('1 event type(s): *'), 'Should show wildcard');
    });

    test('handles subscription errors', async () => {
      global.fetch = async () => ({
        ok: false,
        json: async () => ({ error: 'Invalid event type' })
      });

      const result = await server.callTool('notif_subscribe', {
        handle: 'testbot',
        events: ['bad.event']
      });
      const text = getText(result);

      assert.ok(text.includes('Error'), 'Should indicate error');
      assert.ok(text.includes('Invalid event type'), 'Should show error message');
    });

    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Connection refused'); };

      const result = await server.callTool('notif_subscribe', {
        handle: 'test',
        events: ['*']
      });
      const text = getText(result);

      assert.ok(text.includes('Subscribe error'), 'Should indicate subscribe error');
      assert.ok(text.includes('Connection refused'), 'Should show error message');
    });
  });

  describe('notif_unsubscribe', () => {
    test('unsubscribes successfully', async () => {
      let capturedUrl = '';
      global.fetch = async (url, opts) => {
        capturedUrl = url;
        assert.equal(opts.method, 'DELETE', 'Should use DELETE method');
        return { ok: true, json: async () => ({}) };
      };

      const result = await server.callTool('notif_unsubscribe', { handle: 'testbot' });
      const text = getText(result);

      assert.ok(text.includes('Unsubscribed **@testbot**'), 'Should confirm unsubscription');
      assert.ok(capturedUrl.includes('testbot'), 'Should include handle in URL');
    });

    test('handles unsubscribe errors', async () => {
      global.fetch = async () => ({
        ok: false,
        json: async () => ({ error: 'Not found' })
      });

      const result = await server.callTool('notif_unsubscribe', { handle: 'unknown' });
      const text = getText(result);

      assert.ok(text.includes('Error'), 'Should indicate error');
    });

    test('URL-encodes handle', async () => {
      let capturedUrl = '';
      global.fetch = async (url) => {
        capturedUrl = url;
        return { ok: true, json: async () => ({}) };
      };

      await server.callTool('notif_unsubscribe', { handle: 'test@bot' });

      assert.ok(capturedUrl.includes('test%40bot'), 'Should URL-encode special characters');
    });

    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Timeout'); };

      const result = await server.callTool('notif_unsubscribe', { handle: 'test' });
      const text = getText(result);

      assert.ok(text.includes('Unsubscribe error'), 'Should indicate unsubscribe error');
    });
  });

  describe('notif_check', () => {
    test('shows notifications list', async () => {
      global.fetch = async () => ({
        json: async () => ({
          unread: 2,
          total: 5,
          notifications: [
            { event: 'task.created', summary: 'New task: Review PR', ts: '2026-02-04T12:00:00Z', read: false },
            { event: 'room.message', summary: 'Message in #general', ts: '2026-02-04T11:30:00Z', read: true }
          ]
        })
      });

      const result = await server.callTool('notif_check', { handle: 'testbot' });
      const text = getText(result);

      assert.ok(text.includes('**@testbot**'), 'Should show handle');
      assert.ok(text.includes('2 unread / 5 total'), 'Should show counts');
      assert.ok(text.includes('[task.created]'), 'Should show event type');
      assert.ok(text.includes('New task: Review PR'), 'Should show summary');
      assert.ok(text.includes('•'), 'Should show unread marker');
      assert.ok(text.includes('✓'), 'Should show read marker');
    });

    test('shows empty notification message', async () => {
      global.fetch = async () => ({
        json: async () => ({ notifications: [], unread: 0, total: 0 })
      });

      const result = await server.callTool('notif_check', { handle: 'quiet', unread: true });
      const text = getText(result);

      assert.ok(text.includes('no unread notifications'), 'Should show empty message for unread');
    });

    test('passes unread parameter', async () => {
      let capturedUrl = '';
      global.fetch = async (url) => {
        capturedUrl = url;
        return { json: async () => ({ notifications: [] }) };
      };

      await server.callTool('notif_check', { handle: 'test', unread: true });
      assert.ok(capturedUrl.includes('unread=true'), 'Should include unread=true');

      await server.callTool('notif_check', { handle: 'test', unread: false });
      assert.ok(!capturedUrl.includes('unread'), 'Should not include unread when false');
    });

    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Network error'); };

      const result = await server.callTool('notif_check', { handle: 'test' });
      const text = getText(result);

      assert.ok(text.includes('Check error'), 'Should indicate check error');
    });
  });

  describe('notif_read', () => {
    test('marks all as read when no IDs specified', async () => {
      let capturedBody = null;
      global.fetch = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ marked: 5 }) };
      };

      const result = await server.callTool('notif_read', { handle: 'testbot' });
      const text = getText(result);

      assert.ok(text.includes('Marked 5 notification(s) as read'), 'Should show marked count');
      assert.deepEqual(capturedBody, {}, 'Should send empty body for all');
    });

    test('marks specific IDs as read', async () => {
      let capturedBody = null;
      global.fetch = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ marked: 2 }) };
      };

      const result = await server.callTool('notif_read', {
        handle: 'testbot',
        ids: ['notif-1', 'notif-2']
      });
      const text = getText(result);

      assert.ok(text.includes('Marked 2 notification(s) as read'), 'Should show marked count');
      assert.deepEqual(capturedBody.ids, ['notif-1', 'notif-2'], 'Should send IDs');
    });

    test('handles read errors', async () => {
      global.fetch = async () => ({
        ok: false,
        json: async () => ({ error: 'Invalid notification ID' })
      });

      const result = await server.callTool('notif_read', { handle: 'test', ids: ['bad-id'] });
      const text = getText(result);

      assert.ok(text.includes('Error'), 'Should indicate error');
    });

    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Server error'); };

      const result = await server.callTool('notif_read', { handle: 'test' });
      const text = getText(result);

      assert.ok(text.includes('Read error'), 'Should indicate read error');
    });
  });

  describe('notif_clear', () => {
    test('clears all notifications', async () => {
      let capturedMethod = '';
      global.fetch = async (url, opts) => {
        capturedMethod = opts.method;
        return { ok: true, json: async () => ({}) };
      };

      const result = await server.callTool('notif_clear', { handle: 'testbot' });
      const text = getText(result);

      assert.ok(text.includes('Cleared all notifications for **@testbot**'), 'Should confirm clear');
      assert.equal(capturedMethod, 'DELETE', 'Should use DELETE method');
    });

    test('handles clear errors', async () => {
      global.fetch = async () => ({
        ok: false,
        json: async () => ({ error: 'Handle not found' })
      });

      const result = await server.callTool('notif_clear', { handle: 'unknown' });
      const text = getText(result);

      assert.ok(text.includes('Error'), 'Should indicate error');
    });

    test('URL-encodes handle', async () => {
      let capturedUrl = '';
      global.fetch = async (url) => {
        capturedUrl = url;
        return { ok: true, json: async () => ({}) };
      };

      await server.callTool('notif_clear', { handle: 'special/bot' });

      assert.ok(capturedUrl.includes('special%2Fbot'), 'Should URL-encode special characters');
    });

    test('handles fetch errors gracefully', async () => {
      global.fetch = async () => { throw new Error('Connection lost'); };

      const result = await server.callTool('notif_clear', { handle: 'test' });
      const text = getText(result);

      assert.ok(text.includes('Clear error'), 'Should indicate clear error');
    });
  });
});

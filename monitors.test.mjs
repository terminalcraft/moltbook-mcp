// monitors.test.mjs — Tests for components/monitors.js
// B#208: Tests for URL monitor CRUD operations

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock server to capture tool registrations
const registeredTools = new Map();
const mockServer = {
  tool: (name, description, schema, handler) => {
    registeredTools.set(name, { description, schema, handler });
  }
};

// Mock fetch for API calls
let fetchMock;
let fetchCalls = [];

describe('components/monitors.js', async () => {
  beforeEach(async () => {
    registeredTools.clear();
    fetchCalls = [];

    // Setup fetch mock
    fetchMock = mock.fn(async (url, options = {}) => {
      fetchCalls.push({ url, options });

      // Default responses based on endpoint
      if (url.includes('/monitors') && options.method === 'POST' && !url.includes('/probe')) {
        return {
          ok: true,
          json: async () => ({
            id: 'mon-123',
            name: 'Test Monitor',
            url: 'https://example.com/health'
          })
        };
      }
      if (url.match(/\/monitors\?/) && !options.method) {
        return {
          ok: true,
          json: async () => ({
            total: 2,
            max: 10,
            monitors: [
              { id: 'mon-1', name: 'API', url: 'https://api.example.com', status: 'up', agent: 'test1', uptime_1h: 100, uptime_24h: 99.5 },
              { id: 'mon-2', name: 'Web', url: 'https://web.example.com', status: 'down', agent: 'test2', uptime_1h: 50, uptime_24h: null }
            ]
          })
        };
      }
      if (url.match(/\/monitors\/[^/]+$/) && !options.method) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'mon-123',
            name: 'Test Monitor',
            url: 'https://example.com/health',
            agent: 'moltbook',
            status: 'up',
            status_code: 200,
            uptime_1h: 100,
            uptime_24h: 99.8,
            last_checked: '2026-01-15T10:00:00Z',
            history: [
              { ts: '2026-01-15T09:55:00Z', status: 'up' },
              { ts: '2026-01-15T09:50:00Z', status: 'up' }
            ]
          })
        };
      }
      if (url.match(/\/monitors\/[^/]+$/) && options.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ removed: 'mon-123' }) };
      }
      if (url.match(/\/monitors\/[^/]+\/probe$/)) {
        return {
          ok: true,
          json: async () => ({
            name: 'Test Monitor',
            status: 'up',
            status_code: 200,
            changed: false
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    });

    global.fetch = fetchMock;

    // Import and register module
    const monitorsModule = await import(`./components/monitors.js?t=${Date.now()}`);
    monitorsModule.register(mockServer);
  });

  afterEach(() => {
    mock.reset();
  });

  test('registers all 5 monitor tools', () => {
    const expectedTools = ['monitor_create', 'monitor_list', 'monitor_get', 'monitor_delete', 'monitor_probe'];
    for (const tool of expectedTools) {
      assert.ok(registeredTools.has(tool), `Missing tool: ${tool}`);
    }
    assert.equal(registeredTools.size, 5);
  });

  test('monitor_create sends correct request and formats response', async () => {
    const handler = registeredTools.get('monitor_create').handler;
    const result = await handler({
      agent: 'moltbook',
      url: 'https://example.com/health',
      name: 'Test Monitor'
    });

    // Check fetch was called correctly
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options.method, 'POST');
    const body = JSON.parse(fetchCalls[0].options.body);
    assert.equal(body.agent, 'moltbook');
    assert.equal(body.url, 'https://example.com/health');
    assert.equal(body.name, 'Test Monitor');

    // Check response format
    const text = result.content[0].text;
    assert.ok(text.includes('mon-123'));
    assert.ok(text.includes('Test Monitor'));
  });

  test('monitor_create handles duplicate URL error', async () => {
    global.fetch = mock.fn(async () => ({
      ok: false,
      json: async () => ({
        error: 'URL already monitored',
        id: 'existing-123'
      })
    }));

    registeredTools.clear();
    const monitorsModule = await import(`./components/monitors.js?t=${Date.now() + 1}`);
    monitorsModule.register(mockServer);

    const handler = registeredTools.get('monitor_create').handler;
    const result = await handler({
      agent: 'moltbook',
      url: 'https://example.com/health'
    });

    const text = result.content[0].text;
    assert.ok(text.includes('failed'));
    assert.ok(text.includes('existing-123'));
  });

  test('monitor_list formats multiple monitors with uptime', async () => {
    const handler = registeredTools.get('monitor_list').handler;
    const result = await handler({});

    const text = result.content[0].text;
    assert.ok(text.includes('2/10 monitors'));
    assert.ok(text.includes('mon-1'));
    assert.ok(text.includes('API'));
    assert.ok(text.includes('100%'));
    assert.ok(text.includes('99.5%'));
    assert.ok(text.includes('down'));  // mon-2 status
  });

  test('monitor_list handles null uptime gracefully', async () => {
    const handler = registeredTools.get('monitor_list').handler;
    const result = await handler({});

    const text = result.content[0].text;
    // mon-2 has null uptime_24h
    assert.ok(text.includes('--'));
  });

  test('monitor_list handles empty list', async () => {
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ total: 0, max: 10, monitors: [] })
    }));

    registeredTools.clear();
    const monitorsModule = await import(`./components/monitors.js?t=${Date.now() + 2}`);
    monitorsModule.register(mockServer);

    const handler = registeredTools.get('monitor_list').handler;
    const result = await handler({});

    assert.ok(result.content[0].text.includes('No monitors'));
  });

  test('monitor_get returns details with history', async () => {
    const handler = registeredTools.get('monitor_get').handler;
    const result = await handler({ id: 'mon-123' });

    const text = result.content[0].text;
    assert.ok(text.includes('Test Monitor'));
    assert.ok(text.includes('https://example.com/health'));
    assert.ok(text.includes('moltbook'));
    assert.ok(text.includes('200'));
    assert.ok(text.includes('100%'));
    assert.ok(text.includes('Recent history'));
  });

  test('monitor_get handles 404', async () => {
    global.fetch = mock.fn(async () => ({ status: 404 }));

    registeredTools.clear();
    const monitorsModule = await import(`./components/monitors.js?t=${Date.now() + 3}`);
    monitorsModule.register(mockServer);

    const handler = registeredTools.get('monitor_get').handler;
    const result = await handler({ id: 'nonexistent' });

    assert.ok(result.content[0].text.includes('not found'));
  });

  test('monitor_delete sends DELETE request', async () => {
    const handler = registeredTools.get('monitor_delete').handler;
    const result = await handler({ id: 'mon-123' });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options.method, 'DELETE');
    assert.ok(fetchCalls[0].url.includes('mon-123'));
    assert.ok(result.content[0].text.includes('Deleted'));
  });

  test('monitor_probe triggers manual check', async () => {
    const handler = registeredTools.get('monitor_probe').handler;
    const result = await handler({ id: 'mon-123' });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options.method, 'POST');
    assert.ok(fetchCalls[0].url.includes('/probe'));

    const text = result.content[0].text;
    assert.ok(text.includes('Probed'));
    assert.ok(text.includes('up'));
    assert.ok(text.includes('200'));
  });

  test('monitor_probe shows status change', async () => {
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        name: 'Test Monitor',
        status: 'down',
        status_code: null,
        changed: true,
        previous: 'up'
      })
    }));

    registeredTools.clear();
    const monitorsModule = await import(`./components/monitors.js?t=${Date.now() + 4}`);
    monitorsModule.register(mockServer);

    const handler = registeredTools.get('monitor_probe').handler;
    const result = await handler({ id: 'mon-123' });

    const text = result.content[0].text;
    assert.ok(text.includes('changed from up'));
  });
});

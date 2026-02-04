// webhooks.test.mjs — Tests for components/webhooks.js
// B#208: Tests for webhook CRUD operations

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

describe('components/webhooks.js', async () => {
  beforeEach(async () => {
    registeredTools.clear();
    fetchCalls = [];

    // Setup fetch mock
    fetchMock = mock.fn(async (url, options = {}) => {
      fetchCalls.push({ url, options });

      // Default responses based on endpoint
      if (url.includes('/webhooks') && options.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            id: 'wh-123',
            secret: 'secret-abc',
            events: ['pattern.added', 'agent.registered'],
            updated: false
          })
        };
      }
      if (url.match(/\/webhooks$/) && !options.method) {
        return {
          ok: true,
          json: async () => ([
            { id: 'wh-1', url: 'https://a.com/hook', events: ['*'], agent: 'test1' },
            { id: 'wh-2', url: 'https://b.com/hook', events: ['pattern.added'], agent: 'test2' }
          ])
        };
      }
      if (url.match(/\/webhooks\/[^/]+$/) && options.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.match(/\/webhooks\/events$/)) {
        return {
          ok: true,
          json: async () => ({
            events: ['pattern.added', 'pattern.removed', 'agent.registered', 'knowledge.exchanged']
          })
        };
      }
      if (url.match(/\/webhooks\/[^/]+\/stats$/)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'wh-123',
            agent: 'moltbook',
            url: 'https://example.com/hook',
            events: ['pattern.added'],
            stats: {
              delivered: 15,
              failed: 2,
              last_delivery: '2026-01-15T10:00:00Z',
              last_failure: '2026-01-10T08:00:00Z'
            }
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    });

    global.fetch = fetchMock;

    // Import and register module
    const webhooksModule = await import(`./components/webhooks.js?t=${Date.now()}`);
    webhooksModule.register(mockServer);
  });

  afterEach(() => {
    mock.reset();
  });

  test('registers all 5 webhook tools', () => {
    const expectedTools = ['webhooks_subscribe', 'webhooks_list', 'webhooks_delete', 'webhooks_events', 'webhooks_stats'];
    for (const tool of expectedTools) {
      assert.ok(registeredTools.has(tool), `Missing tool: ${tool}`);
    }
    assert.equal(registeredTools.size, 5);
  });

  test('webhooks_subscribe creates webhook and shows secret', async () => {
    const handler = registeredTools.get('webhooks_subscribe').handler;
    const result = await handler({
      agent: 'moltbook',
      url: 'https://example.com/hook',
      events: ['pattern.added', 'agent.registered']
    });

    // Check fetch was called correctly
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options.method, 'POST');
    const body = JSON.parse(fetchCalls[0].options.body);
    assert.equal(body.agent, 'moltbook');
    assert.equal(body.url, 'https://example.com/hook');
    assert.deepEqual(body.events, ['pattern.added', 'agent.registered']);

    // Check response format
    const text = result.content[0].text;
    assert.ok(text.includes('wh-123'));
    assert.ok(text.includes('secret-abc'));
    assert.ok(text.includes('pattern.added'));
  });

  test('webhooks_subscribe shows updated message for existing webhook', async () => {
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        id: 'wh-123',
        events: ['*'],
        updated: true
      })
    }));

    registeredTools.clear();
    const webhooksModule = await import(`./components/webhooks.js?t=${Date.now() + 1}`);
    webhooksModule.register(mockServer);

    const handler = registeredTools.get('webhooks_subscribe').handler;
    const result = await handler({
      agent: 'moltbook',
      url: 'https://example.com/hook',
      events: ['*']
    });

    const text = result.content[0].text;
    assert.ok(text.includes('Updated'));
    assert.ok(!text.includes('Secret'));  // Secret not shown on update
  });

  test('webhooks_list formats multiple webhooks', async () => {
    const handler = registeredTools.get('webhooks_list').handler;
    const result = await handler({});

    const text = result.content[0].text;
    assert.ok(text.includes('2 webhook(s)'));
    assert.ok(text.includes('wh-1'));
    assert.ok(text.includes('wh-2'));
    assert.ok(text.includes('https://a.com/hook'));
    assert.ok(text.includes('test1'));
  });

  test('webhooks_list handles empty list', async () => {
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ([])
    }));

    registeredTools.clear();
    const webhooksModule = await import(`./components/webhooks.js?t=${Date.now() + 2}`);
    webhooksModule.register(mockServer);

    const handler = registeredTools.get('webhooks_list').handler;
    const result = await handler({});

    assert.ok(result.content[0].text.includes('No webhooks'));
  });

  test('webhooks_delete sends DELETE request', async () => {
    const handler = registeredTools.get('webhooks_delete').handler;
    const result = await handler({ id: 'wh-123' });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options.method, 'DELETE');
    assert.ok(fetchCalls[0].url.includes('wh-123'));
    assert.ok(result.content[0].text.includes('deleted'));
  });

  test('webhooks_events lists available events', async () => {
    const handler = registeredTools.get('webhooks_events').handler;
    const result = await handler({});

    const text = result.content[0].text;
    assert.ok(text.includes('Available webhook events'));
    assert.ok(text.includes('pattern.added'));
    assert.ok(text.includes('agent.registered'));
    assert.ok(text.includes('*'));  // Wildcard hint
  });

  test('webhooks_stats returns delivery stats', async () => {
    const handler = registeredTools.get('webhooks_stats').handler;
    const result = await handler({ id: 'wh-123' });

    const text = result.content[0].text;
    assert.ok(text.includes('wh-123'));
    assert.ok(text.includes('moltbook'));
    assert.ok(text.includes('Delivered: 15'));
    assert.ok(text.includes('Failed: 2'));
  });

  test('webhooks_stats handles 404', async () => {
    global.fetch = mock.fn(async () => ({ status: 404 }));

    registeredTools.clear();
    const webhooksModule = await import(`./components/webhooks.js?t=${Date.now() + 3}`);
    webhooksModule.register(mockServer);

    const handler = registeredTools.get('webhooks_stats').handler;
    const result = await handler({ id: 'nonexistent' });

    assert.ok(result.content[0].text.includes('not found'));
  });

  test('webhooks_subscribe handles API error with valid events hint', async () => {
    global.fetch = mock.fn(async () => ({
      ok: false,
      json: async () => ({
        error: 'Invalid event',
        valid: ['pattern.added', 'pattern.removed']
      })
    }));

    registeredTools.clear();
    const webhooksModule = await import(`./components/webhooks.js?t=${Date.now() + 4}`);
    webhooksModule.register(mockServer);

    const handler = registeredTools.get('webhooks_subscribe').handler;
    const result = await handler({
      agent: 'moltbook',
      url: 'https://example.com/hook',
      events: ['invalid.event']
    });

    const text = result.content[0].text;
    assert.ok(text.includes('failed'));
    assert.ok(text.includes('Invalid event'));
    assert.ok(text.includes('Valid events'));
  });
});

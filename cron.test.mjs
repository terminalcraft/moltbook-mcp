// cron.test.mjs — Tests for components/cron.js
// B#207: Tests for cron job CRUD operations

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

describe('components/cron.js', async () => {
  beforeEach(async () => {
    registeredTools.clear();
    fetchCalls = [];

    // Setup fetch mock
    fetchMock = mock.fn(async (url, options = {}) => {
      fetchCalls.push({ url, options });

      // Default responses based on endpoint
      if (url.includes('/cron') && options.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            id: 'job-123',
            name: 'test-job',
            url: 'https://example.com/callback',
            method: 'POST',
            interval: 300
          })
        };
      }
      if (url.match(/\/cron$/) && !options.method) {
        return {
          ok: true,
          json: async () => ({
            total: 2,
            jobs: [
              { id: 'job-1', name: 'Job 1', url: 'https://a.com', method: 'POST', interval: 60, active: true, run_count: 5, error_count: 0 },
              { id: 'job-2', name: 'Job 2', url: 'https://b.com', method: 'GET', interval: 120, active: false, run_count: 3, error_count: 1 }
            ]
          })
        };
      }
      if (url.match(/\/cron\/[^/]+$/) && !options.method) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'job-123',
            name: 'test-job',
            url: 'https://example.com',
            method: 'POST',
            interval: 300,
            active: true,
            run_count: 10,
            error_count: 2,
            created_at: '2026-01-01T00:00:00Z',
            history: [
              { ts: '2026-01-01T12:00:00Z', status: 200, duration_ms: 150 }
            ]
          })
        };
      }
      if (url.match(/\/cron\/[^/]+$/) && options.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.match(/\/cron\/[^/]+$/) && options.method === 'PATCH') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'job-123', active: false, interval: 600 })
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    });

    global.fetch = fetchMock;

    // Import and register module
    const cronModule = await import(`./components/cron.js?t=${Date.now()}`);
    cronModule.register(mockServer);
  });

  afterEach(() => {
    mock.reset();
  });

  test('registers all 5 cron tools', () => {
    const expectedTools = ['cron_create', 'cron_list', 'cron_get', 'cron_delete', 'cron_update'];
    for (const tool of expectedTools) {
      assert.ok(registeredTools.has(tool), `Missing tool: ${tool}`);
    }
    assert.equal(registeredTools.size, 5);
  });

  test('cron_create sends correct request and formats response', async () => {
    const handler = registeredTools.get('cron_create').handler;
    const result = await handler({
      url: 'https://example.com/callback',
      interval: 300,
      agent: 'moltbook',
      name: 'test-job'
    });

    // Check fetch was called correctly
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options.method, 'POST');
    const body = JSON.parse(fetchCalls[0].options.body);
    assert.equal(body.url, 'https://example.com/callback');
    assert.equal(body.interval, 300);
    assert.equal(body.agent, 'moltbook');

    // Check response format
    assert.ok(result.content[0].text.includes('job-123'));
    assert.ok(result.content[0].text.includes('every 300s'));
  });

  test('cron_list formats multiple jobs', async () => {
    const handler = registeredTools.get('cron_list').handler;
    const result = await handler({});

    const text = result.content[0].text;
    assert.ok(text.includes('2 cron job(s)'));
    assert.ok(text.includes('job-1'));
    assert.ok(text.includes('job-2'));
    assert.ok(text.includes('active'));
    assert.ok(text.includes('paused'));
  });

  test('cron_get returns job details with history', async () => {
    const handler = registeredTools.get('cron_get').handler;
    const result = await handler({ id: 'job-123' });

    const text = result.content[0].text;
    assert.ok(text.includes('Job job-123'));
    assert.ok(text.includes('Runs: 10'));
    assert.ok(text.includes('Errors: 2'));
    assert.ok(text.includes('Recent runs'));
  });

  test('cron_delete sends DELETE request', async () => {
    const handler = registeredTools.get('cron_delete').handler;
    const result = await handler({ id: 'job-123' });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options.method, 'DELETE');
    assert.ok(result.content[0].text.includes('Deleted'));
  });

  test('cron_update sends PATCH with optional fields', async () => {
    const handler = registeredTools.get('cron_update').handler;
    const result = await handler({ id: 'job-123', active: false, interval: 600 });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options.method, 'PATCH');
    const body = JSON.parse(fetchCalls[0].options.body);
    assert.equal(body.active, false);
    assert.equal(body.interval, 600);

    assert.ok(result.content[0].text.includes('Updated'));
    assert.ok(result.content[0].text.includes('active=false'));
  });

  test('cron_create handles API error', async () => {
    // Override fetch to return error
    global.fetch = mock.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'Invalid interval' })
    }));

    // Re-register with new fetch
    registeredTools.clear();
    const cronModule = await import(`./components/cron.js?t=${Date.now() + 1}`);
    cronModule.register(mockServer);

    const handler = registeredTools.get('cron_create').handler;
    const result = await handler({ url: 'https://example.com', interval: 10 });

    assert.ok(result.content[0].text.includes('failed'));
    assert.ok(result.content[0].text.includes('Invalid interval'));
  });

  test('cron_get handles 404', async () => {
    global.fetch = mock.fn(async () => ({ status: 404 }));

    registeredTools.clear();
    const cronModule = await import(`./components/cron.js?t=${Date.now() + 2}`);
    cronModule.register(mockServer);

    const handler = registeredTools.get('cron_get').handler;
    const result = await handler({ id: 'nonexistent' });

    assert.ok(result.content[0].text.includes('not found'));
  });

  test('cron_list handles empty jobs', async () => {
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ total: 0, jobs: [] })
    }));

    registeredTools.clear();
    const cronModule = await import(`./components/cron.js?t=${Date.now() + 3}`);
    cronModule.register(mockServer);

    const handler = registeredTools.get('cron_list').handler;
    const result = await handler({});

    assert.ok(result.content[0].text.includes('No cron jobs'));
  });
});

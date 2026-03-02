/**
 * Tests for lib/safe-fetch.mjs (wq-785)
 * Covers: SSRF protection (private IP blocking), timeout handling, error modes.
 * Uses real fetch for integration but tests SSRF logic via private IPs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeFetch, fetchStatus, fetchBody } from './safe-fetch.mjs';

describe('safeFetch SSRF protection', () => {
  it('blocks 127.0.0.1', async () => {
    const result = await safeFetch('http://127.0.0.1:8080/secret');
    assert.equal(result.status, 0);
    assert.equal(result.error, 'blocked_private_ip');
    assert.equal(result.body, null);
  });

  it('blocks 10.x.x.x', async () => {
    const result = await safeFetch('http://10.0.0.1/internal');
    assert.equal(result.error, 'blocked_private_ip');
  });

  it('blocks 192.168.x.x', async () => {
    const result = await safeFetch('http://192.168.1.1/admin');
    assert.equal(result.error, 'blocked_private_ip');
  });

  it('blocks 172.16-31.x.x', async () => {
    const result = await safeFetch('http://172.16.0.1/internal');
    assert.equal(result.error, 'blocked_private_ip');
    const result2 = await safeFetch('http://172.31.255.255/internal');
    assert.equal(result2.error, 'blocked_private_ip');
  });

  it('blocks localhost', async () => {
    const result = await safeFetch('http://localhost:3000/api');
    assert.equal(result.error, 'blocked_private_ip');
  });

  it('blocks [::1]', async () => {
    const result = await safeFetch('http://[::1]:8080/secret');
    assert.equal(result.error, 'blocked_private_ip');
  });

  it('allows private IPs when allowInternal is true', async () => {
    // This will fail to connect (no server), but should NOT be blocked by SSRF
    const result = await safeFetch('http://127.0.0.1:19999/test', {
      allowInternal: true,
      timeout: 500,
    });
    assert.notEqual(result.error, 'blocked_private_ip');
    // Should be connection_error or timeout, not blocked
    assert.ok(['timeout', 'connection_error'].includes(result.error));
  });
});

describe('safeFetch error handling', () => {
  it('returns timeout error for unreachable hosts with short timeout', async () => {
    const result = await safeFetch('http://192.0.2.1:12345/timeout-test', {
      timeout: 500,
      allowInternal: false,
    });
    assert.equal(result.status, 0);
    assert.ok(['timeout', 'connection_error'].includes(result.error));
    assert.ok(result.elapsed >= 0);
  });

  it('returns error for invalid URLs', async () => {
    const result = await safeFetch('not-a-url');
    assert.equal(result.status, 0);
    assert.equal(result.body, null);
  });
});

describe('safeFetch bodyMode', () => {
  it('skips body with bodyMode=none against a real endpoint', async () => {
    const result = await safeFetch('https://www.moltchan.org/api/v1/boards', {
      bodyMode: 'none',
      timeout: 5000,
    });
    // Should have status but null body
    if (result.status > 0) {
      assert.equal(result.body, null);
      assert.ok(result.elapsed > 0);
    }
  });
});

describe('fetchStatus', () => {
  it('returns numeric status code', async () => {
    const status = await fetchStatus('https://www.moltchan.org/api/v1/boards', { timeout: 5000 });
    // Either a valid HTTP status or 0 for network error
    assert.equal(typeof status, 'number');
  });
});

describe('fetchBody', () => {
  it('returns body as text', async () => {
    const body = await fetchBody('https://www.moltchan.org/api/v1/boards', { timeout: 5000 });
    if (body !== null) {
      assert.equal(typeof body, 'string');
    }
  });
});

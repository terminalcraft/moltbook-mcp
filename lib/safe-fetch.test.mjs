/**
 * Tests for lib/safe-fetch.mjs (wq-785, wq-801)
 * Covers: SSRF protection (all private IP ranges), timeout handling,
 * dns_failed/connection_error types (wq-790), POST with body,
 * maxBody truncation, fetchStatus/fetchBody helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

  it('blocks 0.x.x.x', async () => {
    const result = await safeFetch('http://0.0.0.0/internal');
    assert.equal(result.error, 'blocked_private_ip');
  });

  it('blocks 169.254.x.x (link-local)', async () => {
    const result = await safeFetch('http://169.254.1.1/metadata');
    assert.equal(result.error, 'blocked_private_ip');
  });

  it('blocks [fc..] IPv6 ULA', async () => {
    const result = await safeFetch('http://[fc00::1]/internal');
    assert.equal(result.error, 'blocked_private_ip');
  });

  it('blocks [fd..] IPv6 ULA', async () => {
    const result = await safeFetch('http://[fd12:3456::1]/internal');
    assert.equal(result.error, 'blocked_private_ip');
  });

  it('allows public IPs (does not block)', async () => {
    // 8.8.8.8 is public — should not be SSRF-blocked (will get connection error on port 1)
    const result = await safeFetch('http://8.8.8.8:1/test', { timeout: 500 });
    assert.notEqual(result.error, 'blocked_private_ip');
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

describe('safeFetch dns_failed error (wq-790)', () => {
  it('returns dns_failed for nonexistent domain', async () => {
    const result = await safeFetch('http://this-domain-does-not-exist-xyzzy-9999.example/', {
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.error, 'dns_failed');
    assert.equal(result.body, null);
    assert.ok(result.elapsed >= 0);
  });

  it('returns dns_failed for .invalid TLD', async () => {
    const result = await safeFetch('http://nxdomain.invalid/test', { timeout: 5000 });
    assert.equal(result.error, 'dns_failed');
  });
});

describe('safeFetch connection_error', () => {
  it('returns connection_error for refused connection', async () => {
    // Port 1 is almost never open — should get ECONNREFUSED
    const result = await safeFetch('http://127.0.0.1:1/test', {
      allowInternal: true,
      timeout: 2000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.error, 'connection_error');
    assert.equal(result.body, null);
  });
});

// Local test server for deterministic tests
function createTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('safeFetch with local server', () => {
  it('successful GET returns status and body', async () => {
    const { server, url } = await createTestServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello world');
    });
    try {
      const result = await safeFetch(`${url}/test`, { allowInternal: true, timeout: 2000 });
      assert.equal(result.status, 200);
      assert.equal(result.body, 'hello world');
      assert.equal(result.error, null);
      assert.ok(result.elapsed >= 0);
    } finally {
      server.close();
    }
  });

  it('POST sends JSON body', async () => {
    let receivedBody = '';
    let receivedContentType = '';
    const { server, url } = await createTestServer((req, res) => {
      receivedContentType = req.headers['content-type'] || '';
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString();
        res.writeHead(201);
        res.end('created');
      });
    });
    try {
      const result = await safeFetch(`${url}/api`, {
        allowInternal: true,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: 'value' },
        timeout: 2000,
      });
      assert.equal(result.status, 201);
      assert.equal(result.body, 'created');
      assert.equal(receivedBody, '{"key":"value"}');
    } finally {
      server.close();
    }
  });

  it('POST sends string body as-is', async () => {
    let receivedBody = '';
    const { server, url } = await createTestServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString();
        res.writeHead(200);
        res.end('ok');
      });
    });
    try {
      await safeFetch(`${url}/api`, {
        allowInternal: true,
        method: 'POST',
        body: 'raw string data',
        timeout: 2000,
      });
      assert.equal(receivedBody, 'raw string data');
    } finally {
      server.close();
    }
  });

  it('bodyMode=none skips body read', async () => {
    const { server, url } = await createTestServer((req, res) => {
      res.writeHead(200);
      res.end('this body should be skipped');
    });
    try {
      const result = await safeFetch(`${url}/test`, {
        allowInternal: true,
        bodyMode: 'none',
        timeout: 2000,
      });
      assert.equal(result.status, 200);
      assert.equal(result.body, null);
      assert.equal(result.error, null);
    } finally {
      server.close();
    }
  });

  it('maxBody truncates large responses', async () => {
    const largeBody = 'x'.repeat(5000);
    const { server, url } = await createTestServer((req, res) => {
      res.writeHead(200);
      res.end(largeBody);
    });
    try {
      const result = await safeFetch(`${url}/large`, {
        allowInternal: true,
        maxBody: 100,
        timeout: 2000,
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.length, 100);
      assert.equal(result.error, null);
    } finally {
      server.close();
    }
  });

  it('custom User-Agent header is sent', async () => {
    let receivedUA = '';
    const { server, url } = await createTestServer((req, res) => {
      receivedUA = req.headers['user-agent'] || '';
      res.writeHead(200);
      res.end('ok');
    });
    try {
      await safeFetch(`${url}/ua`, {
        allowInternal: true,
        userAgent: 'test-agent/2.0',
        timeout: 2000,
      });
      assert.equal(receivedUA, 'test-agent/2.0');
    } finally {
      server.close();
    }
  });

  it('returns non-200 status codes correctly', async () => {
    const { server, url } = await createTestServer((req, res) => {
      res.writeHead(404);
      res.end('not found');
    });
    try {
      const result = await safeFetch(`${url}/missing`, { allowInternal: true, timeout: 2000 });
      assert.equal(result.status, 404);
      assert.equal(result.body, 'not found');
      assert.equal(result.error, null);
    } finally {
      server.close();
    }
  });
});

describe('fetchStatus helper', () => {
  it('returns numeric status from local server', async () => {
    const { server, url } = await createTestServer((req, res) => {
      res.writeHead(204);
      res.end();
    });
    try {
      const status = await fetchStatus(`${url}/status`, { allowInternal: true, timeout: 2000 });
      assert.equal(status, 204);
    } finally {
      server.close();
    }
  });

  it('returns 0 for SSRF-blocked URLs', async () => {
    const status = await fetchStatus('http://10.0.0.1/admin');
    assert.equal(status, 0);
  });

  it('returns 0 for DNS failures', async () => {
    const status = await fetchStatus('http://nxdomain.invalid/test', { timeout: 5000 });
    assert.equal(status, 0);
  });
});

describe('fetchBody helper', () => {
  it('returns body text from local server', async () => {
    const { server, url } = await createTestServer((req, res) => {
      res.writeHead(200);
      res.end('response body');
    });
    try {
      const body = await fetchBody(`${url}/body`, { allowInternal: true, timeout: 2000 });
      assert.equal(body, 'response body');
    } finally {
      server.close();
    }
  });

  it('returns null for SSRF-blocked URLs', async () => {
    const body = await fetchBody('http://192.168.0.1/secret');
    assert.equal(body, null);
  });

  it('returns null for connection errors', async () => {
    const body = await fetchBody('http://127.0.0.1:1/test', {
      allowInternal: true,
      timeout: 2000,
    });
    assert.equal(body, null);
  });
});

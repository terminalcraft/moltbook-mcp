import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Import the module
import { checkAllCredentials, checkAllCredentialsLive } from './credential-health-check.mjs';

const TEST_DIR = join(tmpdir(), `cred-health-test-${process.pid}`);
const REGISTRY_PATH = join(TEST_DIR, 'account-registry.json');

function writeRegistry(accounts) {
  writeFileSync(REGISTRY_PATH, JSON.stringify({ accounts }, null, 2));
}

function writeCredFile(name, content) {
  const p = join(TEST_DIR, name);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return p;
}

describe('credential-health-check', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('returns empty results for missing registry', () => {
    const result = checkAllCredentials({ registryPath: '/nonexistent/path.json' });
    assert.ok(result.error);
    assert.equal(result.results.length, 0);
  });

  it('marks no-auth platforms as ok', () => {
    writeRegistry([
      { id: 'moltbook', status: 'live', auth_type: 'none', cred_file: null, cred_key: null }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.healthy, 1);
    assert.equal(result.results[0].status, 'ok');
    assert.match(result.results[0].details, /no credentials required/);
  });

  it('detects missing credential files', () => {
    writeRegistry([
      { id: 'test-platform', status: 'live', auth_type: 'api_key', cred_file: join(TEST_DIR, 'nonexistent.json'), cred_key: 'api_key' }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.unhealthy, 1);
    assert.equal(result.results[0].status, 'missing');
  });

  it('detects placeholder credentials', () => {
    const credPath = writeCredFile('placeholder.json', { api_key: 'test-api-key' });
    writeRegistry([
      { id: 'test-plat', status: 'live', auth_type: 'api_key', cred_file: credPath, cred_key: 'api_key' }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.results[0].status, 'placeholder');
  });

  it('detects empty required key field', () => {
    const credPath = writeCredFile('empty-key.json', { api_key: '' });
    writeRegistry([
      { id: 'test-plat', status: 'live', auth_type: 'api_key', cred_file: credPath, cred_key: 'api_key' }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.results[0].status, 'empty');
  });

  it('validates good JSON credentials', () => {
    const credPath = writeCredFile('good.json', { api_key: 'sk-real-key-abc123def' });
    writeRegistry([
      { id: 'good-plat', status: 'live', auth_type: 'api_key', cred_file: credPath, cred_key: 'api_key' }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.healthy, 1);
    assert.equal(result.results[0].status, 'ok');
  });

  it('detects expired JWT in bearer token file', () => {
    // Create a JWT with exp in the past
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'test', exp: Math.floor(Date.now() / 1000) - 3600 })).toString('base64url');
    const token = `${header}.${payload}.fakesig`;
    const credPath = join(TEST_DIR, '.test-bearer');
    writeFileSync(credPath, token);
    writeRegistry([
      { id: 'jwt-plat', status: 'live', auth_type: 'bearer', cred_file: credPath, cred_key: null }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.results[0].status, 'expired');
  });

  it('detects expiring JWT (<1h)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
    const token = `${header}.${payload}.fakesig`;
    const credPath = join(TEST_DIR, '.test-bearer2');
    writeFileSync(credPath, token);
    writeRegistry([
      { id: 'jwt-plat2', status: 'live', auth_type: 'bearer', cred_file: credPath, cred_key: null }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.results[0].status, 'expiring');
  });

  it('validates good JWT with >1h remaining', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'test', exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url');
    const token = `${header}.${payload}.fakesig`;
    const credPath = join(TEST_DIR, '.test-bearer3');
    writeFileSync(credPath, token);
    writeRegistry([
      { id: 'jwt-plat3', status: 'live', auth_type: 'bearer', cred_file: credPath, cred_key: null }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.results[0].status, 'ok');
    assert.match(result.results[0].details, /JWT valid/);
  });

  it('detects expired JWT in JSON token field', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'test', exp: Math.floor(Date.now() / 1000) - 100 })).toString('base64url');
    const token = `${header}.${payload}.fakesig`;
    const credPath = writeCredFile('jwt-cred.json', { api_key: 'abc123', access_token: token });
    writeRegistry([
      { id: 'json-jwt', status: 'live', auth_type: 'api_key', cred_file: credPath, cred_key: 'api_key' }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.results[0].status, 'expired');
  });

  it('filters by platform when specified', () => {
    writeRegistry([
      { id: 'alpha', status: 'live', auth_type: 'none', cred_file: null, cred_key: null },
      { id: 'beta', status: 'live', auth_type: 'none', cred_file: null, cred_key: null }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH, platformFilter: 'alpha' });
    assert.equal(result.total, 1);
    assert.equal(result.results[0].id, 'alpha');
  });

  it('skips non-live platforms', () => {
    writeRegistry([
      { id: 'live-one', status: 'live', auth_type: 'none', cred_file: null, cred_key: null },
      { id: 'dead-one', status: 'defunct', auth_type: 'none', cred_file: null, cred_key: null },
      { id: 'degraded-one', status: 'degraded', auth_type: 'none', cred_file: null, cred_key: null }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.total, 1);
    assert.equal(result.results[0].id, 'live-one');
  });

  it('handles malformed JSON credential files', () => {
    const credPath = writeCredFile('bad.json', 'not { valid json');
    writeRegistry([
      { id: 'bad-json', status: 'live', auth_type: 'api_key', cred_file: credPath, cred_key: 'api_key' }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.results[0].status, 'error');
    assert.match(result.results[0].details, /JSON parse error/);
  });

  it('returns summary counts correctly', () => {
    const goodPath = writeCredFile('good2.json', { api_key: 'real-key-123456' });
    writeRegistry([
      { id: 'ok-plat', status: 'live', auth_type: 'none', cred_file: null, cred_key: null },
      { id: 'ok-plat2', status: 'live', auth_type: 'api_key', cred_file: goodPath, cred_key: 'api_key' },
      { id: 'bad-plat', status: 'live', auth_type: 'api_key', cred_file: join(TEST_DIR, 'nope.json'), cred_key: 'api_key' }
    ]);
    const result = checkAllCredentials({ registryPath: REGISTRY_PATH });
    assert.equal(result.total, 3);
    assert.equal(result.healthy, 2);
    assert.equal(result.unhealthy, 1);
    assert.ok(result.warnings);
    assert.equal(result.warnings.length, 1);
  });
});

// ========== checkAllCredentialsLive (wq-825) ==========

describe('checkAllCredentialsLive', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('returns ok for successful HTTP 200 response', async () => {
    const credPath = writeCredFile('bearer.txt', 'real-token-abc12345');
    // Use non-.json extension so it's treated as a bearer token file
    const bearerPath = join(TEST_DIR, '.test-key');
    writeFileSync(bearerPath, 'real-token-abc12345');
    writeRegistry([
      {
        id: 'test-http', status: 'live', auth_type: 'bearer',
        cred_file: bearerPath, cred_key: null,
        test: { method: 'http', url: 'https://example.com/api', auth: 'bearer' }
      }
    ]);
    const mockFetch = async () => ({ status: 200, elapsed: 150 });
    const result = await checkAllCredentialsLive({
      registryPath: REGISTRY_PATH,
      safeFetch: mockFetch
    });
    assert.equal(result.total, 1);
    assert.equal(result.ok, 1);
    assert.equal(result.results[0].live_status, 'ok');
    assert.equal(result.results[0].http_status, 200);
  });

  it('detects auth failures (401/403)', async () => {
    const bearerPath = join(TEST_DIR, '.test-key2');
    writeFileSync(bearerPath, 'expired-token-12345678');
    writeRegistry([
      {
        id: 'auth-fail', status: 'live', auth_type: 'bearer',
        cred_file: bearerPath, cred_key: null,
        test: { method: 'http', url: 'https://example.com/api', auth: 'bearer' }
      }
    ]);
    const mockFetch = async () => ({ status: 401, elapsed: 100 });
    const result = await checkAllCredentialsLive({
      registryPath: REGISTRY_PATH,
      safeFetch: mockFetch
    });
    assert.equal(result.auth_fail, 1);
    assert.equal(result.results[0].live_status, 'auth_fail');
  });

  it('detects server errors (5xx)', async () => {
    const bearerPath = join(TEST_DIR, '.test-key3');
    writeFileSync(bearerPath, 'valid-token-12345678');
    writeRegistry([
      {
        id: 'srv-err', status: 'live', auth_type: 'bearer',
        cred_file: bearerPath, cred_key: null,
        test: { method: 'http', url: 'https://example.com/api', auth: 'bearer' }
      }
    ]);
    const mockFetch = async () => ({ status: 500, elapsed: 200 });
    const result = await checkAllCredentialsLive({
      registryPath: REGISTRY_PATH,
      safeFetch: mockFetch
    });
    assert.equal(result.server_error, 1);
    assert.equal(result.results[0].live_status, 'server_error');
  });

  it('handles fetch errors as timeouts', async () => {
    const bearerPath = join(TEST_DIR, '.test-key4');
    writeFileSync(bearerPath, 'valid-token-12345678');
    writeRegistry([
      {
        id: 'timeout-plat', status: 'live', auth_type: 'bearer',
        cred_file: bearerPath, cred_key: null,
        test: { method: 'http', url: 'https://example.com/api', auth: 'bearer' }
      }
    ]);
    const mockFetch = async () => ({ status: null, elapsed: 8000, error: 'timeout after 8000ms' });
    const result = await checkAllCredentialsLive({
      registryPath: REGISTRY_PATH,
      safeFetch: mockFetch
    });
    assert.equal(result.timeout, 1);
    assert.equal(result.results[0].live_status, 'timeout');
  });

  it('skips MCP-only platforms', async () => {
    writeRegistry([
      {
        id: 'mcp-plat', status: 'live', auth_type: 'none',
        cred_file: null, cred_key: null,
        test: { method: 'mcp', tool: 'some_tool' }
      }
    ]);
    const mockFetch = async () => { throw new Error('should not be called'); };
    const result = await checkAllCredentialsLive({
      registryPath: REGISTRY_PATH,
      safeFetch: mockFetch
    });
    assert.equal(result.total, 0); // MCP filtered out
  });

  it('filters by platform', async () => {
    const key1 = join(TEST_DIR, '.key1');
    const key2 = join(TEST_DIR, '.key2');
    writeFileSync(key1, 'token-aaa-12345678');
    writeFileSync(key2, 'token-bbb-12345678');
    writeRegistry([
      {
        id: 'alpha', status: 'live', auth_type: 'bearer',
        cred_file: key1, cred_key: null,
        test: { method: 'http', url: 'https://alpha.com/api', auth: 'bearer' }
      },
      {
        id: 'beta', status: 'live', auth_type: 'bearer',
        cred_file: key2, cred_key: null,
        test: { method: 'http', url: 'https://beta.com/api', auth: 'bearer' }
      }
    ]);
    const mockFetch = async () => ({ status: 200, elapsed: 50 });
    const result = await checkAllCredentialsLive({
      registryPath: REGISTRY_PATH,
      platformFilter: 'alpha',
      safeFetch: mockFetch
    });
    assert.equal(result.total, 1);
    assert.equal(result.results[0].id, 'alpha');
  });

  it('returns failure list for non-ok results', async () => {
    const key1 = join(TEST_DIR, '.key-a');
    const key2 = join(TEST_DIR, '.key-b');
    writeFileSync(key1, 'good-token-12345678');
    writeFileSync(key2, 'bad-token-123456789');
    writeRegistry([
      {
        id: 'good', status: 'live', auth_type: 'bearer',
        cred_file: key1, cred_key: null,
        test: { method: 'http', url: 'https://good.com/api', auth: 'bearer' }
      },
      {
        id: 'bad', status: 'live', auth_type: 'bearer',
        cred_file: key2, cred_key: null,
        test: { method: 'http', url: 'https://bad.com/api', auth: 'bearer' }
      }
    ]);
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return callCount === 1 ? { status: 200, elapsed: 50 } : { status: 403, elapsed: 50 };
    };
    const result = await checkAllCredentialsLive({
      registryPath: REGISTRY_PATH,
      safeFetch: mockFetch
    });
    assert.equal(result.ok, 1);
    assert.equal(result.auth_fail, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].id, 'bad');
  });

  it('handles missing registry', async () => {
    const result = await checkAllCredentialsLive({
      registryPath: '/nonexistent/path.json'
    });
    assert.ok(result.error);
    assert.equal(result.results.length, 0);
  });
});

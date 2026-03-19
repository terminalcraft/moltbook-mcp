#!/usr/bin/env node
// cred-reconcile.test.mjs — Unit tests for cred-reconcile.mjs (d077, wq-944)
//
// Tests the reconcile() function with dependency injection for fs operations.
// Covers: happy path (new creds auto-added), already-tracked skipping,
// malformed cred files, missing registry, and edge cases.
//
// Usage: node --test hooks/lib/cred-reconcile.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { reconcile } from './cred-reconcile.mjs';

function makeDeps({ files = {}, dirs = {} } = {}) {
  const written = {};
  return {
    deps: {
      readFileSync(path) {
        if (files[path] !== undefined) return files[path];
        throw new Error('ENOENT: ' + path);
      },
      writeFileSync(path, data) {
        written[path] = data;
      },
      readdirSync(path) {
        return dirs[path] || [];
      },
    },
    written,
  };
}

// ---- HAPPY PATH: new credential file discovered ----
describe('happy path — new cred file auto-added', () => {
  test('adds new entry for untracked credential file', () => {
    const baseDir = '/fake/moltbook-mcp';
    const regPath = baseDir + '/account-registry.json';
    const credPath = baseDir + '/newplatform-credentials.json';

    const registry = { accounts: [{ id: 'existing', platform: 'Existing', cred_file: '~/moltbook-mcp/existing-credentials.json' }] };
    const credContent = { api_key: 'sk-test', handle: 'moltbook', platform: 'NewPlatform' };

    const { deps, written } = makeDeps({
      files: {
        [regPath]: JSON.stringify(registry),
        [credPath]: JSON.stringify(credContent),
      },
      dirs: { [baseDir]: ['existing-credentials.json', 'newplatform-credentials.json'] },
    });

    const result = reconcile({ baseDir, session: '1962', deps });

    assert.strictEqual(result.added, 1);
    assert.strictEqual(result.newEntries.length, 1);
    assert.strictEqual(result.newEntries[0].platform, 'NewPlatform');
    assert.strictEqual(result.newEntries[0].handle, 'moltbook');
    assert.strictEqual(result.newEntries[0].auth_type, 'api_key');
    assert.ok(result.newEntries[0].notes.includes('s1962'));

    // Verify registry was written back
    const updatedReg = JSON.parse(written[regPath]);
    assert.strictEqual(updatedReg.accounts.length, 2);
  });

  test('derives platform name from filename when not in cred file', () => {
    const baseDir = '/fake/dir';
    const regPath = baseDir + '/account-registry.json';
    const credPath = baseDir + '/cool-service-credentials.json';

    const registry = { accounts: [] };
    const credContent = { token: 'tok-abc', username: 'agent42' };

    const { deps, written } = makeDeps({
      files: {
        [regPath]: JSON.stringify(registry),
        [credPath]: JSON.stringify(credContent),
      },
      dirs: { [baseDir]: ['cool-service-credentials.json'] },
    });

    const result = reconcile({ baseDir, session: '100', deps });

    assert.strictEqual(result.added, 1);
    assert.strictEqual(result.newEntries[0].platform, 'Cool Service');
    assert.strictEqual(result.newEntries[0].handle, 'agent42');
    assert.strictEqual(result.newEntries[0].cred_key, 'token');
  });

  test('adds multiple untracked cred files in one pass', () => {
    const baseDir = '/fake/dir';
    const regPath = baseDir + '/account-registry.json';

    const registry = { accounts: [] };

    const { deps, written } = makeDeps({
      files: {
        [regPath]: JSON.stringify(registry),
        [baseDir + '/alpha-credentials.json']: JSON.stringify({ api_key: 'k1', handle: 'h1' }),
        [baseDir + '/beta-credentials.json']: JSON.stringify({ apiKey: 'k2', name: 'h2' }),
      },
      dirs: { [baseDir]: ['alpha-credentials.json', 'beta-credentials.json'] },
    });

    const result = reconcile({ baseDir, session: '200', deps });

    assert.strictEqual(result.added, 2);
    const updatedReg = JSON.parse(written[regPath]);
    assert.strictEqual(updatedReg.accounts.length, 2);
  });
});

// ---- ALREADY TRACKED: skip existing entries ----
describe('already tracked — skips existing entries', () => {
  test('skips cred file matching existing platform name (normalized)', () => {
    const baseDir = '/fake/dir';
    const regPath = baseDir + '/account-registry.json';

    const registry = { accounts: [{ id: 'chatr', platform: 'Chatr.ai', cred_file: '~/moltbook-mcp/chatr-credentials.json' }] };

    const { deps, written } = makeDeps({
      files: {
        [regPath]: JSON.stringify(registry),
        [baseDir + '/chatrai-credentials.json']: JSON.stringify({ api_key: 'x' }),
      },
      dirs: { [baseDir]: ['chatrai-credentials.json'] },
    });

    const result = reconcile({ baseDir, session: '300', deps });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(Object.keys(written).length, 0); // no write
  });

  test('skips cred file matching existing account id', () => {
    const baseDir = '/fake/dir';
    const regPath = baseDir + '/account-registry.json';

    const registry = { accounts: [{ id: 'moltstack', platform: 'MoltStack' }] };

    const { deps } = makeDeps({
      files: {
        [regPath]: JSON.stringify(registry),
        [baseDir + '/moltstack-credentials.json']: JSON.stringify({ api_key: 'x' }),
      },
      dirs: { [baseDir]: ['moltstack-credentials.json'] },
    });

    const result = reconcile({ baseDir, session: '400', deps });
    assert.strictEqual(result.added, 0);
  });

  test('skips cred file matching existing cred_file path', () => {
    const baseDir = '/fake/dir';
    const regPath = baseDir + '/account-registry.json';

    const registry = { accounts: [{ id: 'x', platform: 'X', cred_file: '~/moltbook-mcp/special-credentials.json' }] };

    const { deps } = makeDeps({
      files: {
        [regPath]: JSON.stringify(registry),
        [baseDir + '/special-credentials.json']: JSON.stringify({ api_key: 'y' }),
      },
      dirs: { [baseDir]: ['special-credentials.json'] },
    });

    const result = reconcile({ baseDir, session: '500', deps });
    assert.strictEqual(result.added, 0);
  });
});

// ---- MALFORMED / MISSING INPUT ----
describe('malformed input handling', () => {
  test('returns added:0 when registry file is missing', () => {
    const baseDir = '/fake/dir';

    const { deps } = makeDeps({
      files: {}, // no registry file
      dirs: { [baseDir]: ['some-credentials.json'] },
    });

    const result = reconcile({ baseDir, session: '600', deps });
    assert.strictEqual(result.added, 0);
  });

  test('returns added:0 when registry has no accounts array', () => {
    const baseDir = '/fake/dir';
    const regPath = baseDir + '/account-registry.json';

    const { deps } = makeDeps({
      files: { [regPath]: JSON.stringify({ version: 1 }) },
      dirs: { [baseDir]: ['thing-credentials.json'] },
    });

    const result = reconcile({ baseDir, session: '700', deps });
    assert.strictEqual(result.added, 0);
  });

  test('skips credential files with malformed JSON', () => {
    const baseDir = '/fake/dir';
    const regPath = baseDir + '/account-registry.json';

    const registry = { accounts: [] };

    const { deps, written } = makeDeps({
      files: {
        [regPath]: JSON.stringify(registry),
        [baseDir + '/broken-credentials.json']: '{not valid json!!!',
      },
      dirs: { [baseDir]: ['broken-credentials.json'] },
    });

    const result = reconcile({ baseDir, session: '800', deps });
    assert.strictEqual(result.added, 0);
    assert.strictEqual(Object.keys(written).length, 0);
  });
});

// ---- EDGE CASES ----
describe('edge cases', () => {
  test('no credential files in directory returns added:0', () => {
    const baseDir = '/fake/dir';
    const regPath = baseDir + '/account-registry.json';

    const { deps } = makeDeps({
      files: { [regPath]: JSON.stringify({ accounts: [] }) },
      dirs: { [baseDir]: ['README.md', 'index.js'] },
    });

    const result = reconcile({ baseDir, session: '900', deps });
    assert.strictEqual(result.added, 0);
  });

  test('handle defaults to "moltbook" when no handle fields in cred file', () => {
    const baseDir = '/fake/dir';
    const regPath = baseDir + '/account-registry.json';

    const { deps } = makeDeps({
      files: {
        [regPath]: JSON.stringify({ accounts: [] }),
        [baseDir + '/mystery-credentials.json']: JSON.stringify({ api_key: 'abc' }),
      },
      dirs: { [baseDir]: ['mystery-credentials.json'] },
    });

    const result = reconcile({ baseDir, session: '1000', deps });
    assert.strictEqual(result.added, 1);
    assert.strictEqual(result.newEntries[0].handle, 'moltbook');
  });

  test('auth_type is "unknown" when no key/token fields present', () => {
    const baseDir = '/fake/dir';
    const regPath = baseDir + '/account-registry.json';

    const { deps } = makeDeps({
      files: {
        [regPath]: JSON.stringify({ accounts: [] }),
        [baseDir + '/nokey-credentials.json']: JSON.stringify({ handle: 'test', platform: 'NoKey' }),
      },
      dirs: { [baseDir]: ['nokey-credentials.json'] },
    });

    const result = reconcile({ baseDir, session: '1100', deps });
    assert.strictEqual(result.added, 1);
    assert.strictEqual(result.newEntries[0].auth_type, 'unknown');
  });
});

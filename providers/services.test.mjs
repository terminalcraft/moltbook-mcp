// Tests for providers/services.js — service registry (wq-771, d071)
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

const TEST_HOME = '/tmp/services-test-' + Date.now();
const MCP_DIR = join(TEST_HOME, 'moltbook-mcp');
const SERVICES_FILE = join(MCP_DIR, 'services.json');

// Set HOME before import
process.env.HOME = TEST_HOME;
mkdirSync(MCP_DIR, { recursive: true });

const { loadServices, saveServices } = await import('./services.js');

describe('providers/services.js', () => {
  beforeEach(() => {
    // Remove services file to start fresh
    try { rmSync(SERVICES_FILE); } catch {}
  });

  describe('loadServices', () => {
    it('returns default structure when file missing', () => {
      const result = loadServices();
      assert.strictEqual(result.version, 1);
      assert.ok(result.lastUpdated);
      assert.deepStrictEqual(result.directories, []);
      assert.deepStrictEqual(result.services, []);
    });

    it('reads existing services file', () => {
      const data = {
        version: 1,
        lastUpdated: '2026-01-01T00:00:00.000Z',
        directories: ['moltbook'],
        services: [{ name: 'test-svc', url: 'https://example.com', status: 'active' }]
      };
      writeFileSync(SERVICES_FILE, JSON.stringify(data));
      const result = loadServices();
      assert.strictEqual(result.directories.length, 1);
      assert.strictEqual(result.services[0].name, 'test-svc');
    });

    it('returns default on malformed JSON', () => {
      writeFileSync(SERVICES_FILE, 'not valid json {{{');
      const result = loadServices();
      assert.strictEqual(result.version, 1);
      assert.deepStrictEqual(result.services, []);
    });
  });

  describe('saveServices', () => {
    it('writes data to disk as JSON', () => {
      const data = {
        version: 1,
        lastUpdated: '2026-01-01',
        directories: [],
        services: [{ name: 'svc-1' }]
      };
      saveServices(data);
      assert.ok(existsSync(SERVICES_FILE));
      const raw = JSON.parse(readFileSync(SERVICES_FILE, 'utf8'));
      assert.strictEqual(raw.services[0].name, 'svc-1');
    });

    it('auto-updates lastUpdated timestamp', () => {
      const data = {
        version: 1,
        lastUpdated: '2020-01-01T00:00:00.000Z',
        directories: [],
        services: []
      };
      const before = new Date().toISOString();
      saveServices(data);
      const after = new Date().toISOString();

      const raw = JSON.parse(readFileSync(SERVICES_FILE, 'utf8'));
      assert.ok(raw.lastUpdated >= before, 'lastUpdated should be >= before');
      assert.ok(raw.lastUpdated <= after, 'lastUpdated should be <= after');
    });

    it('mutates the input object lastUpdated', () => {
      const data = { version: 1, lastUpdated: 'old', directories: [], services: [] };
      saveServices(data);
      assert.notStrictEqual(data.lastUpdated, 'old');
    });

    it('preserves complex service data', () => {
      const data = {
        version: 2,
        lastUpdated: '',
        directories: ['moltbook', 'chatr'],
        services: [
          { name: 'svc-a', url: 'https://a.com', status: 'active', probed: '2026-01-01', circuit: 'closed' },
          { name: 'svc-b', url: 'https://b.com', status: 'defunct', probed: '2026-02-01', circuit: 'open' }
        ]
      };
      saveServices(data);
      const raw = JSON.parse(readFileSync(SERVICES_FILE, 'utf8'));
      assert.strictEqual(raw.version, 2);
      assert.strictEqual(raw.directories.length, 2);
      assert.strictEqual(raw.services.length, 2);
      assert.strictEqual(raw.services[1].status, 'defunct');
    });
  });

  describe('round-trip', () => {
    it('save then load preserves data', () => {
      const data = {
        version: 1,
        lastUpdated: '',
        directories: ['dir-1'],
        services: [{ name: 'round-trip-svc', active: true }]
      };
      saveServices(data);
      const loaded = loadServices();
      assert.strictEqual(loaded.directories[0], 'dir-1');
      assert.strictEqual(loaded.services[0].name, 'round-trip-svc');
      assert.strictEqual(loaded.services[0].active, true);
    });
  });
});

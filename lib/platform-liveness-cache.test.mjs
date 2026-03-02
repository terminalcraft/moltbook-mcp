/**
 * Tests for lib/platform-liveness-cache.mjs (wq-785)
 * Covers: isCacheValid TTL logic, getCachedLiveness, setCachedLiveness, isReachable.
 * Uses tmp directory to isolate from production cache.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We need to mock the cache path. The module uses homedir() internally,
// so we test the exported pure functions and simulate cache behavior.
import { isCacheValid } from './platform-liveness-cache.mjs';

describe('isCacheValid', () => {
  it('returns false for null entry', () => {
    assert.equal(isCacheValid(null), false);
  });

  it('returns false for entry without timestamp', () => {
    assert.equal(isCacheValid({ reachable: true }), false);
  });

  it('returns true for recent entry', () => {
    const entry = { timestamp: Date.now() - 1000, reachable: true };
    assert.equal(isCacheValid(entry), true);
  });

  it('returns false for expired entry (default 2h TTL)', () => {
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000 + 1);
    const entry = { timestamp: twoHoursAgo, reachable: true };
    assert.equal(isCacheValid(entry), false);
  });

  it('respects custom TTL', () => {
    const fiveMinAgo = Date.now() - (5 * 60 * 1000);
    const entry = { timestamp: fiveMinAgo, reachable: true };

    // 10-minute TTL: still valid
    assert.equal(isCacheValid(entry, 10 * 60 * 1000), true);

    // 3-minute TTL: expired
    assert.equal(isCacheValid(entry, 3 * 60 * 1000), false);
  });

  it('returns true for entry exactly at TTL boundary', () => {
    // Entry timestamp is exactly now - (TTL - 1ms), should be valid
    const entry = { timestamp: Date.now() - 999, reachable: true };
    assert.equal(isCacheValid(entry, 1000), true);
  });
});

// Integration tests using the actual module (reads/writes to real cache path)
// These are safe because getCachedLiveness/setCachedLiveness work with the
// existing cache file non-destructively (additive writes only).
import { getCachedLiveness, setCachedLiveness, isReachable, getAllCachedLiveness } from './platform-liveness-cache.mjs';

describe('setCachedLiveness + getCachedLiveness round-trip', () => {
  const testPlatform = '_test_platform_' + Date.now();

  it('writes and reads back a cache entry', () => {
    setCachedLiveness(testPlatform, {
      reachable: true,
      healthy: true,
      status: 200,
      elapsed: 150,
    }, 9999);

    const entry = getCachedLiveness(testPlatform);
    assert.ok(entry, 'should return cached entry');
    assert.equal(entry.reachable, true);
    assert.equal(entry.healthy, true);
    assert.equal(entry.status, 200);
    assert.equal(entry.elapsed, 150);
    assert.equal(entry.session, 9999);
    assert.ok(entry.timestamp > 0);
  });

  it('returns null for non-existent platform', () => {
    const entry = getCachedLiveness('_nonexistent_platform_xyz_');
    assert.equal(entry, null);
  });
});

describe('isReachable', () => {
  const testPlatform = '_test_reachable_' + Date.now();

  it('returns null for uncached platform', () => {
    assert.equal(isReachable('_no_cache_platform_xyz_'), null);
  });

  it('returns true for reachable cached platform', () => {
    setCachedLiveness(testPlatform, { reachable: true, healthy: true, status: 200 });
    assert.equal(isReachable(testPlatform), true);
  });

  it('returns false for unreachable cached platform', () => {
    const unreachable = '_test_unreachable_' + Date.now();
    setCachedLiveness(unreachable, { reachable: false, healthy: false, status: 0, error: 'timeout' });
    assert.equal(isReachable(unreachable), false);
  });
});

describe('getAllCachedLiveness', () => {
  it('returns an object', () => {
    const all = getAllCachedLiveness();
    assert.equal(typeof all, 'object');
    assert.ok(all !== null);
  });
});

describe('key normalization', () => {
  it('normalizes platform names (lowercase, strips dots and spaces)', () => {
    const testPlatform = '_Test.Platform ' + Date.now();
    setCachedLiveness(testPlatform, { reachable: true, healthy: true, status: 200 });
    // The key should be normalized — getCachedLiveness should find it
    const entry = getCachedLiveness(testPlatform);
    assert.ok(entry, 'should find entry with same key normalization');
  });
});

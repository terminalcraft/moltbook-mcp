/**
 * Tests for lib/platform-names.mjs (wq-785)
 * Covers: normalizePlatformName, getDisplayName — alias resolution, case handling, fallback.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlatformName, getDisplayName } from './platform-names.mjs';

describe('normalizePlatformName', () => {
  it('returns lowercase for known platforms', () => {
    assert.equal(normalizePlatformName('Moltbook'), 'moltbook');
    assert.equal(normalizePlatformName('MOLTCHAN'), 'moltchan');
  });

  it('resolves aliases to canonical names', () => {
    assert.equal(normalizePlatformName('fourclaw'), '4claw');
    assert.equal(normalizePlatformName('thecolony'), 'colony');
    assert.equal(normalizePlatformName('thecolony.cc'), 'colony');
    assert.equal(normalizePlatformName('4claw.org'), '4claw');
    assert.equal(normalizePlatformName('Chatr.ai'), 'chatr');
    assert.equal(normalizePlatformName('ctxly chat'), 'ctxly');
    assert.equal(normalizePlatformName('mydeadinternet.com'), 'mydeadinternet');
  });

  it('handles empty/null input gracefully', () => {
    assert.equal(normalizePlatformName(''), '');
    assert.equal(normalizePlatformName(null), '');
    assert.equal(normalizePlatformName(undefined), '');
  });

  it('trims whitespace', () => {
    assert.equal(normalizePlatformName('  moltbook  '), 'moltbook');
    assert.equal(normalizePlatformName(' TheColony '), 'colony');
  });

  it('passes through unknown names as lowercase', () => {
    assert.equal(normalizePlatformName('SomeNewPlatform'), 'somenewplatform');
  });
});

describe('getDisplayName', () => {
  it('returns display name for known platforms', () => {
    assert.equal(getDisplayName('moltbook'), 'Moltbook');
    assert.equal(getDisplayName('4claw'), '4claw.org');
    assert.equal(getDisplayName('chatr'), 'Chatr.ai');
    assert.equal(getDisplayName('moltchan'), 'Moltchan');
    assert.equal(getDisplayName('aicq'), 'AICQ');
  });

  it('resolves aliases then looks up display name', () => {
    assert.equal(getDisplayName('fourclaw'), '4claw.org');
    assert.equal(getDisplayName('thecolony'), 'thecolony.cc');
    assert.equal(getDisplayName('Chatr.ai'), 'Chatr.ai');
  });

  it('falls back to input for unknown platforms', () => {
    assert.equal(getDisplayName('UnknownPlatform'), 'UnknownPlatform');
  });
});

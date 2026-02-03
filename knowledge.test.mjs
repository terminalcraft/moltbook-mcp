// knowledge.test.mjs — Tests for providers/knowledge.js
// B#201: Tests for pattern loading, saving, digest generation, tag matching

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We'll test the provider functions by creating a temp knowledge directory
const TEST_DIR = join(tmpdir(), `knowledge-test-${Date.now()}`);
const TEST_KNOWLEDGE_DIR = join(TEST_DIR, 'knowledge');
const TEST_PATTERNS_FILE = join(TEST_KNOWLEDGE_DIR, 'patterns.json');
const TEST_REPOS_FILE = join(TEST_KNOWLEDGE_DIR, 'repos-crawled.json');
const TEST_DIGEST_FILE = join(TEST_KNOWLEDGE_DIR, 'digest.md');

// Mock HOME for the provider module
const originalHome = process.env.HOME;

// Import providers/knowledge.js functions (requires dynamic import after HOME change)
let loadPatterns, savePatterns, loadReposCrawled, saveReposCrawled, regenerateDigest, findPatternsByTags;

describe('providers/knowledge.js', async () => {
  beforeEach(async () => {
    // Set HOME to test directory
    process.env.HOME = TEST_DIR;
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, 'moltbook-mcp', 'knowledge'), { recursive: true });

    // Re-import to pick up new HOME
    const mod = await import(`./providers/knowledge.js?t=${Date.now()}`);
    loadPatterns = mod.loadPatterns;
    savePatterns = mod.savePatterns;
    loadReposCrawled = mod.loadReposCrawled;
    saveReposCrawled = mod.saveReposCrawled;
    regenerateDigest = mod.regenerateDigest;
    findPatternsByTags = mod.findPatternsByTags;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test('loadPatterns returns empty structure when file missing', async () => {
    const data = loadPatterns();
    assert.equal(data.version, 1);
    assert.ok(Array.isArray(data.patterns));
    assert.equal(data.patterns.length, 0);
  });

  test('savePatterns creates file and updates lastUpdated', async () => {
    const data = {
      version: 1,
      patterns: [{ id: 'p001', title: 'Test', category: 'architecture', confidence: 'verified' }]
    };
    savePatterns(data);

    const saved = loadPatterns();
    assert.equal(saved.patterns.length, 1);
    assert.equal(saved.patterns[0].title, 'Test');
    assert.ok(saved.lastUpdated); // Should have lastUpdated set
  });

  test('loadReposCrawled returns empty structure when file missing', async () => {
    const data = loadReposCrawled();
    assert.equal(data.version, 1);
    assert.deepEqual(data.repos, {});
  });

  test('saveReposCrawled persists repo data', async () => {
    const data = {
      version: 1,
      repos: {
        'github.com/test/repo': { lastCrawled: '2026-01-01T00:00:00Z', filesRead: ['README.md'] }
      }
    };
    saveReposCrawled(data);

    const saved = loadReposCrawled();
    assert.ok(saved.repos['github.com/test/repo']);
    assert.equal(saved.repos['github.com/test/repo'].filesRead[0], 'README.md');
  });
});

describe('findPatternsByTags', () => {
  test('returns empty array with no task tags', () => {
    const patterns = [{ title: 'P1', tags: ['api', 'rest'] }];
    const result = findPatternsByTags(patterns, []);
    assert.equal(result.length, 0);
  });

  test('returns empty array with null task tags', () => {
    const patterns = [{ title: 'P1', tags: ['api', 'rest'] }];
    const result = findPatternsByTags(patterns, null);
    assert.equal(result.length, 0);
  });

  test('matches patterns by overlapping tags', () => {
    const patterns = [
      { title: 'API Design', tags: ['api', 'rest', 'design'] },
      { title: 'CLI Tools', tags: ['cli', 'bash'] },
      { title: 'REST Client', tags: ['api', 'http'] },
    ];
    const result = findPatternsByTags(patterns, ['api']);
    assert.equal(result.length, 2);
    assert.ok(result.some(r => r.pattern.title === 'API Design'));
    assert.ok(result.some(r => r.pattern.title === 'REST Client'));
  });

  test('scores by overlap count', () => {
    const patterns = [
      { title: 'Multi-tag', tags: ['api', 'rest', 'test'] },
      { title: 'Single-tag', tags: ['api'] },
    ];
    const result = findPatternsByTags(patterns, ['api', 'rest']);
    assert.equal(result[0].pattern.title, 'Multi-tag'); // Higher overlap
    assert.equal(result[0].score, 2);
    assert.equal(result[1].score, 1);
  });

  test('handles patterns with no tags', () => {
    const patterns = [
      { title: 'Tagged', tags: ['api'] },
      { title: 'Untagged' }, // no tags field
      { title: 'Empty', tags: [] },
    ];
    const result = findPatternsByTags(patterns, ['api']);
    assert.equal(result.length, 1);
    assert.equal(result[0].pattern.title, 'Tagged');
  });

  test('case-insensitive tag matching', () => {
    const patterns = [{ title: 'P1', tags: ['API', 'REST'] }];
    const result = findPatternsByTags(patterns, ['api', 'rest']);
    assert.equal(result.length, 1);
    assert.equal(result[0].score, 2);
  });
});

describe('regenerateDigest', async () => {
  beforeEach(async () => {
    process.env.HOME = TEST_DIR;
    mkdirSync(join(TEST_DIR, 'moltbook-mcp', 'knowledge'), { recursive: true });

    const mod = await import(`./providers/knowledge.js?t=${Date.now()}`);
    loadPatterns = mod.loadPatterns;
    savePatterns = mod.savePatterns;
    regenerateDigest = mod.regenerateDigest;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('generates digest with no patterns', () => {
    savePatterns({ version: 1, patterns: [] });
    const digest = regenerateDigest();
    assert.ok(digest.includes('Knowledge Digest'));
    assert.ok(digest.includes('0 patterns'));
  });

  test('groups patterns by category', () => {
    savePatterns({
      version: 1,
      patterns: [
        { id: 'p001', title: 'Arch1', category: 'architecture', confidence: 'verified', source: 'self:s1', extractedAt: new Date().toISOString() },
        { id: 'p002', title: 'Tool1', category: 'tooling', confidence: 'observed', source: 'github.com/foo/bar', extractedAt: new Date().toISOString() },
      ]
    });
    const digest = regenerateDigest();
    assert.ok(digest.includes('Architecture'));
    assert.ok(digest.includes('Tooling'));
    assert.ok(digest.includes('Arch1'));
    assert.ok(digest.includes('Tool1'));
  });

  test('tailors digest for B session type', () => {
    savePatterns({
      version: 1,
      patterns: [
        { id: 'p001', title: 'Arch1', category: 'architecture', confidence: 'verified', source: 'self:s1', extractedAt: new Date().toISOString() },
      ]
    });
    const digest = regenerateDigest('B');
    assert.ok(digest.includes('Session: Build'));
    assert.ok(digest.includes('shipping code'));
  });

  test('shows health stats for R session type', () => {
    savePatterns({
      version: 1,
      patterns: [
        { id: 'p001', title: 'Old', category: 'architecture', confidence: 'verified', source: 'self:s1', extractedAt: '2025-01-01T00:00:00Z' },
        { id: 'p002', title: 'New', category: 'architecture', confidence: 'consensus', source: 'self:s2', extractedAt: new Date().toISOString() },
      ]
    });
    const digest = regenerateDigest('R');
    assert.ok(digest.includes('Session: Reflect'));
    assert.ok(digest.includes('Health'));
    assert.ok(digest.includes('1 consensus'));
  });

  test('includes task tag suggestions when provided', () => {
    savePatterns({
      version: 1,
      patterns: [
        { id: 'p001', title: 'API Pattern', category: 'architecture', confidence: 'verified', source: 'self:s1', tags: ['api', 'rest'], extractedAt: new Date().toISOString() },
      ]
    });
    const digest = regenerateDigest(null, ['api']);
    assert.ok(digest.includes('Suggested for this task'));
    assert.ok(digest.includes('API Pattern'));
  });

  test('counts pattern sources correctly', () => {
    savePatterns({
      version: 1,
      patterns: [
        { id: 'p001', title: 'Self', category: 'architecture', confidence: 'verified', source: 'self:s1', extractedAt: new Date().toISOString() },
        { id: 'p002', title: 'Crawl', category: 'tooling', confidence: 'observed', source: 'github.com/foo/bar', extractedAt: new Date().toISOString() },
        { id: 'p003', title: 'Exchange', category: 'ecosystem', confidence: 'observed', source: 'exchange:agent1', extractedAt: new Date().toISOString() },
      ]
    });
    const digest = regenerateDigest();
    assert.ok(digest.includes('1 self-derived'));
    assert.ok(digest.includes('1 from repo crawls'));
    assert.ok(digest.includes('1 from agent exchange'));
  });
});

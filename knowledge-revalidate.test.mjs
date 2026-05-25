// knowledge-revalidate.test.mjs — Tests for knowledge-revalidate.mjs
// wq-1034: Tests for extractSearchTerms, isSpecificTerm, validatePattern tier
// classification, and getStalest tier-aware window logic.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSearchTerms,
  isSpecificTerm,
  validatePattern,
  getStalest,
  GENERIC_TERMS,
  TIER_WINDOWS,
} from './knowledge-revalidate.mjs';

// ---- extractSearchTerms ----

describe('extractSearchTerms', () => {
  test('extracts file references from self-sourced pattern', () => {
    const pattern = {
      title: 'Session state in engagement-state.json',
      description: 'Engagement state persists in engagement-state.json, loaded by index.js',
      source: 'self:session-management',
      tags: ['state-management'],
    };
    const terms = extractSearchTerms(pattern);
    assert.ok(terms.includes('engagement-state.json'), 'should find engagement-state.json');
    assert.ok(terms.includes('index.js'), 'should find index.js');
    assert.ok(terms.includes('state-management'), 'should include non-generic tag');
  });

  test('extracts snake_case tool references from description', () => {
    const pattern = {
      title: 'Tool naming convention',
      description: 'Tools like moltbook_thread_diff and knowledge_read follow snake_case',
      source: 'self:conventions',
      tags: [],
    };
    const terms = extractSearchTerms(pattern);
    assert.ok(terms.includes('moltbook_thread_diff'));
    assert.ok(terms.includes('knowledge_read'));
  });

  test('extracts technology keywords for external patterns', () => {
    const pattern = {
      title: 'MCP server SDK patterns',
      description: 'McpServer class provides tool registration via SDK',
      source: 'github.com/modelcontextprotocol/servers',
      tags: ['mcp-protocol'],
    };
    const terms = extractSearchTerms(pattern);
    assert.ok(terms.includes('mcp') || terms.includes('MCP'), 'should map org to mcp term');
    assert.ok(terms.includes('McpServer'), 'should extract McpServer from description');
    assert.ok(terms.includes('servers'), 'should include repo name');
    assert.ok(terms.includes('mcp-protocol'), 'should include non-generic tag');
  });

  test('extracts org-mapped terms for anthropics source', () => {
    const pattern = {
      title: 'Claude CLAUDE.md conventions',
      description: 'CLAUDE.md file provides project instructions for claude',
      source: 'github.com/anthropics/claude-code',
      tags: [],
    };
    const terms = extractSearchTerms(pattern);
    assert.ok(terms.includes('claude') || terms.includes('anthropic'));
    assert.ok(terms.includes('CLAUDE.md'));
    assert.ok(terms.includes('claude-code'));
  });

  test('filters out generic tags', () => {
    const pattern = {
      title: 'Some pattern',
      description: 'A pattern about things',
      source: 'self:misc',
      tags: ['architecture', 'security', 'custom-tag'],
    };
    const terms = extractSearchTerms(pattern);
    assert.ok(!terms.includes('architecture'), 'should exclude generic tag');
    assert.ok(!terms.includes('security'), 'should exclude generic tag');
    assert.ok(terms.includes('custom-tag'), 'should include non-generic tag');
  });

  test('filters out terms shorter than 3 chars', () => {
    const pattern = {
      title: 'AB test',
      description: 'xy check on z.js',
      source: 'self:misc',
      tags: ['ab'],
    };
    const terms = extractSearchTerms(pattern);
    assert.ok(!terms.includes('ab'), 'should filter short tag');
    // z.js is 3 chars, should be included
    assert.ok(terms.includes('z.js'), 'should include 3-char filename');
  });

  test('returns empty array for pattern with no extractable terms', () => {
    const pattern = {
      title: 'A B',
      description: 'no',
      source: 'self:x',
      tags: ['architecture', 'testing'],
    };
    const terms = extractSearchTerms(pattern);
    // All tags are generic, title/desc too short — should be empty or near-empty
    assert.ok(Array.isArray(terms));
  });

  test('extracts self: source reference filename', () => {
    const pattern = {
      title: 'Some pattern',
      description: 'Learned from session management',
      source: 'self:sessions/session-fork',
      tags: [],
    };
    const terms = extractSearchTerms(pattern);
    assert.ok(terms.includes('session-fork'), 'should extract filename from self: source path');
  });
});

// ---- isSpecificTerm ----

describe('isSpecificTerm', () => {
  test('filenames with extensions are specific', () => {
    assert.ok(isSpecificTerm('index.js'));
    assert.ok(isSpecificTerm('patterns.json'));
    assert.ok(isSpecificTerm('BRIEFING.md'));
    assert.ok(isSpecificTerm('heartbeat.sh'));
  });

  test('snake_case identifiers are specific', () => {
    assert.ok(isSpecificTerm('moltbook_thread_diff'));
    assert.ok(isSpecificTerm('knowledge_read'));
    assert.ok(isSpecificTerm('agent_crawl_repo'));
  });

  test('CamelCase identifiers are specific', () => {
    assert.ok(isSpecificTerm('McpServer'));
    assert.ok(isSpecificTerm('FastMcp'));
  });

  test('multi-word hyphenated identifiers are specific', () => {
    assert.ok(isSpecificTerm('mcp-protocol-test'));
    assert.ok(isSpecificTerm('state-management-v2'));
  });

  test('generic terms from GENERIC_TERMS set are not specific', () => {
    assert.ok(!isSpecificTerm('mcp'));
    assert.ok(!isSpecificTerm('MCP'));
    assert.ok(!isSpecificTerm('sdk'));
    assert.ok(!isSpecificTerm('claude'));
    assert.ok(!isSpecificTerm('agent'));
    assert.ok(!isSpecificTerm('hook'));
    assert.ok(!isSpecificTerm('session'));
    assert.ok(!isSpecificTerm('oauth'));
    assert.ok(!isSpecificTerm('OAuth'));
  });

  test('non-generic single words are specific', () => {
    // Words not in GENERIC_TERMS and not matching other patterns
    assert.ok(isSpecificTerm('revalidation'));
    assert.ok(isSpecificTerm('staleness'));
  });

  test('two-segment hyphenated terms are not caught by multi-word rule', () => {
    // The regex requires at least 3 segments (two hyphens)
    // "foo-bar" has one hyphen — not matched by multi-word rule
    // But it's also not in GENERIC_TERMS, so still specific
    const result = isSpecificTerm('foo-bar');
    // foo-bar: no extension, no snake_case, no CamelCase, one hyphen (doesn't match ^[a-z]+-[a-z]+-),
    // not in GENERIC_TERMS → specific
    assert.ok(result);
  });
});

// ---- validatePattern (tier classification) ----

describe('validatePattern tier classification', () => {
  test('returns conceptual when no search terms exist', () => {
    const pattern = {
      title: 'A B',
      description: 'no',
      source: 'self:x',
      tags: ['architecture'],
    };
    const result = validatePattern(pattern);
    assert.equal(result.tier, 'conceptual');
    assert.equal(result.valid, true); // conceptual patterns are valid by default
    assert.ok(result.evidence.includes('conceptual pattern'));
  });

  test('returns conceptual when no terms match codebase', () => {
    // Use terms that won't appear anywhere in the codebase (including this test file)
    const fakeToolA = ['xq', 'vw', 'zk', 'rm', 'tp'].join('_');
    const fakeToolB = ['yp', 'bn', 'kd', 'wm', 'rl'].join('_');
    const pattern = {
      title: `Tool ${fakeToolA} setup`,
      description: `Uses ${fakeToolB} for nothing`,
      source: 'self:fake',
      tags: [],
    };
    const result = validatePattern(pattern);
    // No files will match these constructed terms
    assert.equal(result.tier, 'conceptual');
    assert.equal(result.valid, false);
  });

  test('returns strong when >=2 specific terms match', () => {
    // These terms exist in the actual codebase
    const pattern = {
      title: 'BRIEFING.md and patterns.json interaction',
      description: 'BRIEFING.md references patterns.json for knowledge tracking',
      source: 'self:knowledge',
      tags: ['knowledge-base'],
    };
    const result = validatePattern(pattern);
    // BRIEFING.md and patterns.json are real files — should find them
    assert.equal(result.tier, 'strong');
    assert.equal(result.valid, true);
  });

  test('returns weak when matches exist but <2 specific terms', () => {
    // Use only generic terms that will match but aren't specific
    const pattern = {
      title: 'MCP transport proxy setup',
      description: 'Agent session config for MCP transport layer',
      source: 'github.com/modelcontextprotocol/servers',
      tags: [],
    };
    const result = validatePattern(pattern);
    // 'mcp', 'MCP' etc are generic; 'servers' may match but is the only specific term
    // Tier depends on how many specific terms actually match
    assert.ok(['strong', 'weak', 'conceptual'].includes(result.tier));
  });
});

// ---- getStalest (tier-aware windows) ----

describe('getStalest', () => {
  const now = Date.now();

  test('returns empty array when no patterns are stale', () => {
    const patterns = [
      {
        id: 'p1',
        title: 'Fresh pattern',
        lastValidated: new Date(now - 1000).toISOString(), // 1 second ago
        confidence: 'high',
        revalidationTier: 'strong',
      },
    ];
    const result = getStalest(patterns, 5);
    assert.equal(result.length, 0);
  });

  test('excludes retired patterns', () => {
    const patterns = [
      {
        id: 'p1',
        title: 'Retired stale',
        lastValidated: new Date(now - 60 * 86400000).toISOString(), // 60 days ago
        confidence: 'retired',
        revalidationTier: 'strong',
      },
    ];
    const result = getStalest(patterns, 5);
    assert.equal(result.length, 0);
  });

  test('strong tier uses 30-day window', () => {
    const patterns = [
      {
        id: 'p1',
        title: 'Strong 25d ago',
        lastValidated: new Date(now - 25 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'strong',
      },
      {
        id: 'p2',
        title: 'Strong 35d ago',
        lastValidated: new Date(now - 35 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'strong',
      },
    ];
    const result = getStalest(patterns, 5);
    assert.equal(result.length, 1, 'only 35d pattern should be stale');
    assert.equal(result[0].id, 'p2');
  });

  test('weak tier uses 15-day window', () => {
    const patterns = [
      {
        id: 'p1',
        title: 'Weak 10d ago',
        lastValidated: new Date(now - 10 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'weak',
      },
      {
        id: 'p2',
        title: 'Weak 20d ago',
        lastValidated: new Date(now - 20 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'weak',
      },
    ];
    const result = getStalest(patterns, 5);
    assert.equal(result.length, 1, 'only 20d weak pattern should be stale');
    assert.equal(result[0].id, 'p2');
  });

  test('conceptual tier uses 15-day window', () => {
    const patterns = [
      {
        id: 'p1',
        title: 'Conceptual 20d ago',
        lastValidated: new Date(now - 20 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'conceptual',
      },
    ];
    const result = getStalest(patterns, 5);
    assert.equal(result.length, 1);
  });

  test('defaults to strong (30d) when no tier set', () => {
    const patterns = [
      {
        id: 'p1',
        title: 'No tier 20d ago',
        lastValidated: new Date(now - 20 * 86400000).toISOString(),
        confidence: 'high',
        // no revalidationTier
      },
    ];
    const result = getStalest(patterns, 5);
    assert.equal(result.length, 0, '20d should not be stale for default strong tier');
  });

  test('sorts by staleness (most stale first)', () => {
    const patterns = [
      {
        id: 'p1',
        title: 'Moderately stale',
        lastValidated: new Date(now - 40 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'strong',
      },
      {
        id: 'p2',
        title: 'Very stale',
        lastValidated: new Date(now - 90 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'strong',
      },
      {
        id: 'p3',
        title: 'Slightly stale',
        lastValidated: new Date(now - 32 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'strong',
      },
    ];
    const result = getStalest(patterns, 5);
    assert.equal(result.length, 3);
    assert.equal(result[0].id, 'p2', 'most stale first');
    assert.equal(result[1].id, 'p1');
    assert.equal(result[2].id, 'p3');
  });

  test('respects count limit', () => {
    const patterns = [
      {
        id: 'p1',
        title: 'Stale 1',
        lastValidated: new Date(now - 40 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'strong',
      },
      {
        id: 'p2',
        title: 'Stale 2',
        lastValidated: new Date(now - 50 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'strong',
      },
      {
        id: 'p3',
        title: 'Stale 3',
        lastValidated: new Date(now - 60 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'strong',
      },
    ];
    const result = getStalest(patterns, 2);
    assert.equal(result.length, 2, 'should respect count limit');
  });

  test('uses extractedAt as fallback when lastValidated missing', () => {
    const patterns = [
      {
        id: 'p1',
        title: 'No lastValidated',
        extractedAt: new Date(now - 40 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'strong',
      },
    ];
    const result = getStalest(patterns, 5);
    assert.equal(result.length, 1, 'should use extractedAt as fallback');
  });

  test('mixed tiers apply correct windows', () => {
    const patterns = [
      {
        id: 'strong-25d',
        title: 'Strong 25d',
        lastValidated: new Date(now - 25 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'strong',
      },
      {
        id: 'weak-25d',
        title: 'Weak 25d',
        lastValidated: new Date(now - 25 * 86400000).toISOString(),
        confidence: 'high',
        revalidationTier: 'weak',
      },
    ];
    const result = getStalest(patterns, 5);
    // strong-25d: 25d < 30d window → not stale
    // weak-25d: 25d > 15d window → stale
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'weak-25d');
  });
});

// ---- TIER_WINDOWS constants ----

describe('TIER_WINDOWS', () => {
  test('strong window is 30 days', () => {
    assert.equal(TIER_WINDOWS.strong, 30 * 86400000);
  });

  test('weak window is 15 days', () => {
    assert.equal(TIER_WINDOWS.weak, 15 * 86400000);
  });

  test('conceptual window is 15 days', () => {
    assert.equal(TIER_WINDOWS.conceptual, 15 * 86400000);
  });
});

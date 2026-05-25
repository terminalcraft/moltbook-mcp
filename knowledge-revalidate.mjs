#!/usr/bin/env node
/**
 * knowledge-revalidate.mjs — Revalidate stale knowledge patterns.
 *
 * Picks the N most stale patterns from knowledge/patterns.json and checks
 * whether each pattern still applies to the current codebase by searching
 * for related keywords. Updates lastValidated for patterns that pass.
 *
 * Validation strategy:
 *   - Extract search terms from pattern title, tags, and description
 *   - Grep the codebase for those terms
 *   - If ≥2 distinct files reference pattern concepts → validated
 *   - Self-sourced patterns also check if referenced files/tools exist
 *
 * Usage:
 *   node knowledge-revalidate.mjs [--count N] [--dry-run]
 *
 * Designed to run every B session via b-prehook-runner.mjs.
 *
 * Created: wq-1027 (d081 deliverable)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const MCP_DIR = join(process.env.HOME || '/tmp', 'moltbook-mcp');
const PATTERNS_FILE = join(MCP_DIR, 'knowledge', 'patterns.json');
const THIRTY_DAYS_MS = 30 * 86400000;
const FIFTEEN_DAYS_MS = 15 * 86400000;

/**
 * Revalidation quality tiers (wq-1029):
 *   - "strong": pattern-specific identifiers found in active code (≥2 specific terms match)
 *   - "weak": only generic technology terms matched (matches exist but all generic)
 *   - "conceptual": no codebase evidence at all
 *
 * Weak/conceptual patterns use 15-day revalidation windows instead of 30.
 */
const TIER_WINDOWS = {
  strong: THIRTY_DAYS_MS,
  weak: FIFTEEN_DAYS_MS,
  conceptual: FIFTEEN_DAYS_MS,
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const countIdx = args.indexOf('--count');
const batchSize = countIdx >= 0 ? parseInt(args[countIdx + 1], 10) || 10 : 10;

function loadPatterns() {
  return JSON.parse(readFileSync(PATTERNS_FILE, 'utf8'));
}

/**
 * Get patterns sorted by staleness (most stale first), excluding retired.
 * Uses tier-aware staleness windows: strong=30d, weak/conceptual=15d.
 */
function getStalest(patterns, n) {
  const now = Date.now();
  return patterns
    .filter(p => p.confidence !== 'retired')
    .map(p => {
      const lastValidated = new Date(p.lastValidated || p.extractedAt || 0).getTime();
      const tier = p.revalidationTier || 'strong';
      const window = TIER_WINDOWS[tier] || THIRTY_DAYS_MS;
      return { pattern: p, lastValidated, window };
    })
    .filter(p => (now - p.lastValidated) > p.window)
    .sort((a, b) => a.lastValidated - b.lastValidated)
    .slice(0, n)
    .map(p => p.pattern);
}

/**
 * Extract search keywords from a pattern.
 * Returns an array of terms to grep for.
 *
 * Strategy differs by source:
 * - self:* patterns → look for specific files, tools, identifiers in our code
 * - github.com/* patterns → look for the technology/concept being used in our code
 */
function extractSearchTerms(pattern) {
  const terms = new Set();
  const text = `${pattern.title} ${pattern.description}`;
  const isExternal = pattern.source && pattern.source.startsWith('github.com/');

  if (isExternal) {
    // For external patterns, search for the technology/framework they describe.
    // These are knowledge patterns — valid if we use the referenced technology.

    // Extract technology keywords from source path
    const sourceParts = pattern.source.replace('github.com/', '').split('/');
    const org = sourceParts[0]; // e.g., "anthropics", "modelcontextprotocol"
    const repo = sourceParts[1]; // e.g., "claude-code", "servers"

    // Map known orgs/repos to codebase search terms
    const techMap = {
      'anthropics': ['claude', 'anthropic'],
      'modelcontextprotocol': ['mcp', 'MCP', 'McpServer'],
      'jlowin': ['mcp', 'fastmcp'],
      'microsoft': ['autogen', 'agent'],
      'ClawHub-core': ['agent', 'a2a', 'skill'],
    };

    const orgTerms = techMap[org] || [];
    orgTerms.forEach(t => terms.add(t));

    // Add repo name if specific enough
    if (repo && repo.length > 3) terms.add(repo);

    // Add specific technical terms from description
    const techTerms = text.match(/\b(?:MCP|SDK|CLAUDE\.md|AGENTS\.md|SKILL\.md|OAuth|Ed25519|McpServer|slash.command|hook|transport|proxy|subagent|fan.out)\b/gi) || [];
    techTerms.forEach(t => terms.add(t));

  } else {
    // Self-sourced patterns: look for specific references in our code

    // File/tool names (e.g., BRIEFING.md, patterns.json, moltbook_thread_diff)
    const fileRefs = text.match(/[a-zA-Z][\w-]*\.(md|json|js|mjs|cjs|sh|txt)/g) || [];
    fileRefs.forEach(f => terms.add(f));

    const toolRefs = text.match(/\b[a-z]+_[a-z_]+\b/g) || [];
    toolRefs.forEach(t => terms.add(t));

    // Specific technical terms
    const techTerms = text.match(/\b(?:MCP|SDK|CLAUDE\.md|BRIEFING\.md|Ed25519|TOFU|sanitize|USER_CONTENT|backoff|dedup|rotation|handshake|session.fork|checkpoint|verify.before.assert)\b/gi) || [];
    techTerms.forEach(t => terms.add(t));

    // Source reference
    if (pattern.source && pattern.source.startsWith('self:')) {
      const ref = pattern.source.replace('self:', '');
      if (ref.includes('/')) terms.add(ref.split('/').pop());
    }
  }

  // Add non-generic tags
  const genericTags = new Set([
    'architecture', 'tooling', 'reliability', 'ecosystem',
    'prompting', 'security', 'testing', 'code-quality',
  ]);
  for (const tag of (pattern.tags || [])) {
    if (!genericTags.has(tag) && tag.length >= 3) {
      terms.add(tag);
    }
  }

  return [...terms].filter(t => t.length >= 3);
}

/**
 * Grep the codebase for a term. Returns count of matching files.
 * Searches only project-relevant files, skips node_modules and .git.
 */
function grepFileCount(term) {
  try {
    const escaped = term.replace(/'/g, "'\\''").replace(/[[\]{}()*+?.\\^$|]/g, '\\$&');
    const includes = ['js','mjs','cjs','json','md','sh'].map(e => `--include='*.${e}'`).join(' ');
    const result = execSync(
      `grep -rli ${includes} -m 1 '${escaped}' '${MCP_DIR}' 2>/dev/null | grep -v node_modules | grep -v '.git/' | head -20`,
      { encoding: 'utf8', timeout: 5000 }
    );
    return result.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Classify a search term as specific or generic.
 * Specific terms are pattern-unique identifiers (filenames, tool names, technical identifiers).
 * Generic terms are broad technology words that many patterns could match.
 */
const GENERIC_TERMS = new Set([
  'mcp', 'MCP', 'sdk', 'SDK', 'claude', 'anthropic', 'agent', 'hook',
  'transport', 'proxy', 'session', 'state', 'config', 'server', 'client',
  'api', 'json', 'node', 'test', 'error', 'retry', 'queue', 'log',
  'subagent', 'oauth', 'OAuth',
]);

function isSpecificTerm(term) {
  // Filenames (contains dot extension) are always specific
  if (/\.\w{1,4}$/.test(term)) return true;
  // Snake_case identifiers (tool names) are specific
  if (/^[a-z]+_[a-z_]+$/.test(term)) return true;
  // CamelCase identifiers are specific
  if (/^[A-Z][a-z]+[A-Z]/.test(term)) return true;
  // Multi-word hyphenated identifiers are specific
  if (/^[a-z]+-[a-z]+-/.test(term)) return true;
  // Everything else: check against generic set
  return !GENERIC_TERMS.has(term) && !GENERIC_TERMS.has(term.toLowerCase());
}

/**
 * Validate a single pattern against the current codebase.
 * Returns { valid: boolean, tier: string, evidence: string }
 *
 * Tier classification (wq-1029):
 *   - "strong": ≥2 specific terms matched in codebase
 *   - "weak": matches found but <2 specific terms (mostly generic)
 *   - "conceptual": no codebase evidence at all
 */
function validatePattern(pattern) {
  const terms = extractSearchTerms(pattern);

  if (terms.length === 0) {
    return { valid: true, tier: 'conceptual', evidence: 'conceptual pattern, no searchable terms' };
  }

  let matchedTerms = 0;
  let specificMatches = 0;
  let totalFiles = 0;
  const hits = [];

  for (const term of terms.slice(0, 8)) { // Cap at 8 terms to limit grep cost
    const count = grepFileCount(term);
    if (count > 0) {
      matchedTerms++;
      totalFiles += count;
      const specific = isSpecificTerm(term);
      if (specific) specificMatches++;
      hits.push(`${term}(${count}${specific ? '*' : ''})`);
    }
  }

  // Valid if ≥2 terms found OR ≥2 files reference any term
  const valid = matchedTerms >= 2 || totalFiles >= 2;

  // Tier classification
  let tier;
  if (!valid) {
    tier = 'conceptual';
  } else if (specificMatches >= 2) {
    tier = 'strong';
  } else {
    tier = 'weak';
  }

  const evidence = hits.length > 0
    ? `${matchedTerms}/${terms.length} terms matched (${specificMatches} specific): ${hits.slice(0, 5).join(', ')}`
    : `0/${terms.length} terms matched`;

  return { valid, tier, evidence };
}

// Exported for testing
export { extractSearchTerms, isSpecificTerm, validatePattern, getStalest, GENERIC_TERMS, TIER_WINDOWS };

/**
 * Run revalidation programmatically. Returns { checked, validated, skipped, results }.
 */
export function revalidatePatterns(count = 10) {
  const data = loadPatterns();
  const stale = getStalest(data.patterns, count);

  if (stale.length === 0) {
    return { checked: 0, validated: 0, skipped: 0, results: [] };
  }

  const results = [];
  const now = new Date().toISOString();

  for (const pattern of stale) {
    const { valid, tier, evidence } = validatePattern(pattern);
    const ageDays = Math.round((Date.now() - new Date(pattern.lastValidated || pattern.extractedAt).getTime()) / 86400000);

    if (valid) {
      pattern.lastValidated = now;
      pattern.revalidationTier = tier;
    }

    results.push({ id: pattern.id, title: pattern.title, ageDays, valid, tier, evidence });
  }

  const validated = results.filter(r => r.valid).length;
  if (validated > 0) {
    data.lastUpdated = now;
    writeFileSync(PATTERNS_FILE, JSON.stringify(data, null, 2));
  }

  return {
    checked: results.length,
    validated,
    skipped: results.filter(r => !r.valid).length,
    results,
  };
}

// ---- CLI Main ----

// Only run CLI when invoked directly (not imported)
const isMain = process.argv[1] && process.argv[1].endsWith('knowledge-revalidate.mjs');
if (!isMain) {
  // Module imported — skip CLI execution
} else {

const data = loadPatterns();
const stale = getStalest(data.patterns, batchSize);

if (stale.length === 0) {
  console.log('knowledge-revalidate: no stale patterns (all within 30-day window)');
  process.exit(0);
}

const results = [];
const now = new Date().toISOString();

for (const pattern of stale) {
  const { valid, tier, evidence } = validatePattern(pattern);
  const ageDays = Math.round((Date.now() - new Date(pattern.lastValidated || pattern.extractedAt).getTime()) / 86400000);

  if (valid && !dryRun) {
    pattern.lastValidated = now;
    pattern.revalidationTier = tier;
  }

  results.push({
    id: pattern.id,
    title: pattern.title,
    ageDays,
    valid,
    tier,
    evidence,
  });
}

const validated = results.filter(r => r.valid).length;
const skipped = results.filter(r => !r.valid).length;

if (validated > 0 && !dryRun) {
  data.lastUpdated = now;
  writeFileSync(PATTERNS_FILE, JSON.stringify(data, null, 2));
}

// Output summary
const mode = dryRun ? '[DRY RUN] ' : '';
console.log(`${mode}knowledge-revalidate: checked ${results.length}, validated ${validated}, skipped ${skipped}`);
for (const r of results) {
  const status = r.valid ? `PASS:${r.tier}` : 'SKIP';
  console.log(`  ${r.id} [${status}] ${r.title} (${r.ageDays}d stale) — ${r.evidence}`);
}

process.exit(0);
} // end CLI main

// Cross-platform thread deduplication (wq-145)
// Detects when the same topic appears on multiple platforms (4claw, Chatr, Moltbook, etc.)
// to avoid redundant engagement on the same discussion.
//
// Approach:
// 1. Content fingerprinting: normalized hash of title + first 200 chars of content
// 2. Key phrase extraction: extract significant 2-3 word phrases for semantic matching
// 3. Time-windowed cache: only match within 48h window (topics decay)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const STATE_DIR = join(process.env.HOME || '/home/moltbot', '.config/moltbook');
const DEDUP_CACHE_PATH = join(STATE_DIR, 'cross-platform-dedup.json');

// Cache TTL: 48 hours (topics older than this are unlikely to be duplicate discussions)
const CACHE_TTL_MS = 48 * 60 * 60 * 1000;

// Similarity threshold for key phrase matching (0-1, higher = stricter)
// 0.3 is intentionally low to catch loose topic matches across platforms
const PHRASE_MATCH_THRESHOLD = 0.3;

function loadCache() {
  try {
    if (!existsSync(DEDUP_CACHE_PATH)) return { entries: [], lastCleanup: Date.now() };
    return JSON.parse(readFileSync(DEDUP_CACHE_PATH, 'utf8'));
  } catch { return { entries: [], lastCleanup: Date.now() }; }
}

function saveCache(cache) {
  try {
    writeFileSync(DEDUP_CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
  } catch (e) {
    console.error('[cross-platform-dedup] Failed to save cache:', e.message);
  }
}

/**
 * Normalize text for comparison: lowercase, strip URLs, collapse whitespace.
 */
function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')  // strip URLs
    .replace(/[^a-z0-9 ]/g, ' ')      // keep only alphanumeric
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim();
}

/**
 * Create a content fingerprint (hash) from title + content.
 */
function fingerprint(title, content) {
  const norm = normalize(title) + ' ' + normalize(content).substring(0, 200);
  return createHash('sha256').update(norm).digest('hex').substring(0, 16);
}

/**
 * Extract key phrases (single words + 2-word ngrams) from text for semantic matching.
 * Filters out common stopwords and returns top N distinctive phrases.
 */
function extractKeyPhrases(text, maxPhrases = 15) {
  const stopwords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has',
    'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they',
    'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'each', 'every',
    'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
    'own', 'same', 'so', 'than', 'too', 'very', 'just', 'can', 'now', 'my', 'your', 'his',
    'her', 'our', 'their', 'about', 'if', 'then', 'also', 'any', 'here', 'there', 'up',
    'talking', 'discussion', 'thread', 'sharing', 'tips', 'best', 'practices'
  ]);

  const words = normalize(text).split(' ').filter(w => w.length > 3 && !stopwords.has(w));
  const phrases = new Map();

  // Add significant single words (longer words are more distinctive)
  for (const word of words) {
    if (word.length >= 5) {
      phrases.set(word, (phrases.get(word) || 0) + 2); // Weight single keywords higher
    }
  }

  // Generate bigrams
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = words[i] + ' ' + words[i + 1];
    phrases.set(bigram, (phrases.get(bigram) || 0) + 1);
  }

  // Sort by frequency and take top N
  return [...phrases.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxPhrases)
    .map(([phrase]) => phrase);
}

/**
 * Calculate Jaccard similarity between two phrase sets.
 */
function phraseSimilarity(phrases1, phrases2) {
  if (!phrases1.length || !phrases2.length) return 0;
  const set1 = new Set(phrases1);
  const set2 = new Set(phrases2);
  const intersection = [...set1].filter(p => set2.has(p)).length;
  const union = new Set([...set1, ...set2]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Check if a thread (title + content) is similar to recently engaged content
 * on other platforms.
 *
 * @param {string} platform - The platform this thread is from (e.g., '4claw', 'chatr', 'moltbook')
 * @param {string} title - Thread title
 * @param {string} content - Thread content
 * @param {string} threadId - Platform-specific thread ID
 * @returns {{ isDuplicate: boolean, match: object|null, similarity: number }}
 */
export function checkDuplicate(platform, title, content, threadId) {
  const cache = loadCache();
  const now = Date.now();

  // Clean old entries
  cache.entries = cache.entries.filter(e => now - e.ts < CACHE_TTL_MS);

  const fp = fingerprint(title, content);
  const phrases = extractKeyPhrases(title + ' ' + content);

  // Check for exact fingerprint match (different platform only)
  const exactMatch = cache.entries.find(e =>
    e.fp === fp && e.platform !== platform
  );
  if (exactMatch) {
    return {
      isDuplicate: true,
      match: exactMatch,
      similarity: 1.0,
      reason: 'exact_fingerprint'
    };
  }

  // Check for phrase similarity match (different platform only)
  let bestMatch = null;
  let bestSimilarity = 0;
  for (const entry of cache.entries) {
    if (entry.platform === platform) continue; // Skip same platform
    const sim = phraseSimilarity(phrases, entry.phrases || []);
    if (sim > bestSimilarity && sim >= PHRASE_MATCH_THRESHOLD) {
      bestSimilarity = sim;
      bestMatch = entry;
    }
  }

  if (bestMatch) {
    return {
      isDuplicate: true,
      match: bestMatch,
      similarity: bestSimilarity,
      reason: 'phrase_similarity'
    };
  }

  return { isDuplicate: false, match: null, similarity: 0 };
}

/**
 * Record that we engaged with a thread. Adds it to the dedup cache.
 *
 * @param {string} platform - Platform name
 * @param {string} title - Thread title
 * @param {string} content - Thread content (first 500 chars)
 * @param {string} threadId - Platform-specific thread ID
 * @param {string} action - What we did ('reply', 'comment', 'post')
 */
export function recordEngagement(platform, title, content, threadId, action = 'engaged') {
  const cache = loadCache();
  const now = Date.now();

  // Clean old entries
  cache.entries = cache.entries.filter(e => now - e.ts < CACHE_TTL_MS);

  const fp = fingerprint(title, content);
  const phrases = extractKeyPhrases(title + ' ' + content);

  // Check if we already have this exact entry (by threadId + platform)
  const existing = cache.entries.findIndex(e =>
    e.platform === platform && e.threadId === threadId
  );

  if (existing >= 0) {
    // Update timestamp and action
    cache.entries[existing].ts = now;
    cache.entries[existing].action = action;
  } else {
    // Add new entry
    cache.entries.push({
      platform,
      threadId,
      title: (title || '').substring(0, 100),
      fp,
      phrases,
      action,
      ts: now
    });

    // Cap at 200 entries
    if (cache.entries.length > 200) {
      cache.entries = cache.entries.slice(-200);
    }
  }

  cache.lastCleanup = now;
  saveCache(cache);
}

/**
 * Get cache stats for debugging/monitoring.
 */
export function getCacheStats() {
  const cache = loadCache();
  const now = Date.now();
  const fresh = cache.entries.filter(e => now - e.ts < CACHE_TTL_MS);

  const byPlatform = {};
  for (const entry of fresh) {
    byPlatform[entry.platform] = (byPlatform[entry.platform] || 0) + 1;
  }

  return {
    totalEntries: cache.entries.length,
    freshEntries: fresh.length,
    byPlatform,
    oldestEntry: fresh.length > 0 ? Math.round((now - Math.min(...fresh.map(e => e.ts))) / 3600000) + 'h ago' : null,
    newestEntry: fresh.length > 0 ? Math.round((now - Math.max(...fresh.map(e => e.ts))) / 60000) + 'm ago' : null
  };
}

/**
 * Clear the dedup cache (for testing or reset).
 */
export function clearCache() {
  saveCache({ entries: [], lastCleanup: Date.now() });
}

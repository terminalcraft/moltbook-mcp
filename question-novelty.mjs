#!/usr/bin/env node
/**
 * question-novelty.mjs — Measures creative continuity in follow_ups.
 *
 * Do you return to familiar problems with NEW questions or repeat the same ones?
 * Novel framings indicate generativity; repeated patterns indicate cached thinking.
 *
 * Usage:
 *   node question-novelty.mjs --analyze                    # Analyze all historical follow_ups
 *   node question-novelty.mjs --score "<follow_up_text>"   # Score a single follow_up
 *   node question-novelty.mjs --enhance                    # Enhance current session's follow_ups with novelty scores
 *   node question-novelty.mjs --report                     # Show novelty trends over time
 *
 * Output:
 *   novelty_score: 0-100 (100 = completely novel framing, 0 = exact repeat)
 *   topic_key: normalized topic identifier for tracking across sessions
 *
 * Source: wq-268 (creative continuity test from engagement intel s1013)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACE_FILE = join(homedir(), '.config/moltbook/engagement-trace.json');
const NOVELTY_CACHE = join(homedir(), '.config/moltbook/novelty-cache.json');

/**
 * Extract a normalized topic key from follow_up text.
 * Groups related issues under the same key.
 */
function extractTopicKey(text) {
  const normalized = text.toLowerCase().trim();

  // Platform-specific patterns
  const platformPatterns = [
    { pattern: /chatr/i, key: 'chatr' },
    { pattern: /lobchan/i, key: 'lobchan' },
    { pattern: /lobstack/i, key: 'lobstack' },
    { pattern: /colony|thecolony/i, key: 'colony' },
    { pattern: /moltbook/i, key: 'moltbook' },
    { pattern: /4claw/i, key: '4claw' },
    { pattern: /pinchwork/i, key: 'pinchwork' },
    { pattern: /openwork/i, key: 'openwork' },
    { pattern: /molthunt/i, key: 'molthunt' },
    { pattern: /glyph/i, key: 'glyph' },
    { pattern: /hivemind/i, key: 'hivemind' },
    { pattern: /aicq/i, key: 'aicq' },
  ];

  // Issue-type patterns
  const issuePatterns = [
    { pattern: /api.*(error|fail|broken|404|empty|html)/i, key: 'api-error' },
    { pattern: /(dns|domain).*(fail|down|dead)/i, key: 'dns-issue' },
    { pattern: /jwt|token|auth|credential/i, key: 'auth-issue' },
    { pattern: /endpoint.*(unknown|missing|changed)/i, key: 'endpoint-discovery' },
    { pattern: /write.*api|api.*write/i, key: 'write-api' },
    { pattern: /read.*api|api.*read/i, key: 'read-api' },
    { pattern: /check.*(reply|response)/i, key: 'check-response' },
    { pattern: /monitor|worth.*monitoring/i, key: 'monitoring' },
    { pattern: /evaluate|evaluation/i, key: 'evaluation' },
    { pattern: /mechanic|protocol/i, key: 'mechanics' },
  ];

  // Find platform
  let platform = 'general';
  for (const { pattern, key } of platformPatterns) {
    if (pattern.test(normalized)) {
      platform = key;
      break;
    }
  }

  // Find issue type
  let issueType = 'other';
  for (const { pattern, key } of issuePatterns) {
    if (pattern.test(normalized)) {
      issueType = key;
      break;
    }
  }

  // Agent-specific follow-ups
  const agentMatch = normalized.match(/@(\w+)/);
  if (agentMatch) {
    return `agent:${agentMatch[1]}:${issueType}`;
  }

  return `${platform}:${issueType}`;
}

/**
 * Extract key phrases from text for similarity comparison.
 */
function extractPhrases(text) {
  const normalized = text.toLowerCase();
  // Remove common words, keep meaningful terms
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'why',
    'how', 'what', 'which', 'who', 'whom', 'this', 'that', 'these',
    'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
    'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
    'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'about',
    'still', 'just', 'next', 'session', 'check', 'verify', 'needs',
  ]);

  const words = normalized
    .replace(/[^a-z0-9@\-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  return new Set(words);
}

/**
 * Compute similarity between two follow_up texts.
 * Returns 0-1 (0 = no similarity, 1 = identical).
 */
function computeSimilarity(text1, text2) {
  const phrases1 = extractPhrases(text1);
  const phrases2 = extractPhrases(text2);

  if (phrases1.size === 0 || phrases2.size === 0) return 0;

  const intersection = new Set([...phrases1].filter(x => phrases2.has(x)));
  const union = new Set([...phrases1, ...phrases2]);

  return intersection.size / union.size; // Jaccard similarity
}

/**
 * Load historical follow_ups from engagement-trace.json.
 */
function loadHistory() {
  if (!existsSync(TRACE_FILE)) return [];
  try {
    const traces = JSON.parse(readFileSync(TRACE_FILE, 'utf8'));
    const history = [];
    for (const trace of traces) {
      if (trace.follow_ups && Array.isArray(trace.follow_ups)) {
        for (const fu of trace.follow_ups) {
          const text = typeof fu === 'string' ? fu : fu.text;
          if (text) {
            history.push({
              session: trace.session,
              text,
              topic_key: extractTopicKey(text),
              date: trace.date,
            });
          }
        }
      }
    }
    return history;
  } catch {
    return [];
  }
}

/**
 * Score a follow_up's novelty against history.
 * Higher score = more novel framing.
 */
function scoreNovelty(text, history, currentSession = null) {
  const topicKey = extractTopicKey(text);

  // Filter to same topic_key entries (excluding current session)
  const sameTopicHistory = history.filter(h =>
    h.topic_key === topicKey &&
    (currentSession === null || h.session !== currentSession)
  );

  if (sameTopicHistory.length === 0) {
    // Completely new topic - max novelty
    return { score: 100, reason: 'new_topic', topic_key: topicKey };
  }

  // Find maximum similarity to any historical entry
  let maxSimilarity = 0;
  let mostSimilar = null;

  for (const h of sameTopicHistory) {
    const sim = computeSimilarity(text, h.text);
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      mostSimilar = h;
    }
  }

  // Convert similarity to novelty (inverse relationship)
  // 0 similarity = 100 novelty, 1 similarity = 0 novelty
  // Use exponential decay: novel framings should score high even with some overlap
  const noveltyScore = Math.round(100 * Math.pow(1 - maxSimilarity, 0.5));

  let reason;
  if (maxSimilarity > 0.8) {
    reason = 'near_repeat';
  } else if (maxSimilarity > 0.5) {
    reason = 'partial_overlap';
  } else if (maxSimilarity > 0.2) {
    reason = 'same_topic_new_angle';
  } else {
    reason = 'novel_framing';
  }

  return {
    score: noveltyScore,
    reason,
    topic_key: topicKey,
    max_similarity: Math.round(maxSimilarity * 100),
    similar_to: mostSimilar ? { session: mostSimilar.session, text: mostSimilar.text } : null,
    topic_appearances: sameTopicHistory.length,
  };
}

/**
 * Analyze all historical follow_ups and show patterns.
 */
function analyzeHistory() {
  const history = loadHistory();

  if (history.length === 0) {
    console.log('No follow_up history found.');
    return;
  }

  // Group by topic_key
  const byTopic = {};
  for (const h of history) {
    if (!byTopic[h.topic_key]) byTopic[h.topic_key] = [];
    byTopic[h.topic_key].push(h);
  }

  // Sort topics by frequency (descending)
  const topics = Object.entries(byTopic)
    .map(([key, entries]) => ({ key, count: entries.length, entries }))
    .sort((a, b) => b.count - a.count);

  console.log('=== FOLLOW_UP TOPIC ANALYSIS ===\n');
  console.log(`Total follow_ups: ${history.length}`);
  console.log(`Unique topics: ${topics.length}\n`);

  console.log('Top recurring topics:\n');
  for (const { key, count, entries } of topics.slice(0, 15)) {
    console.log(`  ${key}: ${count}x`);
    // Show sample entries
    const samples = entries.slice(-2);
    for (const s of samples) {
      console.log(`    s${s.session}: "${s.text.slice(0, 60)}..."`);
    }
  }

  // Compute overall novelty trend
  console.log('\n=== NOVELTY TREND (last 20 follow_ups) ===\n');
  const recent = history.slice(-20);
  let totalNovelty = 0;
  for (let i = 0; i < recent.length; i++) {
    const h = recent[i];
    const priorHistory = history.slice(0, history.indexOf(h));
    const result = scoreNovelty(h.text, priorHistory);
    totalNovelty += result.score;
    const indicator = result.score >= 70 ? '🌱' : result.score >= 40 ? '↻' : '🔁';
    console.log(`  ${indicator} s${h.session} [${result.score}] ${result.topic_key}: "${h.text.slice(0, 50)}..."`);
  }

  const avgNovelty = Math.round(totalNovelty / recent.length);
  console.log(`\nAverage novelty (last 20): ${avgNovelty}/100`);
  if (avgNovelty >= 60) {
    console.log('Interpretation: Good creative continuity — approaching problems with fresh perspectives');
  } else if (avgNovelty >= 40) {
    console.log('Interpretation: Moderate — some cached patterns, some novel framings');
  } else {
    console.log('Interpretation: Low — consider reframing recurring issues or closing resolved ones');
  }
}

/**
 * Show novelty report with trends over time.
 */
function showReport() {
  const history = loadHistory();

  if (history.length < 10) {
    console.log('Insufficient history for trend analysis (need 10+ follow_ups).');
    return;
  }

  // Bucket by session windows
  const windowSize = 5;
  const windows = [];

  for (let i = 0; i < history.length; i += windowSize) {
    const window = history.slice(i, i + windowSize);
    if (window.length < 3) continue;

    let totalNovelty = 0;
    for (const h of window) {
      const priorHistory = history.slice(0, history.indexOf(h));
      const result = scoreNovelty(h.text, priorHistory);
      totalNovelty += result.score;
    }

    windows.push({
      sessions: `${window[0].session}-${window[window.length - 1].session}`,
      avgNovelty: Math.round(totalNovelty / window.length),
      count: window.length,
    });
  }

  console.log('=== NOVELTY TREND REPORT ===\n');
  console.log('Session Range'.padEnd(20) + 'Avg Novelty'.padEnd(15) + 'Trend');
  console.log('-'.repeat(50));

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    let trend = '—';
    if (i > 0) {
      const diff = w.avgNovelty - windows[i - 1].avgNovelty;
      trend = diff > 5 ? '📈' : diff < -5 ? '📉' : '→';
    }
    const bar = '█'.repeat(Math.floor(w.avgNovelty / 10)) + '░'.repeat(10 - Math.floor(w.avgNovelty / 10));
    console.log(`${w.sessions.padEnd(20)}${w.avgNovelty.toString().padEnd(5)}${bar}  ${trend}`);
  }

  // Overall assessment
  const recentWindows = windows.slice(-3);
  const recentAvg = recentWindows.reduce((a, w) => a + w.avgNovelty, 0) / recentWindows.length;
  const olderWindows = windows.slice(-6, -3);
  const olderAvg = olderWindows.length > 0
    ? olderWindows.reduce((a, w) => a + w.avgNovelty, 0) / olderWindows.length
    : recentAvg;

  console.log('\n' + '-'.repeat(50));
  console.log(`Recent avg (last 3 windows): ${Math.round(recentAvg)}`);
  console.log(`Prior avg: ${Math.round(olderAvg)}`);
  console.log(`Trend: ${recentAvg > olderAvg + 5 ? 'Improving 📈' : recentAvg < olderAvg - 5 ? 'Declining 📉' : 'Stable →'}`);
}

// --- CLI ---

const args = process.argv.slice(2);

if (args.includes('--analyze')) {
  analyzeHistory();
} else if (args.includes('--score')) {
  const idx = args.indexOf('--score');
  const text = args[idx + 1];
  if (!text) {
    console.error('Usage: --score "<follow_up_text>"');
    process.exit(1);
  }
  const history = loadHistory();
  const result = scoreNovelty(text, history);
  console.log(JSON.stringify(result, null, 2));
} else if (args.includes('--report')) {
  showReport();
} else if (args.includes('--enhance')) {
  // Enhance current session's follow_ups (placeholder - actual enhancement happens in SESSION_ENGAGE)
  console.log('Use this in E sessions: after writing follow_ups, call --score for each to get novelty metrics.');
  console.log('Include results in the enhanced follow_up format.');
} else {
  console.log(`question-novelty.mjs — Creative continuity tracker for follow_ups

Usage:
  --analyze            Analyze all historical follow_ups, show recurring topics
  --score "<text>"     Score a single follow_up's novelty (JSON output)
  --report             Show novelty trends over time
  --enhance            Instructions for enhancing follow_ups with novelty data

Scoring:
  100 = Completely novel topic
  70+ = Novel framing of familiar topic
  40-70 = Partial overlap with history
  <40 = Near-repeat of previous follow_up

Source: wq-268 (creative continuity test)`);
}

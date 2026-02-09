/**
 * Engagement Quality Scorer (wq-474)
 *
 * Scores engagement trace entries on 3 axes inspired by MDI's collective
 * quality feedback system:
 *   - signal:  Is this informative/substantive? (vs noise/filler)
 *   - novelty: Is this a new topic/angle? (vs repetition)
 *   - anchor:  Does this connect to something concrete? (vs floating opinion)
 *
 * Each axis scores 0.0-1.0. Combined score = weighted average.
 * Designed for consumption by E sessions (self-assessment) and A sessions (audit).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Score a single thread contribution from an engagement trace.
 *
 * @param {Object} thread - Thread contribution object from trace
 * @param {string} thread.action - "post" | "reply" | "read" | "vote" | "trade"
 * @param {string} thread.topic - Topic description
 * @param {string} thread.platform - Platform name
 * @param {Object} context - Scoring context
 * @param {string[]} context.recentTopics - Topics from recent sessions (for novelty)
 * @param {string[]} context.followUps - Follow-up items generated from this session
 * @returns {Object} Scored entry with signal, novelty, anchor scores
 */
export function scoreThread(thread, context = {}) {
  const topic = (thread.topic || '').toLowerCase();
  const action = (thread.action || '').toLowerCase();
  const recentTopics = (context.recentTopics || []).map(t => t.toLowerCase());
  const followUps = (context.followUps || []).map(f => f.toLowerCase());

  // --- Signal score: is this substantive? ---
  let signal = 0.5; // baseline
  // Actions that produce content score higher than passive ones
  const actionWeights = { post: 0.3, reply: 0.2, trade: 0.15, vote: 0.05, read: 0 };
  signal += actionWeights[action] || 0;
  // Longer, more specific topics indicate more substance
  if (topic.length > 80) signal += 0.1;
  if (topic.length > 40) signal += 0.05;
  // Topics with concrete nouns (data, numbers, specific platforms) score higher
  if (/\d+/.test(topic)) signal += 0.05; // contains numbers = specific
  if (/\b(data|metric|score|rate|count|pattern|protocol|api|tool)\b/.test(topic)) signal += 0.05;

  // --- Novelty score: is this a new angle? ---
  let novelty = 0.8; // assume novel by default
  // Check if similar topics appeared recently
  for (const recent of recentTopics) {
    const similarity = computeOverlap(topic, recent);
    if (similarity > 0.6) {
      novelty -= 0.4; // high overlap = low novelty
      break;
    } else if (similarity > 0.3) {
      novelty -= 0.2; // moderate overlap
    }
  }

  // --- Anchor score: does this connect to something concrete? ---
  let anchor = 0.3; // baseline
  // References to specific agents, tools, or platforms indicate anchoring
  if (/@\w+/.test(thread.topic || '')) anchor += 0.15; // mentions specific agent
  if (/wq-\d+|#\d+/.test(thread.topic || '')) anchor += 0.2; // references work items
  if (thread.thread_id) anchor += 0.1; // tied to a specific thread
  // Generated follow-ups anchored to this topic indicate downstream value
  const topicWords = extractKeywords(topic);
  const followUpAnchored = followUps.some(f =>
    topicWords.some(w => w.length > 4 && f.includes(w))
  );
  if (followUpAnchored) anchor += 0.2;

  return {
    ...thread,
    scores: {
      signal: clamp(signal),
      novelty: clamp(novelty),
      anchor: clamp(anchor),
      combined: clamp((signal * 0.4 + novelty * 0.3 + anchor * 0.3))
    }
  };
}

/**
 * Score an entire engagement trace session.
 *
 * @param {Object} trace - Single session trace object
 * @param {Object[]} recentTraces - Previous session traces (for novelty comparison)
 * @returns {Object} Trace with added quality_scores field
 */
export function scoreTrace(trace, recentTraces = []) {
  if (!trace || !trace.threads_contributed) {
    return { ...trace, quality_scores: { threads: [], session_score: 0 } };
  }

  // Collect recent topics for novelty comparison
  const recentTopics = recentTraces.flatMap(t =>
    (t.topics || []).concat(
      (t.threads_contributed || []).map(th => th.topic || '')
    )
  );

  const context = {
    recentTopics,
    followUps: trace.follow_ups || []
  };

  const scoredThreads = trace.threads_contributed.map(t => scoreThread(t, context));

  // Session-level score: weighted by thread count and action diversity
  const threadScores = scoredThreads.map(t => t.scores.combined);
  const avgScore = threadScores.length > 0
    ? threadScores.reduce((a, b) => a + b, 0) / threadScores.length
    : 0;

  // Bonus for action diversity (posts + replies + trades > just reads)
  const actions = new Set(trace.threads_contributed.map(t => t.action));
  const diversityBonus = Math.min(0.1, (actions.size - 1) * 0.05);

  // Bonus for multi-platform engagement
  const platforms = new Set(trace.threads_contributed.map(t => t.platform));
  const platformBonus = Math.min(0.1, (platforms.size - 1) * 0.05);

  return {
    ...trace,
    quality_scores: {
      threads: scoredThreads.map(t => ({
        topic: t.topic?.slice(0, 80),
        action: t.action,
        ...t.scores
      })),
      session_score: clamp(avgScore + diversityBonus + platformBonus),
      action_diversity: actions.size,
      platform_diversity: platforms.size
    }
  };
}

/**
 * Score all traces in the engagement-trace.json file and write results.
 *
 * @param {string} configDir - Path to ~/.config/moltbook
 * @returns {Object} Summary of scored sessions
 */
export function scoreAllTraces(configDir) {
  const tracePath = join(configDir, 'engagement-trace.json');
  const scoresPath = join(configDir, 'engagement-scores.json');

  if (!existsSync(tracePath)) {
    return { error: 'No engagement-trace.json found', sessions: 0 };
  }

  let traces;
  try {
    const raw = JSON.parse(readFileSync(tracePath, 'utf8'));
    traces = Array.isArray(raw) ? raw : [raw];
  } catch {
    return { error: 'Failed to parse engagement-trace.json', sessions: 0 };
  }

  // Score each trace with context from prior sessions
  const scored = traces.map((trace, i) => {
    const priorTraces = traces.slice(Math.max(0, i - 5), i);
    return scoreTrace(trace, priorTraces);
  });

  // Write scored results
  const output = {
    version: 1,
    scored_at: new Date().toISOString(),
    sessions: scored.map(s => ({
      session: s.session,
      date: s.date,
      quality_scores: s.quality_scores
    }))
  };

  writeFileSync(scoresPath, JSON.stringify(output, null, 2));

  // Summary
  const sessionScores = scored.map(s => s.quality_scores.session_score);
  return {
    sessions: scored.length,
    avg_score: sessionScores.length > 0
      ? Math.round(sessionScores.reduce((a, b) => a + b, 0) / sessionScores.length * 100) / 100
      : 0,
    latest_score: sessionScores.length > 0 ? sessionScores[sessionScores.length - 1] : 0,
    output_path: scoresPath
  };
}

// --- Helpers ---

function clamp(v) {
  return Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
}

function extractKeywords(text) {
  return text.split(/\s+/).filter(w => w.length > 3);
}

/**
 * Compute word overlap ratio between two strings.
 * Returns 0-1 where 1 = identical word sets.
 */
function computeOverlap(a, b) {
  const wordsA = new Set(extractKeywords(a));
  const wordsB = new Set(extractKeywords(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

#!/usr/bin/env node
/**
 * conversation-balance.mjs — Check engagement ratio to avoid conversation dominance (d041).
 *
 * Usage:
 *   node conversation-balance.mjs                    # Show current session stats
 *   node conversation-balance.mjs --chatr            # Check Chatr room ratio
 *   node conversation-balance.mjs --thread <id>     # Check specific thread dominance
 *   node conversation-balance.mjs --session <n>     # Check specific session's balance
 *   node conversation-balance.mjs --history         # Show balance trend across recent sessions
 *
 * The 30% rule (d041): If your messages exceed 30% of a conversation/room, you're crowding
 * out others rather than engaging with them. This tool helps detect and prevent dominance.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.config/moltbook');
const TRACE_PATH = join(STATE_DIR, 'engagement-trace.json');
const CHATR_SNAP_DIR = join(STATE_DIR, 'chatr-snapshots');

const DOMINANCE_THRESHOLD = 0.30; // 30% threshold from d041
const MY_HANDLES = ['@moltbook', 'moltbook', '@terminalcraft', 'terminalcraft'];

function loadTrace() {
  if (!existsSync(TRACE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(TRACE_PATH, 'utf8'));
  } catch { return []; }
}

function loadChatrSnapshots(maxSnaps = 5) {
  if (!existsSync(CHATR_SNAP_DIR)) return [];
  try {
    const files = readdirSync(CHATR_SNAP_DIR)
      .filter(f => f.startsWith('digest-') && f.endsWith('.json'))
      .sort()
      .slice(-maxSnaps);
    return files.map(f => {
      try {
        return JSON.parse(readFileSync(join(CHATR_SNAP_DIR, f), 'utf8'));
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function isMyHandle(handle) {
  const lower = (handle || '').toLowerCase().replace(/^@/, '');
  return MY_HANDLES.some(h => h.toLowerCase().replace(/^@/, '') === lower);
}

/**
 * Calculate balance metrics for a single session trace
 */
function sessionBalance(trace) {
  const threads = trace.threads_contributed || [];
  const platforms = [...new Set(threads.map(t => t.platform))];
  const agents = trace.agents_interacted || [];

  // Ratio: my posts / total participants I interacted with
  // A balanced session has many agents interacted and moderate posts
  const myPosts = threads.length;
  const otherAgents = agents.length;

  // Simple heuristic: if posts > 2 * agents, I'm posting too much relative to engagement
  const postToAgentRatio = otherAgents > 0 ? myPosts / otherAgents : myPosts;

  // Per-platform breakdown
  const platformCounts = {};
  for (const t of threads) {
    platformCounts[t.platform] = (platformCounts[t.platform] || 0) + 1;
  }

  return {
    session: trace.session,
    date: trace.date,
    total_posts: myPosts,
    agents_interacted: otherAgents,
    post_to_agent_ratio: Math.round(postToAgentRatio * 100) / 100,
    platforms: platformCounts,
    balanced: postToAgentRatio <= 2.0, // Heuristic: <=2 posts per agent is reasonable
    warning: postToAgentRatio > 3.0 ? 'HIGH_DOMINANCE' : (postToAgentRatio > 2.0 ? 'MODERATE' : null)
  };
}

/**
 * Check Chatr room balance from snapshots
 */
async function chatrBalance() {
  const snapshots = await loadChatrSnapshots();
  if (!snapshots.length) {
    return { error: 'No Chatr snapshots found', ratio: null };
  }

  // Aggregate all messages
  const msgCounts = {};
  const seen = new Set();
  let total = 0;
  let myCount = 0;

  for (const snap of snapshots) {
    for (const msg of (snap.messages || [])) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      total++;
      const agent = msg.agent || 'unknown';
      msgCounts[agent] = (msgCounts[agent] || 0) + 1;
      if (isMyHandle(agent)) {
        myCount++;
      }
    }
  }

  const ratio = total > 0 ? myCount / total : 0;
  const isBalanced = ratio <= DOMINANCE_THRESHOLD;

  return {
    my_messages: myCount,
    total_messages: total,
    ratio: Math.round(ratio * 100) / 100,
    percent: Math.round(ratio * 100),
    threshold: DOMINANCE_THRESHOLD * 100,
    balanced: isBalanced,
    recommendation: isBalanced
      ? 'Balanced — proceed with engagement'
      : `DOMINANCE WARNING: ${Math.round(ratio * 100)}% of messages are yours. Per d041: read more, post less. Let others respond before jumping in again.`,
    top_participants: Object.entries(msgCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([agent, count]) => ({ agent, count, percent: Math.round(count / total * 100) }))
  };
}

/**
 * Show balance trend across recent sessions
 */
function balanceHistory(sessions = 10) {
  const traces = loadTrace();
  const recent = traces.slice(-sessions);

  const results = recent.map(t => sessionBalance(t));
  const avgRatio = results.length > 0
    ? results.reduce((sum, r) => sum + r.post_to_agent_ratio, 0) / results.length
    : 0;

  const dominant = results.filter(r => r.warning === 'HIGH_DOMINANCE').length;
  const moderate = results.filter(r => r.warning === 'MODERATE').length;
  const balanced = results.filter(r => !r.warning).length;

  return {
    sessions_analyzed: results.length,
    avg_post_to_agent_ratio: Math.round(avgRatio * 100) / 100,
    breakdown: {
      balanced: balanced,
      moderate_dominance: moderate,
      high_dominance: dominant
    },
    trend: dominant > balanced ? 'worsening' : (balanced > dominant + moderate ? 'healthy' : 'moderate'),
    recent_sessions: results.reverse() // Most recent first
  };
}

/**
 * Pre-engagement check: should I post right now?
 */
function shouldPost(platform, threadId = null) {
  const traces = loadTrace();
  const currentSession = parseInt(process.env.SESSION_NUM || '0');

  // Find current session trace if it exists
  const current = traces.find(t => t.session === currentSession);
  if (!current) {
    // No trace yet — this is our first post, go ahead
    return { proceed: true, reason: 'First engagement of session' };
  }

  // Check platform-specific count this session
  const platformPosts = (current.threads_contributed || [])
    .filter(t => t.platform === platform).length;

  // Warn if we've already posted 3+ times to this platform in one session
  if (platformPosts >= 3) {
    return {
      proceed: false,
      reason: `Already ${platformPosts} posts to ${platform} this session. Per d041: diversify platforms or read more before posting.`,
      suggestion: 'Consider engaging on a different platform or waiting for responses.'
    };
  }

  // Check agents interacted vs posts ratio
  const agents = (current.agents_interacted || []).length;
  const posts = (current.threads_contributed || []).length;
  if (posts > 0 && agents > 0 && posts / agents > 2.5) {
    return {
      proceed: true, // Proceed but warn
      warning: `Post/agent ratio is ${Math.round(posts / agents * 10) / 10}. Consider reading and responding to others rather than new threads.`,
      reason: 'Balance warning — high output relative to interaction'
    };
  }

  return { proceed: true, reason: 'Balance check passed' };
}

// --- CLI ---
const args = process.argv.slice(2);

if (args.includes('--chatr')) {
  chatrBalance().then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.balanced) {
      console.error('\n⚠️  ' + result.recommendation);
      process.exit(1);
    }
  });
} else if (args.includes('--history')) {
  const count = parseInt(args[args.indexOf('--history') + 1]) || 10;
  console.log(JSON.stringify(balanceHistory(count), null, 2));
} else if (args.includes('--session')) {
  const sessionNum = parseInt(args[args.indexOf('--session') + 1]);
  const traces = loadTrace();
  const trace = traces.find(t => t.session === sessionNum);
  if (trace) {
    console.log(JSON.stringify(sessionBalance(trace), null, 2));
  } else {
    console.log(JSON.stringify({ error: `No trace for session ${sessionNum}` }));
    process.exit(1);
  }
} else if (args.includes('--check')) {
  const platform = args[args.indexOf('--check') + 1] || 'unknown';
  console.log(JSON.stringify(shouldPost(platform), null, 2));
} else {
  // Default: show current session analysis + recent trend
  const history = balanceHistory(5);
  console.log('=== Conversation Balance Check (d041) ===\n');
  console.log(`Recent trend: ${history.trend}`);
  console.log(`Average post/agent ratio: ${history.avg_post_to_agent_ratio}`);
  console.log(`Breakdown: ${history.breakdown.balanced} balanced, ${history.breakdown.moderate_dominance} moderate, ${history.breakdown.high_dominance} high dominance\n`);

  if (history.trend === 'worsening') {
    console.log('⚠️  DOMINANCE WARNING: Recent sessions show conversation imbalance.');
    console.log('   Per d041: Read more, post less. Let others respond before jumping in again.');
    process.exit(1);
  }

  console.log('Recent sessions:');
  for (const s of history.recent_sessions.slice(0, 5)) {
    const status = s.warning ? `⚠️  ${s.warning}` : '✓';
    console.log(`  s${s.session}: ${s.total_posts} posts, ${s.agents_interacted} agents (ratio ${s.post_to_agent_ratio}) ${status}`);
  }
}

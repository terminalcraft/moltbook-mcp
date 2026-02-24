#!/usr/bin/env node
// chatr-topic-clusters.mjs — Topic clustering for Chatr engagement planning (wq-591)
// Analyzes Chatr thread history to identify topic clusters and engagement gaps.
// E sessions use this to target underserved topics instead of reacting to whatever is current.
//
// Usage:
//   node chatr-topic-clusters.mjs                 # Show topic clusters and recommendations
//   node chatr-topic-clusters.mjs --json          # Machine-readable output
//   node chatr-topic-clusters.mjs --hours 48      # Analyze threads from last N hours (default: 72)
//   node chatr-topic-clusters.mjs --min-threads 2 # Min threads per cluster (default: 2)

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || '/home/moltbot';
const CONFIG_DIR = path.join(HOME, '.config/moltbook');
const THREADS_PATH = path.join(CONFIG_DIR, 'chatr-threads.json');

const OUR_HANDLE = 'moltbook';

// --- Topic vocabulary: group related keywords into semantic clusters ---
const TOPIC_SYNONYMS = {
  'agent': ['agents', 'agent', 'autonomous', 'agentic'],
  'memory': ['memory', 'context', 'recall', 'remember', 'persistence', 'stateful'],
  'trust': ['trust', 'reputation', 'attestation', 'verify', 'identity'],
  'knowledge': ['knowledge', 'patterns', 'learning', 'exchange'],
  'build': ['build', 'ship', 'code', 'implement', 'deploy', 'feature'],
  'economy': ['economy', 'economic', 'market', 'marketplace', 'trade', 'value', 'cost'],
  'protocol': ['protocol', 'standard', 'spec', 'interop', 'compatibility'],
  'infra': ['infrastructure', 'server', 'hosting', 'vps', 'service', 'uptime'],
  'social': ['social', 'community', 'network', 'platform', 'engagement'],
  'security': ['security', 'safety', 'injection', 'attack', 'defense'],
};

const STOP_WORDS = new Set([
  'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but', 'in',
  'to', 'for', 'of', 'with', 'that', 'this', 'it', 'not', 'are', 'was',
  'be', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would',
  'can', 'could', 'should', 'may', 'might', 'just', 'also', 'very',
  'too', 'so', 'than', 'then', 'now', 'how', 'what', 'when', 'where',
  'who', 'why', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'only', 'own', 'same', 'from', 'into',
  'about', 'between', 'through', 'during', 'before', 'after', 'above',
  'below', 'again', 'once', 'here', 'there', 'your', 'youre', 'dont',
  'been', 'like', 'yeah', 'think', 'know', 'thats', 'really', 'thing',
]);

function loadJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return null; }
}

function normalizeWord(word) {
  word = word.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (word.length < 4 || STOP_WORDS.has(word)) return null;
  // Map to canonical form via synonyms
  for (const [canonical, synonyms] of Object.entries(TOPIC_SYNONYMS)) {
    if (synonyms.includes(word)) return canonical;
  }
  return word;
}

function extractTopicVector(topicWords) {
  const counts = {};
  for (const raw of topicWords) {
    const w = normalizeWord(raw);
    if (w) counts[w] = (counts[w] || 0) + 1;
  }
  return counts;
}

function cosineSimilarity(vecA, vecB) {
  const keysA = Object.keys(vecA);
  const keysB = Object.keys(vecB);
  if (keysA.length === 0 || keysB.length === 0) return 0;

  let dot = 0, magA = 0, magB = 0;
  const allKeys = new Set([...keysA, ...keysB]);
  for (const k of allKeys) {
    const a = vecA[k] || 0;
    const b = vecB[k] || 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Simple agglomerative clustering
function clusterThreads(threads, threshold = 0.15) {
  if (threads.length === 0) return [];

  // Build topic vectors for each thread
  const items = threads.map(t => ({
    thread: t,
    vector: extractTopicVector(t.topicWords || []),
  }));

  // Initialize: each thread in its own cluster
  let clusters = items.map((item, i) => ({
    id: i,
    threads: [item.thread],
    vector: { ...item.vector },
    engaged: item.thread.engaged,
  }));

  // Merge clusters iteratively
  let merged = true;
  while (merged) {
    merged = false;
    let bestSim = 0;
    let bestPair = null;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = cosineSimilarity(clusters[i].vector, clusters[j].vector);
        if (sim > bestSim) {
          bestSim = sim;
          bestPair = [i, j];
        }
      }
    }

    if (bestSim >= threshold && bestPair) {
      const [i, j] = bestPair;
      // Merge j into i
      clusters[i].threads.push(...clusters[j].threads);
      clusters[i].engaged = clusters[i].engaged || clusters[j].engaged;
      // Merge vectors (sum counts)
      for (const [k, v] of Object.entries(clusters[j].vector)) {
        clusters[i].vector[k] = (clusters[i].vector[k] || 0) + v;
      }
      clusters.splice(j, 1);
      merged = true;
    }
  }

  return clusters;
}

function labelCluster(cluster) {
  // Top 3 words by count as the cluster label
  const sorted = Object.entries(cluster.vector)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);
  return sorted.join(', ') || 'misc';
}

function analyze(opts = {}) {
  const state = loadJSON(THREADS_PATH);
  if (!state || !state.threads) {
    return { error: 'No Chatr thread state found. Run chatr-thread-tracker.mjs update first.', clusters: [] };
  }

  const maxAge = (opts.hours || 72) * 60 * 60 * 1000;
  const minThreads = opts.minThreads || 2;
  const now = Date.now();

  // Filter threads by age and minimum message count
  const threads = Object.values(state.threads).filter(t => {
    const age = now - new Date(t.lastActivity).getTime();
    return age <= maxAge && t.messageCount >= 2;
  });

  if (threads.length === 0) {
    return { error: null, clusters: [], threadCount: 0, message: 'No recent threads with 2+ messages.' };
  }

  const clusters = clusterThreads(threads);

  // Annotate clusters
  const annotated = clusters
    .filter(c => c.threads.length >= minThreads)
    .map(c => {
      const totalMessages = c.threads.reduce((s, t) => s + t.messageCount, 0);
      const participants = new Set();
      for (const t of c.threads) {
        for (const p of t.participants) participants.add(p);
      }
      const weEngaged = c.threads.some(t => t.engaged);
      const engagedCount = c.threads.filter(t => t.engaged).length;

      return {
        label: labelCluster(c),
        threadCount: c.threads.length,
        totalMessages,
        participantCount: participants.size,
        topParticipants: [...participants].slice(0, 5),
        engaged: weEngaged,
        engagedThreads: engagedCount,
        engagementGap: c.threads.length - engagedCount,
        topWords: Object.entries(c.vector).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, c]) => `${w}(${c})`),
        lastActivity: c.threads.reduce((latest, t) =>
          new Date(t.lastActivity) > new Date(latest) ? t.lastActivity : latest,
          c.threads[0].lastActivity
        ),
      };
    })
    .sort((a, b) => b.engagementGap - a.engagementGap || b.threadCount - a.threadCount);

  // Recommendations: clusters with high activity but low engagement from us
  const recommendations = annotated
    .filter(c => c.engagementGap > 0)
    .slice(0, 3)
    .map(c => ({
      topic: c.label,
      reason: c.engaged
        ? `${c.engagementGap} of ${c.threadCount} threads unengaged`
        : `${c.threadCount} threads, zero engagement from us`,
      participants: c.topParticipants.filter(p => p !== OUR_HANDLE).slice(0, 3),
    }));

  return {
    error: null,
    threadCount: threads.length,
    clusterCount: annotated.length,
    clusters: annotated,
    recommendations,
  };
}

// CLI
const args = process.argv.slice(2);
const jsonFlag = args.includes('--json');
const hoursArg = args.find(a => a.startsWith('--hours'));
const hours = hoursArg ? parseInt(args[args.indexOf(hoursArg) + 1] || hoursArg.split('=')[1], 10) : 72;
const minThreadsArg = args.find(a => a.startsWith('--min-threads'));
const minThreads = minThreadsArg ? parseInt(args[args.indexOf(minThreadsArg) + 1] || minThreadsArg.split('=')[1], 10) : 2;

const result = analyze({ hours, minThreads });

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if (jsonFlag) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Chatr Topic Clusters (last ${hours}h, ${result.threadCount} threads)`);
  console.log('─'.repeat(60));

  if (result.clusters.length === 0) {
    console.log('\nNo topic clusters found (try increasing --hours or reducing --min-threads).');
  } else {
    for (const c of result.clusters) {
      const engageTag = c.engaged ? (c.engagementGap > 0 ? ' [partial]' : ' [engaged]') : ' [UNENGAGED]';
      const age = timeSince(c.lastActivity);
      console.log(`\n  ${c.label}${engageTag}`);
      console.log(`    ${c.threadCount} threads, ${c.totalMessages} messages, ${c.participantCount} participants`);
      console.log(`    Top words: ${c.topWords.join(', ')}`);
      console.log(`    Last active: ${age}`);
    }
  }

  if (result.recommendations.length > 0) {
    console.log('\n─ Recommendations for next E session ─');
    for (const r of result.recommendations) {
      const who = r.participants.length > 0 ? ` (${r.participants.map(p => '@' + p).join(', ')})` : '';
      console.log(`  Target: "${r.topic}" — ${r.reason}${who}`);
    }
  } else {
    console.log('\nAll topic clusters engaged. Good coverage.');
  }
}

function timeSince(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
  return `${Math.round(ms / 86400000)}d ago`;
}

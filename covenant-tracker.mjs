#!/usr/bin/env node
// covenant-tracker.mjs — Track consistent mutual engagement patterns across sessions.
// wq-220: From engagement intel archive — "Consider adding covenant/commitment tracking
// to engagement state - who do I consistently engage with across sessions?"
//
// Tracks: agents we've replied to 3+ times, agents who've replied to us, mutual follow-ups.
// Use for prioritizing engagement in E sessions.
//
// Usage:
//   node covenant-tracker.mjs update   # Update covenants from engagement trace
//   node covenant-tracker.mjs list     # List all covenants (by strength)
//   node covenant-tracker.mjs suggest  # Suggest agents to prioritize in next E session
//   node covenant-tracker.mjs digest   # Compact summary for prompt injection

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const COVENANTS_PATH = join(STATE_DIR, 'covenants.json');
const TRACE_PATH = join(STATE_DIR, 'engagement-trace.json');
const INTEL_ARCHIVE_PATH = join(STATE_DIR, 'engagement-intel-archive.json');

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function loadCovenants() {
  const data = readJSON(COVENANTS_PATH);
  if (!data || !data.agents) {
    return {
      version: 1,
      description: "Covenant tracking for agent relationships",
      last_updated: null,
      agents: {}
    };
  }
  return data;
}

// Extract agent interactions from engagement trace
function extractInteractionsFromTrace() {
  const trace = readJSON(TRACE_PATH);
  if (!Array.isArray(trace)) return [];

  const interactions = [];
  for (const session of trace) {
    const sessionNum = session.session;
    const date = session.date;

    // agents_interacted is the list of agent handles from that session
    const agents = session.agents_interacted || [];

    // threads_contributed shows what we did
    const threads = session.threads_contributed || [];

    for (const agent of agents) {
      // Normalize handle (strip leading @)
      const handle = agent.replace(/^@/, '');

      // Count how many threads we contributed to (proxy for "replied to" that agent)
      // Note: trace doesn't directly map which thread involved which agent,
      // but sessions with specific agent interactions imply engagement
      interactions.push({
        session: sessionNum,
        date,
        agent: handle,
        threadCount: threads.length,
        platforms: session.platforms_engaged || []
      });
    }
  }

  return interactions;
}

// Extract any covenant signals from intel archive (mentions, replies, etc.)
function extractCovenantSignalsFromIntel() {
  const archive = readJSON(INTEL_ARCHIVE_PATH);
  if (!Array.isArray(archive)) return [];

  const signals = [];
  for (const entry of archive) {
    // Look for patterns that mention agent relationships
    if (entry.type === 'pattern' || entry.type === 'collaboration') {
      const summary = (entry.summary || '').toLowerCase();
      // Extract @mentions from summary
      const mentions = summary.match(/@[\w-]+/g) || [];
      for (const m of mentions) {
        signals.push({
          session: entry.session || entry.archived_session,
          agent: m.replace(/^@/, ''),
          type: 'intel_mention',
          context: entry.summary?.substring(0, 80)
        });
      }
    }
  }

  return signals;
}

// Build/update covenant data from interactions
function updateCovenants() {
  const covenants = loadCovenants();
  const interactions = extractInteractionsFromTrace();
  const intelSignals = extractCovenantSignalsFromIntel();

  // Process trace interactions
  for (const int of interactions) {
    const agent = int.agent;
    if (!covenants.agents[agent]) {
      covenants.agents[agent] = {
        first_seen: int.date,
        last_seen: int.date,
        sessions: [],
        platforms: [],
        reply_count: 0,
        mutual_threads: 0,
        intel_mentions: 0,
        covenant_strength: 'none' // none, weak, emerging, strong, mutual
      };
    }

    const a = covenants.agents[agent];

    // Update session tracking
    if (!a.sessions.includes(int.session)) {
      a.sessions.push(int.session);
      a.reply_count++;
    }

    // Update last_seen
    if (int.date > a.last_seen) {
      a.last_seen = int.date;
    }

    // Track platforms where we've engaged
    for (const p of int.platforms) {
      if (!a.platforms.includes(p)) {
        a.platforms.push(p);
      }
    }
  }

  // Process intel signals
  for (const sig of intelSignals) {
    const agent = sig.agent;
    if (!covenants.agents[agent]) {
      covenants.agents[agent] = {
        first_seen: null,
        last_seen: null,
        sessions: [],
        platforms: [],
        reply_count: 0,
        mutual_threads: 0,
        intel_mentions: 0,
        covenant_strength: 'none'
      };
    }
    covenants.agents[agent].intel_mentions++;
  }

  // Calculate covenant strength for each agent
  for (const [handle, data] of Object.entries(covenants.agents)) {
    const sessionCount = data.sessions.length;
    const intelMentions = data.intel_mentions || 0;

    // Strength tiers:
    // - none: <2 session interactions
    // - weak: 2 sessions
    // - emerging: 3 sessions OR 2 sessions + intel mentions
    // - strong: 4+ sessions OR 3 sessions + platform diversity
    // - mutual: 5+ sessions across 2+ platforms (indicates real relationship)

    let strength = 'none';
    if (sessionCount >= 5 && data.platforms.length >= 2) {
      strength = 'mutual';
    } else if (sessionCount >= 4 || (sessionCount >= 3 && data.platforms.length >= 2)) {
      strength = 'strong';
    } else if (sessionCount >= 3 || (sessionCount >= 2 && intelMentions > 0)) {
      strength = 'emerging';
    } else if (sessionCount >= 2) {
      strength = 'weak';
    }

    data.covenant_strength = strength;
  }

  covenants.last_updated = new Date().toISOString();
  writeJSON(COVENANTS_PATH, covenants);

  return covenants;
}

// List covenants sorted by strength
function listCovenants(minStrength = 'weak') {
  const covenants = loadCovenants();

  const strengthOrder = ['mutual', 'strong', 'emerging', 'weak', 'none'];
  const minIndex = strengthOrder.indexOf(minStrength);

  const agents = Object.entries(covenants.agents)
    .filter(([_, d]) => strengthOrder.indexOf(d.covenant_strength) <= minIndex)
    .sort((a, b) => {
      const idxA = strengthOrder.indexOf(a[1].covenant_strength);
      const idxB = strengthOrder.indexOf(b[1].covenant_strength);
      if (idxA !== idxB) return idxA - idxB;
      // Secondary sort by session count
      return b[1].sessions.length - a[1].sessions.length;
    });

  return agents;
}

// Suggest agents to prioritize in next E session
function suggestPriority() {
  const covenants = loadCovenants();

  // Get agents with emerging or stronger covenants
  const candidates = Object.entries(covenants.agents)
    .filter(([_, d]) => ['mutual', 'strong', 'emerging'].includes(d.covenant_strength))
    .sort((a, b) => {
      // Prioritize: mutual > strong > emerging, then by recency
      const strengthOrder = { mutual: 0, strong: 1, emerging: 2 };
      const sA = strengthOrder[a[1].covenant_strength] || 3;
      const sB = strengthOrder[b[1].covenant_strength] || 3;
      if (sA !== sB) return sA - sB;
      // More recent engagement = higher priority
      return (b[1].last_seen || '').localeCompare(a[1].last_seen || '');
    });

  return candidates.slice(0, 10);
}

// Compact digest for prompt injection
function getDigest() {
  const covenants = loadCovenants();
  const mutual = [];
  const strong = [];
  const emerging = [];

  for (const [handle, data] of Object.entries(covenants.agents)) {
    const entry = `@${handle} (${data.sessions.length}s, ${data.platforms.slice(0, 2).join('/')})`;
    switch (data.covenant_strength) {
      case 'mutual': mutual.push(entry); break;
      case 'strong': strong.push(entry); break;
      case 'emerging': emerging.push(entry); break;
    }
  }

  const lines = [];
  if (mutual.length) lines.push(`Mutual: ${mutual.join(', ')}`);
  if (strong.length) lines.push(`Strong: ${strong.slice(0, 5).join(', ')}${strong.length > 5 ? '...' : ''}`);
  if (emerging.length) lines.push(`Emerging: ${emerging.slice(0, 5).join(', ')}${emerging.length > 5 ? '...' : ''}`);

  if (lines.length === 0) {
    return 'No covenants established yet. Build relationships through consistent engagement.';
  }

  return lines.join('\n');
}

// CLI handling
const command = process.argv[2] || 'update';

switch (command) {
  case 'update': {
    const covenants = updateCovenants();
    const agentCount = Object.keys(covenants.agents).length;
    const strengthCounts = { mutual: 0, strong: 0, emerging: 0, weak: 0, none: 0 };
    for (const data of Object.values(covenants.agents)) {
      strengthCounts[data.covenant_strength]++;
    }
    console.log(`Updated ${agentCount} agents.`);
    console.log(`Covenants: ${strengthCounts.mutual} mutual, ${strengthCounts.strong} strong, ${strengthCounts.emerging} emerging, ${strengthCounts.weak} weak`);
    break;
  }

  case 'list': {
    const agents = listCovenants('weak');
    if (agents.length === 0) {
      console.log('No covenants found. Run with "update" first.');
    } else {
      console.log('Agent covenants (sorted by strength):');
      for (const [handle, data] of agents) {
        console.log(`  @${handle}: ${data.covenant_strength} (${data.sessions.length} sessions, platforms: ${data.platforms.join(', ')})`);
      }
    }
    break;
  }

  case 'suggest': {
    const suggestions = suggestPriority();
    if (suggestions.length === 0) {
      console.log('No agents to prioritize yet. Build relationships through consistent engagement.');
    } else {
      console.log('Priority agents for next E session:');
      for (const [handle, data] of suggestions) {
        console.log(`  @${handle} [${data.covenant_strength}] - last seen: ${data.last_seen}, platforms: ${data.platforms.join(', ')}`);
      }
    }
    break;
  }

  case 'digest': {
    console.log(getDigest());
    break;
  }

  default:
    console.log('Usage: node covenant-tracker.mjs [update|list|suggest|digest]');
}

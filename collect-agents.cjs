#!/usr/bin/env node
// collect-agents.cjs — Collect agents from Moltbook engagement state + Bluesky catalog
// Merges into unified agents-unified.json for cross-platform /agents endpoint

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_PATH = path.join(os.homedir(), '.config/moltbook/engagement-state.json');
const BSKY_PATH = path.join(__dirname, 'bsky-agents.json');
const GITHUB_MAP_PATH = path.join(__dirname, 'github-mappings.json');
const OUTPUT_PATH = path.join(__dirname, 'agents-unified.json');

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function collectMoltbookAgents(state) {
  const authors = {};
  for (const [postId, p] of Object.entries(state.seen || {})) {
    if (!p.author) continue;
    if (!authors[p.author]) {
      authors[p.author] = {
        handle: p.author,
        platform: 'moltbook',
        postCount: 0,
        submolts: new Set(),
        firstSeen: p.at,
        lastSeen: p.at,
      };
    }
    const a = authors[p.author];
    a.postCount++;
    if (p.sub) a.submolts.add(p.sub);
    if (p.at < a.firstSeen) a.firstSeen = p.at;
    if (p.at > a.lastSeen) a.lastSeen = p.at;
  }

  // Check which ones we've interacted with
  const commented = state.commented || {};
  const voted = state.voted || {};

  return Object.values(authors).map(a => ({
    id: `moltbook:${a.handle}`,
    handle: a.handle,
    displayName: a.handle,
    platform: 'moltbook',
    postCount: a.postCount,
    submolts: Array.from(a.submolts),
    firstSeen: a.firstSeen,
    lastSeen: a.lastSeen,
    profileUrl: `https://www.moltbook.com/user/${encodeURIComponent(a.handle)}`,
  }));
}

function collectBlueskyAgents(bskyData) {
  if (!Array.isArray(bskyData)) return [];
  return bskyData.map(a => ({
    id: `bsky:${a.handle}`,
    handle: a.handle,
    displayName: a.displayName || a.handle,
    platform: 'bluesky',
    did: a.did,
    score: a.score || 0,
    aiScore: a.aiScore || 0,
    signals: a.signals || [],
    followers: a.followers || 0,
    postCount: a.posts || 0,
    firstSeen: a.discoveredAt,
    lastSeen: a.discoveredAt,
    profileUrl: `https://bsky.app/profile/${a.handle}`,
  }));
}

function main() {
  const state = loadJSON(STATE_PATH);
  const bsky = loadJSON(BSKY_PATH);

  const moltbookAgents = state ? collectMoltbookAgents(state) : [];
  const blueskyAgents = bsky ? collectBlueskyAgents(bsky) : [];

  const allAgents = [...moltbookAgents, ...blueskyAgents];

  // Enrich with GitHub mappings
  const ghMap = loadJSON(GITHUB_MAP_PATH) || {};
  let enriched = 0;
  for (const agent of allAgents) {
    const mapping = ghMap[agent.handle];
    if (mapping) {
      if (mapping.github) agent.github = mapping.github;
      if (mapping.repos) agent.repos = mapping.repos;
      enriched++;
    }
  }

  const unified = {
    generatedAt: new Date().toISOString(),
    platforms: {
      moltbook: moltbookAgents.length,
      bluesky: blueskyAgents.length,
    },
    total: allAgents.length,
    agents: allAgents,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(unified, null, 2));
  console.log(`Collected ${moltbookAgents.length} Moltbook + ${blueskyAgents.length} Bluesky = ${unified.total} total agents (${enriched} enriched with GitHub)`);
}

main();

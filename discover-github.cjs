#!/usr/bin/env node
// discover-github.cjs — Scan Moltbook posts for GitHub URLs and suggest mappings
// Usage: node discover-github.cjs [--apply]
// Without --apply, prints suggestions. With --apply, merges into github-mappings.json.

const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'https://www.moltbook.com/api/v1';
const GITHUB_MAP_PATH = path.join(__dirname, 'github-mappings.json');
const GITHUB_RE = /https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)(?:\/([a-zA-Z0-9_.-]+))?/g;

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function getApiKey() {
  if (process.env.MOLTBOOK_API_KEY) return process.env.MOLTBOOK_API_KEY;
  const creds = loadJSON(path.join(os.homedir(), '.config/moltbook/credentials.json'));
  return creds?.api_key || null;
}

async function fetchJSON(url) {
  const headers = { 'Content-Type': 'application/json' };
  const key = getApiKey();
  if (key) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function fetchSubmoltPosts(submolt, sort = 'new', limit = 25) {
  try {
    const data = await fetchJSON(`${BASE}/posts?submolt=${encodeURIComponent(submolt)}&sort=${sort}&limit=${limit}`);
    return Array.isArray(data) ? data : (data.posts || []);
  } catch (e) {
    console.error(`  Failed to fetch m/${submolt}: ${e.message}`);
    return [];
  }
}

async function fetchFeedPosts(sort = 'new', limit = 50) {
  try {
    const data = await fetchJSON(`${BASE}/feed?sort=${sort}&limit=${limit}`);
    return Array.isArray(data) ? data : (data.posts || []);
  } catch (e) {
    console.error(`  Failed to fetch feed: ${e.message}`);
    return [];
  }
}

function extractGithubUrls(text) {
  if (!text) return [];
  const matches = [];
  let m;
  const re = new RegExp(GITHUB_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const org = m[1];
    const repo = m[2];
    // Skip common non-agent github paths
    if (['topics', 'settings', 'notifications', 'marketplace', 'explore', 'trending'].includes(org)) continue;
    matches.push({ url: m[0], org, repo: repo || null });
  }
  return matches;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const existing = loadJSON(GITHUB_MAP_PATH) || {};
  const discoveries = {}; // handle -> { github, repos }

  const submolts = ['general', 'projects', 'showandtell', 'infrastructure', 'moltdev', 'automation', 'monero'];

  console.log('Scanning for GitHub URLs...\n');

  // Collect posts from feed + submolts
  const allPosts = [];
  const feedPosts = await fetchFeedPosts('new', 50);
  allPosts.push(...feedPosts);
  const hotPosts = await fetchFeedPosts('hot', 50);
  allPosts.push(...hotPosts);

  for (const sub of submolts) {
    const posts = await fetchSubmoltPosts(sub);
    allPosts.push(...posts);
  }

  // Dedup by post ID
  const seen = new Set();
  const uniquePosts = allPosts.filter(p => {
    const id = p._id || p.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  console.log(`  Fetched ${uniquePosts.length} unique posts\n`);

  for (const post of uniquePosts) {
    const author = post.author?.username || post.author?.name || post.username;
    if (!author) continue;

    const textParts = [post.title, post.content, post.body, post.url, post.link].filter(Boolean);
    const text = textParts.join(' ');
    const ghUrls = extractGithubUrls(text);

    if (ghUrls.length === 0) continue;

    if (!discoveries[author]) discoveries[author] = { github: null, repos: [] };
    for (const gh of ghUrls) {
      const repoUrl = gh.repo ? `https://github.com/${gh.org}/${gh.repo}` : null;
      const orgUrl = `https://github.com/${gh.org}`;

      if (!discoveries[author].github) {
        discoveries[author].github = orgUrl;
      }
      if (repoUrl && !discoveries[author].repos.includes(repoUrl)) {
        discoveries[author].repos.push(repoUrl);
      }
    }
  }

  // Filter out already-mapped handles
  const newDiscoveries = {};
  for (const [handle, data] of Object.entries(discoveries)) {
    if (!existing[handle]) {
      newDiscoveries[handle] = data;
    }
  }

  if (Object.keys(newDiscoveries).length === 0) {
    console.log('No new GitHub URLs discovered.');
    return;
  }

  console.log(`Found ${Object.keys(newDiscoveries).length} new GitHub mappings:\n`);
  for (const [handle, data] of Object.entries(newDiscoveries)) {
    console.log(`  @${handle}`);
    if (data.github) console.log(`    GitHub: ${data.github}`);
    if (data.repos.length) console.log(`    Repos:  ${data.repos.join(', ')}`);
  }

  if (apply) {
    const merged = { ...existing };
    delete merged._comment;
    for (const [handle, data] of Object.entries(newDiscoveries)) {
      merged[handle] = data;
    }
    merged._comment = 'Agent handle to GitHub mappings. Auto-discovered + manually curated.';
    fs.writeFileSync(GITHUB_MAP_PATH, JSON.stringify(merged, null, 2) + '\n');
    console.log(`\nMerged into ${GITHUB_MAP_PATH}`);
  } else {
    console.log('\nRun with --apply to merge into github-mappings.json');
  }
}

main().catch(e => { console.error(e); process.exit(1); });

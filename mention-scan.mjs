#!/usr/bin/env node

// mention-scan.mjs — Cross-platform mention aggregator with priority scoring (wq-491)
// CLI tool for E sessions to quickly find unreplied @moltbook mentions across all platforms.
// Deduplicates against engagement-trace.json to skip already-engaged threads.

import fs from "fs";
import path from "path";
import { getFourclawCredentials, FOURCLAW_API, CHATR_API, getChatrCredentials,
         MOLTCHAN_API, getLobchanKey, LOBCHAN_API } from "./providers/credentials.js";

const HOME = process.env.HOME || "/home/moltbot";
const CONFIG_DIR = path.join(HOME, ".config/moltbook");
const MCP_DIR = path.join(HOME, "moltbook-mcp");
const MENTIONS_PATH = path.join(CONFIG_DIR, "mentions.json");
const TRACE_PATH = path.join(CONFIG_DIR, "engagement-trace.json");
const SCAN_TIMEOUT = 8000;

// Platform API bases
const MOLTBOOK_API = "https://www.moltbook.com/api/v1";
const AICQ_BASE = "https://AICQ.chat/api/v1";
const GROVE_API = "https://grove.ctxly.app/api";
const COLONY_API = "https://thecolony.cc/api/v1";
const MDI_API = "https://mydeadinternet.com/api";

// --- Helpers ---

function loadJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, "utf8")); }
  catch { return null; }
}

function loadTrace() {
  try { return JSON.parse(fs.readFileSync(TRACE_PATH, "utf8")); }
  catch { return []; }
}

function loadMentions() {
  try { return JSON.parse(fs.readFileSync(MENTIONS_PATH, "utf8")); }
  catch { return { version: 1, lastScan: null, mentions: [], seenIds: [] }; }
}

function saveMentions(data) {
  data.mentions = data.mentions.slice(-200);
  data.seenIds = data.seenIds.slice(-500);
  fs.writeFileSync(MENTIONS_PATH, JSON.stringify(data, null, 2));
}

async function fetchJSON(url, opts = {}, timeout = SCAN_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function getCredFile(name) {
  try { return JSON.parse(fs.readFileSync(path.join(MCP_DIR, name), "utf8")); }
  catch { return null; }
}

function getKeyFile(name) {
  try { return fs.readFileSync(path.join(MCP_DIR, name), "utf8").trim(); }
  catch {
    try { return fs.readFileSync(path.join(HOME, name), "utf8").trim(); }
    catch { return null; }
  }
}

// --- Platform Scanners ---
// Each returns { mentions: [{id, platform, author, content, url, timestamp}], errors: [] }

const MENTION_RE = /\bmoltbook\b/i;
const DIRECT_RE = /@moltbook\b/i;

function makeMention(platform, id, author, content, url, timestamp) {
  return {
    id: `${platform.toLowerCase().replace(/\s/g, "")}-${id}`,
    platform,
    author: author || "unknown",
    content: (content || "").slice(0, 300),
    url: url || null,
    timestamp: timestamp || new Date().toISOString(),
    direct: DIRECT_RE.test(content || "")
  };
}

async function scanMoltbook() {
  const r = { mentions: [], errors: [] };
  try {
    const data = await fetchJSON(`${MOLTBOOK_API}/search?q=moltbook&limit=20&type=all`);
    if (!data) { r.errors.push("moltbook: unreachable"); return r; }
    for (const item of (data.results || data.posts || data.data || [])) {
      const c = item.title || item.body || item.content || "";
      if (MENTION_RE.test(c)) {
        r.mentions.push(makeMention("Moltbook", item.id || item._id,
          item.author?.name || item.author, c,
          item.id ? `https://www.moltbook.com/post/${item.id}` : null,
          item.created_at || item.createdAt));
      }
    }
  } catch (e) { r.errors.push(`moltbook: ${e.message}`); }
  return r;
}

async function scanFourclaw() {
  const r = { mentions: [], errors: [] };
  try {
    const creds = getFourclawCredentials();
    const key = creds?.apiKey || creds?.api_key;
    if (!key) { r.errors.push("4claw: no credentials"); return r; }
    const data = await fetchJSON(`${FOURCLAW_API}/search?q=moltbook&limit=20`,
      { headers: { "x-api-key": key } });
    if (!data) { r.errors.push("4claw: unreachable"); return r; }
    for (const item of (data.results || data.threads || data.data || [])) {
      const c = item.title || item.body || item.content || "";
      r.mentions.push(makeMention("4claw", item.id || item._id,
        item.author?.name || item.author, c,
        item.id ? `https://www.4claw.org/thread/${item.id}` : null,
        item.created_at || item.createdAt));
    }
  } catch (e) { r.errors.push(`4claw: ${e.message}`); }
  return r;
}

async function scanChatr() {
  const r = { mentions: [], errors: [] };
  try {
    const creds = getChatrCredentials();
    if (!creds?.apiKey) { r.errors.push("chatr: no credentials"); return r; }
    const data = await fetchJSON(`${CHATR_API}/messages?limit=50`,
      { headers: { "x-api-key": creds.apiKey } });
    if (!data) { r.errors.push("chatr: unreachable"); return r; }
    const msgs = Array.isArray(data) ? data : (data.messages || data.data || []);
    for (const msg of msgs) {
      const c = msg.content || msg.text || msg.body || "";
      if (MENTION_RE.test(c)) {
        r.mentions.push(makeMention("Chatr", msg.id || msg._id,
          msg.agentId || msg.author || msg.sender, c, null,
          msg.timestamp || msg.created_at));
      }
    }
  } catch (e) { r.errors.push(`chatr: ${e.message}`); }
  return r;
}

async function scanMoltchan() {
  const r = { mentions: [], errors: [] };
  try {
    const data = await fetchJSON(`${MOLTCHAN_API}/search?q=moltbook&limit=20`);
    if (!data) { r.errors.push("moltchan: unreachable"); return r; }
    for (const item of (data.results || data.threads || data.data || [])) {
      const c = item.title || item.body || item.content || "";
      r.mentions.push(makeMention("Moltchan", item.id || item._id,
        item.author || item.name, c,
        item.id ? `https://www.moltchan.org/thread/${item.id}` : null,
        item.created_at || item.createdAt));
    }
  } catch (e) { r.errors.push(`moltchan: ${e.message}`); }
  return r;
}

async function scanAicq() {
  const r = { mentions: [], errors: [] };
  try {
    const creds = getCredFile(".aicq-credentials.json");
    const token = creds?.token;
    if (!token) { r.errors.push("aicq: no credentials"); return r; }
    const data = await fetchJSON(`${AICQ_BASE}/messages?limit=50`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!data) { r.errors.push("aicq: unreachable"); return r; }
    let msgs = [];
    if (Array.isArray(data)) msgs = data;
    else if (Array.isArray(data.messages)) msgs = data.messages;
    else if (Array.isArray(data.data)) msgs = data.data;
    else if (typeof data === "object") msgs = Object.values(data).find(v => Array.isArray(v)) || [];
    for (const msg of msgs) {
      const c = msg.content || msg.text || msg.body || "";
      if (MENTION_RE.test(c)) {
        r.mentions.push(makeMention("AICQ", msg.id || msg._id,
          msg.username || msg.author, c, null,
          msg.timestamp || msg.created_at));
      }
    }
  } catch (e) { r.errors.push(`aicq: ${e.message}`); }
  return r;
}

async function scanGrove() {
  const r = { mentions: [], errors: [] };
  try {
    const creds = getCredFile("grove-credentials.json");
    const key = creds?.api_key || creds?.token;
    if (!key) { r.errors.push("grove: no credentials"); return r; }
    const data = await fetchJSON(`${GROVE_API}/posts`,
      { headers: { Authorization: `Bearer ${key}` } });
    if (!data) { r.errors.push("grove: unreachable"); return r; }
    const posts = Array.isArray(data) ? data : (data.posts || data.data || []);
    for (const post of posts) {
      const c = post.content || post.body || post.text || "";
      if (MENTION_RE.test(c)) {
        r.mentions.push(makeMention("Grove", post.id || post._id,
          post.author || post.handle || post.username, c,
          post.id ? `https://grove.ctxly.app/post/${post.id}` : null,
          post.created_at || post.createdAt || post.timestamp));
      }
    }
  } catch (e) { r.errors.push(`grove: ${e.message}`); }
  return r;
}

async function scanColony() {
  const r = { mentions: [], errors: [] };
  try {
    // Colony posts endpoint is public (no auth for reads)
    const data = await fetchJSON(`${COLONY_API}/posts?sort=new`);
    if (!data) { r.errors.push("colony: unreachable"); return r; }
    const posts = Array.isArray(data) ? data : (data.posts || data.data || []);
    for (const post of posts) {
      const c = post.content || post.body || post.text || "";
      if (MENTION_RE.test(c)) {
        const author = typeof post.author === "object" ? (post.author?.name || post.author?.username || post.author?.handle || "unknown") : (post.author || post.username);
        r.mentions.push(makeMention("Colony", post.id || post._id,
          author, c,
          post.id ? `https://thecolony.cc/post/${post.id}` : null,
          post.created_at || post.createdAt || post.timestamp));
      }
    }
  } catch (e) { r.errors.push(`colony: ${e.message}`); }
  return r;
}

async function scanLobchan() {
  const r = { mentions: [], errors: [] };
  try {
    const key = getLobchanKey();
    if (!key) { r.errors.push("lobchan: no credentials"); return r; }
    // Scan "builds" and "general" boards for mentions
    for (const board of ["builds", "general"]) {
      const data = await fetchJSON(`${LOBCHAN_API}/boards/${board}/threads?limit=20`,
        { headers: { Authorization: `Bearer ${key}` } });
      if (!data) continue;
      const threads = Array.isArray(data) ? data : (data.threads || data.data || []);
      for (const t of threads) {
        const c = (t.title || "") + " " + (t.content || t.body || "");
        if (MENTION_RE.test(c)) {
          r.mentions.push(makeMention("LobChan", t.id || t._id,
            t.author || t.username, c.trim(),
            t.id ? `https://lobchan.ai/boards/${board}/thread/${t.id}` : null,
            t.created_at || t.createdAt || t.timestamp));
        }
      }
    }
  } catch (e) { r.errors.push(`lobchan: ${e.message}`); }
  return r;
}

async function scanMDI() {
  const r = { mentions: [], errors: [] };
  try {
    const key = getKeyFile(".mdi-key");
    if (!key) { r.errors.push("mdi: no credentials"); return r; }
    const data = await fetchJSON(`${MDI_API}/stream`,
      { headers: { Authorization: `Bearer ${key}` } });
    if (!data) { r.errors.push("mdi: unreachable"); return r; }
    const fragments = Array.isArray(data) ? data : (data.fragments || data.data || []);
    for (const frag of fragments) {
      const c = frag.content || frag.text || frag.body || "";
      if (MENTION_RE.test(c)) {
        r.mentions.push(makeMention("MDI", frag.id || frag._id,
          frag.author || frag.agent || "unknown", c, null,
          frag.timestamp || frag.created_at));
      }
    }
  } catch (e) { r.errors.push(`mdi: ${e.message}`); }
  return r;
}

// --- Priority Scoring ---

function scoreMention(mention, engagedThreadIds) {
  let score = 50; // base score

  // Direct @mention is higher priority than keyword match
  if (mention.direct) score += 30;

  // Questions are higher priority (someone asking us something)
  if (/\?/.test(mention.content)) score += 15;

  // Already engaged in this thread — lower priority
  if (mention.url && engagedThreadIds.has(extractThreadId(mention))) score -= 40;

  // Recency boost: mentions from last 24h get a boost
  const age = Date.now() - new Date(mention.timestamp).getTime();
  if (age < 24 * 60 * 60 * 1000) score += 20;
  else if (age < 72 * 60 * 60 * 1000) score += 10;

  // Platform weight — higher-traffic platforms slightly boosted
  const platformBoost = { "4claw": 5, "Chatr": 5, "Grove": 5, "Moltbook": 3 };
  score += platformBoost[mention.platform] || 0;

  return Math.max(0, Math.min(100, score));
}

function extractThreadId(mention) {
  if (!mention.url) return mention.id;
  // Extract last path segment as thread ID
  const parts = mention.url.split("/");
  return parts[parts.length - 1] || mention.id;
}

function getEngagedThreadIds(traces) {
  const ids = new Set();
  for (const trace of traces) {
    for (const thread of (trace.threads_contributed || [])) {
      if (thread.thread_id) ids.add(thread.thread_id);
      // Also add action-based dedup: if we posted/replied, it's engaged
      if (thread.action === "post" || thread.action === "reply") {
        ids.add(thread.thread_id);
      }
    }
  }
  return ids;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const forceFlag = args.includes("--force");
  const jsonFlag = args.includes("--json");
  const limitArg = args.find(a => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 20;

  const state = loadMentions();
  const seenSet = new Set(state.seenIds);

  // Rate limit check (unless forced)
  if (!forceFlag && state.lastScan) {
    const elapsed = Date.now() - new Date(state.lastScan).getTime();
    if (elapsed < 5 * 60 * 1000) {
      const unread = state.mentions.filter(m => !m.read);
      if (!jsonFlag) {
        console.log(`Last scan ${Math.round(elapsed / 1000)}s ago. ${unread.length} unread. Use --force to rescan.`);
      }
      // Still show priority queue from existing data
      outputPriorityQueue(state.mentions.filter(m => !m.read), limit, jsonFlag);
      return;
    }
  }

  console.error(`[mention-scan] Scanning 9 platforms...`);

  // Scan all platforms in parallel
  const results = await Promise.all([
    scanMoltbook(), scanFourclaw(), scanChatr(), scanMoltchan(), scanAicq(),
    scanGrove(), scanColony(), scanLobchan(), scanMDI()
  ]);

  const allErrors = results.flatMap(r => r.errors);
  let newCount = 0;

  for (const result of results) {
    for (const mention of result.mentions) {
      if (!seenSet.has(mention.id)) {
        seenSet.add(mention.id);
        state.seenIds.push(mention.id);
        state.mentions.push({ ...mention, read: false });
        newCount++;
      }
    }
  }

  state.lastScan = new Date().toISOString();
  saveMentions(state);

  const unread = state.mentions.filter(m => !m.read);

  if (!jsonFlag) {
    console.log(`Scan complete: ${newCount} new, ${unread.length} unread across 9 platforms.`);
    if (allErrors.length > 0) {
      console.log(`Errors: ${allErrors.join("; ")}`);
    }
  }

  outputPriorityQueue(unread, limit, jsonFlag);
}

function outputPriorityQueue(unread, limit, jsonFlag) {
  if (unread.length === 0) {
    if (jsonFlag) console.log(JSON.stringify({ mentions: [], errors: [] }));
    else console.log("No unread mentions.");
    return;
  }

  // Load engagement trace for dedup
  const traces = loadTrace();
  const engagedIds = getEngagedThreadIds(traces);

  // Score and sort
  const scored = unread.map(m => ({
    ...m,
    score: scoreMention(m, engagedIds)
  })).sort((a, b) => b.score - a.score).slice(0, limit);

  if (jsonFlag) {
    console.log(JSON.stringify({ mentions: scored, count: unread.length }));
    return;
  }

  console.log(`\n--- Priority Queue (${scored.length}/${unread.length} shown) ---`);
  for (const m of scored) {
    const flag = m.direct ? "@" : " ";
    const age = timeSince(m.timestamp);
    const engaged = engagedIds.has(extractThreadId(m)) ? " [engaged]" : "";
    console.log(`[${m.score.toString().padStart(3)}] ${flag}[${m.platform}] ${age} @${m.author}: ${m.content.slice(0, 100)}${engaged}`);
    if (m.url) console.log(`       ${m.url}`);
  }
}

function timeSince(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
  return `${Math.round(ms / 86400000)}d ago`;
}

main().catch(e => {
  console.error(`[mention-scan] Fatal: ${e.message}`);
  process.exit(1);
});

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const API = "https://www.moltbook.com/api/v1";
let apiKey;

// --- Blocklist ---
const BLOCKLIST_FILE = join(process.env.HOME || "/tmp", "moltbook-mcp", "blocklist.json");
function loadBlocklist() {
  try {
    if (existsSync(BLOCKLIST_FILE)) {
      const data = JSON.parse(readFileSync(BLOCKLIST_FILE, "utf8"));
      return new Set(data.blocked_users || []);
    }
  } catch {}
  return new Set();
}

// --- Engagement state tracking ---
const STATE_DIR = join(process.env.HOME || "/tmp", ".config", "moltbook");
const STATE_FILE = join(STATE_DIR, "engagement-state.json");

let _stateCache = null;

function loadState() {
  if (_stateCache) return _stateCache;
  let state;
  try {
    if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {}
  if (!state) state = { seen: {}, commented: {}, voted: {}, myPosts: {}, myComments: {} };
  // Migrate legacy string seen entries to object format
  for (const [id, val] of Object.entries(state.seen || {})) {
    if (typeof val === "string") state.seen[id] = { at: val };
  }
  _stateCache = state;
  return state;
}

function saveState(state) {
  _stateCache = state;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function markSeen(postId, commentCount, submolt, author) {
  const s = loadState();
  if (!s.seen[postId]) {
    s.seen[postId] = { at: new Date().toISOString() };
  }
  if (commentCount !== undefined) s.seen[postId].cc = commentCount;
  if (submolt) s.seen[postId].sub = submolt;
  if (author) s.seen[postId].author = author;
  saveState(s);
}

function markCommented(postId, commentId) {
  const s = loadState();
  if (!s.commented[postId]) s.commented[postId] = [];
  s.commented[postId].push({ commentId, at: new Date().toISOString() });
  saveState(s);
}

function markVoted(targetId) {
  const s = loadState();
  s.voted[targetId] = new Date().toISOString();
  saveState(s);
}

function unmarkVoted(targetId) {
  const s = loadState();
  delete s.voted[targetId];
  saveState(s);
}

function markMyPost(postId) {
  const s = loadState();
  s.myPosts[postId] = new Date().toISOString();
  saveState(s);
}

function markBrowsed(submoltName) {
  const s = loadState();
  if (!s.browsedSubmolts) s.browsedSubmolts = {};
  s.browsedSubmolts[submoltName] = new Date().toISOString();
  saveState(s);
}

function markMyComment(postId, commentId) {
  const s = loadState();
  if (!s.myComments[postId]) s.myComments[postId] = [];
  s.myComments[postId].push({ commentId, at: new Date().toISOString() });
  saveState(s);
}

// Check outbound content for accidental sensitive data leakage.
// Returns warnings (strings) if suspicious patterns are found. Does not block posting.
function checkOutbound(text) {
  if (!text) return [];
  const warnings = [];
  const patterns = [
    [/(?:\/home\/\w+|~\/)\.\w+/g, "possible dotfile path"],
    [/(?:sk-|key-|token-)[a-zA-Z0-9]{20,}/g, "possible API key/token"],
    [/[A-Za-z0-9+/]{40,}={0,2}/g, "possible base64-encoded secret"],
    [/(?:ANTHROPIC|OPENAI|AWS|GITHUB|MOLTBOOK)_[A-Z_]*(?:KEY|TOKEN|SECRET)/gi, "possible env var name"],
    [/Bearer\s+[a-zA-Z0-9._-]{20,}/g, "possible auth header"],
  ];
  for (const [re, label] of patterns) {
    if (re.test(text)) warnings.push(label);
  }
  return warnings;
}

// Sanitize user-generated content to reduce prompt injection surface.
// Wraps untrusted text in markers so the LLM can distinguish it from instructions.
function sanitize(text) {
  if (!text) return "";
  return `[USER_CONTENT_START]${text.replace(/\[USER_CONTENT_(?:START|END)\]/g, "")}[USER_CONTENT_END]`;
}

// API call tracking — counts calls per session + persists history across sessions
let apiCallCount = 0;
let apiErrorCount = 0;
const apiCallLog = {}; // path prefix -> count
const sessionStart = new Date().toISOString();

// Session activity log — semantic actions this session
const sessionActions = []; // ["commented on X", "posted Y", ...]
function logAction(action) { sessionActions.push(action); }

function saveApiSession() {
  const s = loadState();
  if (!s.apiHistory) s.apiHistory = [];
  // Update or append current session entry
  const existing = s.apiHistory.findIndex(h => h.session === sessionStart);
  // Build engagement snapshot for cross-session comparison
  const seenCount = Object.keys(s.seen).length;
  const commentedCount = Object.keys(s.commented).length;
  const votedCount = Object.keys(s.voted).length;
  const postCount = Object.keys(s.myPosts).length;
  // Top 5 authors by engagement this snapshot
  const authorEngagement = {};
  for (const [pid, data] of Object.entries(s.seen)) {
    if (typeof data !== "object" || !data.author) continue;
    const a = data.author;
    if (!authorEngagement[a]) authorEngagement[a] = 0;
    if (s.commented[pid]) authorEngagement[a]++;
    if (s.voted[pid]) authorEngagement[a]++;
  }
  const topSnap = Object.entries(authorEngagement)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, eng]) => ({ name, eng }));
  const snapshot = { seen: seenCount, commented: commentedCount, voted: votedCount, posts: postCount, topAuthors: topSnap };
  const entry = { session: sessionStart, calls: apiCallCount, errors: apiErrorCount, log: { ...apiCallLog }, actions: [...sessionActions], snapshot };
  if (existing >= 0) s.apiHistory[existing] = entry;
  else s.apiHistory.push(entry);
  // Keep last 50 sessions
  if (s.apiHistory.length > 50) s.apiHistory = s.apiHistory.slice(-50);
  saveState(s);
}

async function moltFetch(path, opts = {}) {
  apiCallCount++;
  const prefix = path.split("?")[0].split("/").slice(0, 3).join("/");
  apiCallLog[prefix] = (apiCallLog[prefix] || 0) + 1;
  if (apiCallCount % 10 === 0) saveApiSession();
  const url = `${API}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000); const res = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers }, signal: controller.signal }).finally(() => clearTimeout(timer));
  let json;
  try {
    json = await res.json();
  } catch {
    apiErrorCount++;
    return { success: false, error: `Non-JSON response (HTTP ${res.status})` };
  }
  if (!res.ok || json.error) apiErrorCount++;
  return json;
}

const server = new McpServer({ name: "moltbook", version: "1.0.0" });

// Read feed
server.tool("moltbook_feed", "Get the Moltbook feed (posts from subscriptions + follows, or global)", {
  sort: z.enum(["hot", "new", "top", "rising"]).default("hot").describe("Sort order"),
  limit: z.number().min(1).max(50).default(10).describe("Number of posts"),
  submolt: z.string().optional().describe("Filter to a specific submolt"),
}, async ({ sort, limit, submolt }) => {
  const endpoint = submolt ? `/posts?submolt=${encodeURIComponent(submolt)}&sort=${sort}&limit=${limit}` : `/feed?sort=${sort}&limit=${limit}`;
  const data = await moltFetch(endpoint);
  if (!data.success) return { content: [{ type: "text", text: JSON.stringify(data) }] };
  if (submolt) markBrowsed(submolt);
  const state = loadState();
  const blocked = loadBlocklist();
  const summary = data.posts.filter(p => !blocked.has(p.author.name)).map(p => {
    const flags = [];
    if (state.seen[p.id]) {
      const seenData = typeof state.seen[p.id] === "string" ? { at: state.seen[p.id] } : state.seen[p.id];
      const lastCC = seenData.cc;
      if (lastCC !== undefined && p.comment_count > lastCC) {
        flags.push(`SEEN, +${p.comment_count - lastCC} new comments`);
      } else {
        flags.push("SEEN");
      }
    }
    if (state.commented[p.id]) flags.push(`COMMENTED(${state.commented[p.id].length}x)`);
    if (state.voted[p.id]) flags.push("VOTED");
    const label = flags.length ? ` [${flags.join(", ")}]` : "";
    return `[${p.upvotes}↑ ${p.comment_count}c] "${sanitize(p.title)}" by @${p.author.name} in m/${p.submolt.name}${label}\n  ID: ${p.id}\n  ${sanitize(p.content?.substring(0, 200)) || p.url || ""}...`;
  }).join("\n\n");
  return { content: [{ type: "text", text: summary || "No posts found." }] };
});

// Read post with comments
server.tool("moltbook_post", "Get a single post with its comments", {
  post_id: z.string().describe("Post ID"),
}, async ({ post_id }) => {
  const data = await moltFetch(`/posts/${post_id}`);
  if (!data.success) return { content: [{ type: "text", text: JSON.stringify(data) }] };
  const p = data.post;
  markSeen(post_id, p.comment_count, p.submolt?.name, p.author?.name);
  const state = loadState();
  const stateHints = [];
  if (state.commented[post_id]) stateHints.push(`YOU COMMENTED HERE (${state.commented[post_id].length}x)`);
  if (state.voted[post_id]) stateHints.push("YOU VOTED");
  const stateLabel = stateHints.length ? ` [${stateHints.join(", ")}]` : "";
  let text = `"${sanitize(p.title)}" by @${p.author.name} in m/${p.submolt.name}${stateLabel}\n${p.upvotes}↑ ${p.downvotes}↓ ${p.comment_count} comments\n\n${sanitize(p.content) || p.url || ""}`;
  if (data.comments?.length) {
    text += "\n\n--- Comments ---\n";
    text += formatComments(data.comments);
  }
  return { content: [{ type: "text", text }] };
});

function formatComments(comments, depth = 0, blocked = null) {
  if (!blocked) blocked = loadBlocklist();
  let out = "";
  for (const c of comments) {
    if (blocked.has(c.author.name)) continue;
    const indent = "  ".repeat(depth);
    out += `${indent}@${c.author.name} [${c.upvotes}↑]: ${sanitize(c.content)}\n`;
    if (c.replies?.length) out += formatComments(c.replies, depth + 1, blocked);
  }
  return out;
}

// Create post
server.tool("moltbook_post_create", "Create a new post in a submolt", {
  submolt: z.string().describe("Submolt name (e.g. 'general')"),
  title: z.string().describe("Post title"),
  content: z.string().optional().describe("Post body text"),
  url: z.string().optional().describe("Link URL (for link posts)"),
}, async ({ submolt, title, content, url }) => {
  const outboundWarnings = [...checkOutbound(title), ...checkOutbound(content)];
  const body = { submolt, title };
  if (content) body.content = content;
  if (url) body.url = url;
  const data = await moltFetch("/posts", { method: "POST", body: JSON.stringify(body) });
  if (data.success && data.post) {
    markMyPost(data.post.id);
    logAction(`posted "${title}" in m/${submolt}`);
  }
  let text = JSON.stringify(data, null, 2);
  if (outboundWarnings.length) text += `\n\n⚠️ OUTBOUND WARNINGS: ${outboundWarnings.join(", ")}. Review your post for accidental sensitive data.`;
  return { content: [{ type: "text", text }] };
});

// Comment
server.tool("moltbook_comment", "Add a comment to a post (or reply to a comment)", {
  post_id: z.string().describe("Post ID"),
  content: z.string().describe("Comment text"),
  parent_id: z.string().optional().describe("Parent comment ID for replies"),
}, async ({ post_id, content, parent_id }) => {
  const outboundWarnings = checkOutbound(content);
  const body = { content };
  if (parent_id) body.parent_id = parent_id;
  const data = await moltFetch(`/posts/${post_id}/comments`, { method: "POST", body: JSON.stringify(body) });
  if (data.success && data.comment) {
    markCommented(post_id, data.comment.id);
    markMyComment(post_id, data.comment.id);
    logAction(`commented on ${post_id.slice(0, 8)}`);
  }
  let text = JSON.stringify(data, null, 2);
  if (outboundWarnings.length) text += `\n\n⚠️ OUTBOUND WARNINGS: ${outboundWarnings.join(", ")}. Review your comment for accidental sensitive data.`;
  return { content: [{ type: "text", text }] };
});

// Vote
server.tool("moltbook_vote", "Upvote or downvote a post or comment", {
  type: z.enum(["post", "comment"]).describe("Target type"),
  id: z.string().describe("Post or comment ID"),
  direction: z.enum(["upvote", "downvote"]).describe("Vote direction"),
}, async ({ type, id, direction }) => {
  const s = loadState();
  if (direction === "upvote" && s.voted[id]) {
    return { content: [{ type: "text", text: `Already upvoted ${type} ${id.slice(0, 8)} — skipping to avoid toggle-off.` }] };
  }
  const prefix = type === "post" ? "posts" : "comments";
  const data = await moltFetch(`/${prefix}/${id}/${direction}`, { method: "POST" });
  if (data.success && data.action === "upvoted") { markVoted(id); logAction(`upvoted ${type} ${id.slice(0, 8)}`); }
  if (data.success && data.action === "removed") { unmarkVoted(id); logAction(`unvoted ${type} ${id.slice(0, 8)}`); }
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Search
server.tool("moltbook_search", "Search posts, agents, and submolts", {
  query: z.string().describe("Search query"),
  limit: z.number().min(1).max(50).default(10).describe("Max results"),
}, async ({ query, limit }) => {
  const data = await moltFetch(`/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!data.success) return { content: [{ type: "text", text: JSON.stringify(data) }] };
  const r = data.results;
  let text = "";
  if (r.posts?.length) {
    text += "Posts:\n" + r.posts.map(p => `  [${p.upvotes}↑] "${sanitize(p.title)}" by @${p.author.name} (${p.id})`).join("\n") + "\n\n";
  }
  if (r.moltys?.length) {
    text += "Agents:\n" + r.moltys.map(a => `  @${a.name}: ${sanitize(a.description) || ""}`).join("\n") + "\n\n";
  }
  if (r.submolts?.length) {
    text += "Submolts:\n" + r.submolts.map(s => `  m/${s.name}: ${s.display_name}`).join("\n") + "\n";
  }
  return { content: [{ type: "text", text: text || "No results." }] };
});

// List submolts
server.tool("moltbook_submolts", "List all submolts", {}, async () => {
  const data = await moltFetch("/submolts");
  if (!data.success) return { content: [{ type: "text", text: JSON.stringify(data) }] };
  const text = data.submolts.map(s => `m/${s.name} (${s.subscriber_count} subs) — ${s.display_name}`).join("\n");
  return { content: [{ type: "text", text }] };
});

// Subscribe/unsubscribe
server.tool("moltbook_subscribe", "Subscribe or unsubscribe from a submolt", {
  submolt: z.string().describe("Submolt name"),
  action: z.enum(["subscribe", "unsubscribe"]).describe("Action"),
}, async ({ submolt, action }) => {
  const method = action === "subscribe" ? "POST" : "DELETE";
  const data = await moltFetch(`/submolts/${encodeURIComponent(submolt)}/subscribe`, { method });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Profile
server.tool("moltbook_profile", "View your profile or another molty's profile", {
  name: z.string().optional().describe("Molty name (omit for your own profile)"),
}, async ({ name }) => {
  const endpoint = name ? `/agents/profile?name=${encodeURIComponent(name)}` : "/agents/me";
  const data = await moltFetch(endpoint);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Profile update
server.tool("moltbook_profile_update", "Update your Moltbook profile description", {
  description: z.string().describe("New profile description"),
}, async ({ description }) => {
  const data = await moltFetch("/agents/me", { method: "PATCH", body: JSON.stringify({ description }) });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Status
server.tool("moltbook_status", "Check your claim status", {}, async () => {
  const data = await moltFetch("/agents/status");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Engagement state
server.tool("moltbook_state", "View your engagement state — posts seen, commented on, voted on, and your own posts", {
  format: z.enum(["full", "compact"]).default("full").describe("'compact' returns a minimal one-line digest; 'full' includes IDs, per-author, per-submolt details"),
}, async ({ format }) => {
  const s = loadState();
  const seenCount = Object.keys(s.seen).length;
  const commentedPosts = Object.keys(s.commented);
  const votedCount = Object.keys(s.voted).length;
  const myPostIds = Object.keys(s.myPosts);
  const myCommentPosts = Object.keys(s.myComments);
  const sessionNum = (s.apiHistory?.length || 0) + 1;
  const staleCount = Object.values(s.seen).filter(v => typeof v === "object" && v.fails >= 3).length;
  const backoffCount = Object.values(s.seen).filter(v => typeof v === "object" && v.fails && v.fails < 3 && v.nextCheck && sessionNum < v.nextCheck).length;
  let text = `Engagement state (session ${sessionNum}):\n`;
  text += `- Posts seen: ${seenCount}${staleCount ? ` (${staleCount} stale)` : ""}${backoffCount ? ` (${backoffCount} in backoff)` : ""}\n`;
  text += `- Posts commented on: ${commentedPosts.length} (IDs: ${commentedPosts.join(", ") || "none"})\n`;
  text += `- Items voted on: ${votedCount}\n`;
  text += `- My posts: ${myPostIds.length} (IDs: ${myPostIds.join(", ") || "none"})\n`;
  text += `- Posts where I left comments: ${myCommentPosts.length} (IDs: ${myCommentPosts.join(", ") || "none"})\n`;
  const browsedEntries = s.browsedSubmolts ? Object.entries(s.browsedSubmolts) : [];
  if (browsedEntries.length) {
    const sorted = browsedEntries.sort((a, b) => a[1].localeCompare(b[1]));
    text += `- Submolts browsed (oldest first): ${sorted.map(([name, ts]) => `${name} (${ts.slice(0, 10)})`).join(", ")}\n`;
  }
  text += `- API calls this session: ${apiCallCount}${apiErrorCount ? ` (${apiErrorCount} errors)` : ""}`;
  if (Object.keys(apiCallLog).length) {
    text += ` (${Object.entries(apiCallLog).map(([k, v]) => `${k}: ${v}`).join(", ")})`;
  }
  text += "\n";
  // Cross-session API history
  if (s.apiHistory && s.apiHistory.length > 0) {
    const totalCalls = s.apiHistory.reduce((sum, h) => sum + h.calls, 0);
    const sessionCount = s.apiHistory.length;
    const avg = Math.round(totalCalls / sessionCount);
    const totalErrors = s.apiHistory.reduce((sum, h) => sum + (h.errors || 0), 0);
    const recent5 = s.apiHistory.slice(-5).map(h => `${h.session.slice(0, 10)}: ${h.calls}${h.errors ? `(${h.errors}err)` : ""}`).join(", ");
    text += `- API history: ${totalCalls} calls, ${totalErrors} errors across ${sessionCount} sessions (avg ${avg}/session)\n`;
    text += `- Recent sessions: ${recent5}\n`;
    // Show last session's actions as recap
    const prevSession = s.apiHistory.length >= 2 ? s.apiHistory[s.apiHistory.length - 2] : null;
    if (prevSession?.actions?.length) {
      text += `- Last session actions: ${prevSession.actions.join("; ")}\n`;
    }
  }
  if (sessionActions.length) {
    text += `- This session actions: ${sessionActions.join("; ")}\n`;
  }
  // Engagement density per submolt
  const subCounts = {}; // submolt -> { seen: N, commented: N }
  for (const [pid, data] of Object.entries(s.seen)) {
    const sub = (typeof data === "object" && data.sub) || "unknown";
    if (!subCounts[sub]) subCounts[sub] = { seen: 0, commented: 0 };
    subCounts[sub].seen++;
    if (s.commented[pid]) subCounts[sub].commented++;
  }
  const activeSubs = Object.entries(subCounts).filter(([, v]) => v.commented > 0).sort((a, b) => b[1].commented - a[1].commented);
  if (activeSubs.length) {
    text += `- Engagement by submolt: ${activeSubs.map(([name, v]) => `${name}(${v.commented}/${v.seen})`).join(", ")}\n`;
  }
  // Per-author engagement: who do I interact with most?
  const authorCounts = {}; // author -> { seen: N, commented: N, voted: N, lastSeen: ISO }
  for (const [pid, data] of Object.entries(s.seen)) {
    const author = data.author || null;
    if (!author) continue;
    if (!authorCounts[author]) authorCounts[author] = { seen: 0, commented: 0, voted: 0, lastSeen: null };
    authorCounts[author].seen++;
    if (s.commented[pid]) authorCounts[author].commented++;
    if (s.voted[pid]) authorCounts[author].voted++;
    if (data.at && (!authorCounts[author].lastSeen || data.at > authorCounts[author].lastSeen)) {
      authorCounts[author].lastSeen = data.at;
    }
  }
  const activeAuthors = Object.entries(authorCounts)
    .filter(([, v]) => v.commented > 0 || v.voted > 0)
    .sort((a, b) => (b[1].commented + b[1].voted) - (a[1].commented + a[1].voted));
  if (activeAuthors.length) {
    text += `- Engagement by author: ${activeAuthors.slice(0, 10).map(([name, v]) => `@${name}(c:${v.commented} v:${v.voted}/${v.seen})`).join(", ")}\n`;
  }
  if (format === "compact") {
    const prevSession = s.apiHistory?.length >= 2 ? s.apiHistory[s.apiHistory.length - 2] : null;
    const recap = prevSession?.actions?.length ? ` | Last: ${prevSession.actions.slice(0, 3).join("; ")}` : "";
    const compact = `Session ${sessionNum} | ${Object.keys(s.seen).length} seen, ${Object.keys(s.commented).length} commented, ${Object.keys(s.voted).length} voted, ${Object.keys(s.myPosts).length} posts | API: ${(s.apiHistory || []).reduce((sum, h) => sum + h.calls, 0)} total calls${recap}`;
    return { content: [{ type: "text", text: compact }] };
  }
  return { content: [{ type: "text", text }] };
});

// Thread diff — check all tracked threads for new activity
server.tool("moltbook_thread_diff", "Check all tracked threads for new comments since last visit. Returns only threads with new activity.", {
  scope: z.enum(["all", "engaged"]).default("all").describe("'all' checks every seen post; 'engaged' checks only posts you commented on or authored"),
}, async ({ scope }) => {
  const s = loadState();
  // Collect post IDs based on scope
  const allIds = scope === "engaged"
    ? new Set([...Object.keys(s.commented), ...Object.keys(s.myPosts)])
    : new Set([...Object.keys(s.seen), ...Object.keys(s.commented), ...Object.keys(s.myPosts)]);
  if (allIds.size === 0) return { content: [{ type: "text", text: "No tracked threads yet." }] };

  const diffs = [];
  const errors = [];
  let dirty = false;
  const currentSession = (s.apiHistory || []).length + 1;
  let skippedBackoff = 0;
  for (const postId of allIds) {
    try {
      const seenEntry = s.seen[postId];
      // Exponential backoff: skip if not yet due for recheck
      if (typeof seenEntry === "object" && seenEntry.fails) {
        if (seenEntry.nextCheck && currentSession < seenEntry.nextCheck) {
          skippedBackoff++;
          continue;
        }
        // Dead posts (fails >= 3 without nextCheck) are legacy stale — skip
        if (seenEntry.fails >= 3 && !seenEntry.nextCheck) { continue; }
      }
      const data = await moltFetch(`/posts/${postId}`);
      if (!data.success) {
        // Ensure seen entry exists so fail counter can be tracked
        if (!s.seen[postId]) s.seen[postId] = { at: new Date().toISOString() };
        // "Post not found" = permanently deleted, prune immediately
        if (data.error === "Post not found") {
          s.seen[postId].fails = 3;
          delete s.seen[postId].nextCheck;
        } else {
          const fails = (s.seen[postId].fails || 0) + 1;
          s.seen[postId].fails = fails;
          s.seen[postId].nextCheck = currentSession + Math.pow(2, fails);
        }
        dirty = true;
        errors.push(postId);
        continue;
      }
      const p = data.post;
      // Reset fail counter and backoff on success
      if (typeof s.seen[postId] === "object" && s.seen[postId].fails) {
        delete s.seen[postId].fails;
        delete s.seen[postId].nextCheck;
      }
      const seenData = s.seen[postId];
      const lastCC = seenData && typeof seenData === "object" ? seenData.cc : undefined;
      const currentCC = p.comment_count;
      const isNew = lastCC === undefined || currentCC > lastCC;
      const isMine = !!s.myPosts[postId];
      if (isNew) {
        const delta = lastCC !== undefined ? `+${currentCC - lastCC}` : "new";
        const sub = p.submolt?.name ? ` in m/${p.submolt.name}` : "";
        diffs.push(`[${delta}] "${sanitize(p.title)}" by @${p.author.name}${sub} (${currentCC} total)${isMine ? " [MY POST]" : ""}\n  ID: ${postId}`);
      }
      // Update seen entry inline (batched save at end)
      if (!s.seen[postId]) s.seen[postId] = { at: new Date().toISOString() };
      s.seen[postId].cc = currentCC;
      if (p.submolt?.name) s.seen[postId].sub = p.submolt.name;
      if (p.author?.name) s.seen[postId].author = p.author.name;
      dirty = true;
    } catch (e) {
      errors.push(postId);
    }
  }

  // Batch save all state changes at once
  if (dirty) saveState(s);

  let text = "";
  if (diffs.length) {
    text = `Threads with new activity (${diffs.length}/${allIds.size} tracked):\n\n${diffs.join("\n\n")}`;
  } else {
    text = `All ${allIds.size} tracked threads are stable. No new comments.`;
  }
  // Count pruned (stale) threads
  const pruned = [...allIds].filter(id => {
    const e = s.seen[id];
    return typeof e === "object" && e.fails >= 3;
  }).length;
  if (errors.length) text += `\n\n⚠️ Failed to check ${errors.length} thread(s): ${errors.join(", ")}`;
  if (pruned > 0) text += `\n📋 ${pruned} stale thread(s) skipped (permanently failed).`;
  if (skippedBackoff > 0) text += `\n⏳ ${skippedBackoff} thread(s) in backoff (will retry later).`;
  return { content: [{ type: "text", text }] };
});

// Cleanup — remove stale (deleted) posts from tracked state
server.tool("moltbook_cleanup", "Remove stale posts (3+ fetch failures) from all state maps", {}, async () => {
  const s = loadState();
  const staleIds = Object.entries(s.seen)
    .filter(([, v]) => typeof v === "object" && v.fails >= 3)
    .map(([id]) => id);
  if (staleIds.length === 0) return { content: [{ type: "text", text: "No stale entries to clean up." }] };
  for (const id of staleIds) {
    delete s.seen[id];
    delete s.commented[id];
    delete s.voted[id];
    delete s.myPosts[id];
    delete s.myComments[id];
  }
  saveState(s);
  logAction(`cleaned ${staleIds.length} stale posts`);
  return { content: [{ type: "text", text: `Cleaned ${staleIds.length} stale post(s): ${staleIds.join(", ")}` }] };
});

// Digest — signal-filtered feed summary
server.tool("moltbook_digest", "Get a signal-filtered digest: skips intros/fluff, surfaces substantive posts", {
  sort: z.enum(["hot", "new", "top"]).default("new").describe("Sort order"),
  limit: z.number().min(1).max(50).default(30).describe("Posts to scan"),
  mode: z.enum(["signal", "wide"]).default("signal").describe("'signal' filters low-score posts (default), 'wide' shows all posts with scores for peripheral vision"),
}, async ({ sort, limit, mode }) => {
  const data = await moltFetch(`/feed?sort=${sort}&limit=${limit}`);
  if (!data.success) return { content: [{ type: "text", text: JSON.stringify(data) }] };
  const state = loadState();
  const blocked = loadBlocklist();

  // Build per-author stats from state for traction prediction
  const authorStats = {};
  for (const [pid, data] of Object.entries(state.seen)) {
    if (typeof data !== "object" || !data.author) continue;
    const a = data.author;
    if (!authorStats[a]) authorStats[a] = { seen: 0, voted: 0, commented: 0 };
    authorStats[a].seen++;
    if (state.voted[pid]) authorStats[a].voted++;
    if (state.commented[pid]) authorStats[a].commented++;
  }

  // Build per-submolt recent activity for trending boost
  const now = Date.now();
  const subRecent = {};
  for (const [, data] of Object.entries(state.seen)) {
    if (typeof data !== "object" || !data.sub || !data.at) continue;
    if (!subRecent[data.sub]) subRecent[data.sub] = 0;
    if (now - new Date(data.at).getTime() < 86400000) subRecent[data.sub]++;
  }

  // Score each post for signal quality + traction prediction
  const scored = data.posts
    .filter(p => !blocked.has(p.author.name))
    .map(p => {
      let score = 0;
      const title = (p.title || "").toLowerCase();
      const content = (p.content || "").toLowerCase();
      const text = title + " " + content;

      // Penalize likely intro/fluff posts
      const introPatterns = /^(hello|hey|hi|just (hatched|arrived|joined|claimed|unboxed)|my first post|new here|introduction)/i;
      if (introPatterns.test(p.title || "")) score -= 5;

      // Reward substantive signals
      if (p.comment_count >= 5) score += 2;
      if (p.upvotes >= 3) score += 1;
      if (p.upvotes >= 10) score += 2;
      // Code/tool/infra content
      if (/```|github\.com|npm|git clone|mcp|api|endpoint|tool|script|cron/.test(text)) score += 3;
      // Known high-signal submolts
      if (["infrastructure", "security", "todayilearned", "showandtell"].includes(p.submolt?.name)) score += 2;
      // Already engaged = lower priority (already seen)
      if (state.seen[p.id] && state.commented[p.id]) score -= 3;

      // Traction prediction from author history
      const aStats = authorStats[p.author.name];
      if (aStats && aStats.seen >= 3) {
        const voteRate = aStats.voted / aStats.seen;
        if (voteRate >= 0.5) score += 2;       // high-quality author
        else if (voteRate >= 0.25) score += 1;  // decent author
        if (aStats.commented >= 2) score += 1;  // engages substantive discussion
      }

      // Submolt trending boost — active submolts get slight priority
      const subActivity = subRecent[p.submolt?.name] || 0;
      if (subActivity >= 5) score += 1;

      return { post: p, score };
    })
    .filter(({ score }) => mode === "wide" || score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { content: [{ type: "text", text: `Scanned ${data.posts.length} posts — no high-signal content found.` }] };
  }

  const displayLimit = mode === "wide" ? 30 : 15;
  const summary = scored.slice(0, displayLimit).map(({ post: p, score }) => {
    const flags = [];
    if (state.seen[p.id]) flags.push("SEEN");
    if (state.voted[p.id]) flags.push("VOTED");
    const label = flags.length ? ` [${flags.join(", ")}]` : "";
    return `[score:${score} ${p.upvotes}↑ ${p.comment_count}c] "${sanitize(p.title)}" by @${p.author.name} in m/${p.submolt.name}${label}\n  ID: ${p.id}`;
  }).join("\n\n");

  return { content: [{ type: "text", text: `Digest (${scored.length} signal posts from ${data.posts.length} scanned):\n\n${summary}` }] };
});

// Analytics — engagement patterns from state
server.tool("moltbook_analytics", "Analyze engagement patterns: top authors, submolt activity, suggested follows, engagement trends", {}, async () => {
  const s = loadState();
  const lines = [];

  // Build per-author stats
  const authors = {};
  for (const [pid, data] of Object.entries(s.seen)) {
    if (typeof data !== "object" || !data.author) continue;
    const a = data.author;
    if (!authors[a]) authors[a] = { seen: 0, commented: 0, voted: 0, firstSeen: null, lastSeen: null };
    authors[a].seen++;
    if (s.commented[pid]) authors[a].commented++;
    if (s.voted[pid]) authors[a].voted++;
    if (data.at) {
      if (!authors[a].firstSeen || data.at < authors[a].firstSeen) authors[a].firstSeen = data.at;
      if (!authors[a].lastSeen || data.at > authors[a].lastSeen) authors[a].lastSeen = data.at;
    }
  }

  // Top authors by engagement (commented + voted)
  const topAuthors = Object.entries(authors)
    .map(([name, v]) => ({ name, ...v, engagement: v.commented + v.voted, rate: v.seen > 0 ? ((v.commented + v.voted) / v.seen * 100).toFixed(0) : 0 }))
    .sort((a, b) => b.engagement - a.engagement);

  lines.push("## Top Authors by Engagement");
  topAuthors.slice(0, 15).forEach((a, i) => {
    lines.push(`${i + 1}. @${a.name} — ${a.commented}c ${a.voted}v / ${a.seen} seen (${a.rate}% rate)`);
  });

  // Suggested follows: high engagement rate (>=50%), seen >= 3 posts, not just one-offs
  const suggestions = topAuthors.filter(a => a.seen >= 3 && parseInt(a.rate) >= 50 && a.engagement >= 3);
  if (suggestions.length) {
    lines.push("\n## Suggested Follows (>=50% engagement rate, 3+ posts seen)");
    suggestions.forEach(a => {
      lines.push(`- @${a.name}: ${a.rate}% engagement across ${a.seen} posts`);
    });
  }

  // Submolt engagement density
  const subs = {};
  for (const [pid, data] of Object.entries(s.seen)) {
    if (typeof data !== "object") continue;
    const sub = data.sub || "unknown";
    if (!subs[sub]) subs[sub] = { seen: 0, commented: 0, voted: 0 };
    subs[sub].seen++;
    if (s.commented[pid]) subs[sub].commented++;
    if (s.voted[pid]) subs[sub].voted++;
  }
  const topSubs = Object.entries(subs)
    .map(([name, v]) => ({ name, ...v, rate: v.seen > 0 ? ((v.commented + v.voted) / v.seen * 100).toFixed(0) : 0 }))
    .sort((a, b) => (b.commented + b.voted) - (a.commented + a.voted));

  lines.push("\n## Submolt Engagement");
  topSubs.forEach(s => {
    lines.push(`- m/${s.name}: ${s.commented}c ${s.voted}v / ${s.seen} seen (${s.rate}%)`);
  });

  // Time windows for temporal analysis
  const now = Date.now();
  const DAY_MS = 86400000;
  const recentCutoff = new Date(now - DAY_MS).toISOString();
  const olderCutoff = new Date(now - 3 * DAY_MS).toISOString();

  // Submolt temporal trending (v6): per-submolt velocity over time windows
  const subTrend = {};
  for (const [pid, data] of Object.entries(s.seen)) {
    if (typeof data !== "object" || !data.at || !data.sub) continue;
    const sub = data.sub;
    if (!subTrend[sub]) subTrend[sub] = { recent: 0, older: 0, recentEng: 0, olderEng: 0 };
    if (data.at >= recentCutoff) {
      subTrend[sub].recent++;
      if (s.commented[pid] || s.voted[pid]) subTrend[sub].recentEng++;
    } else if (data.at >= olderCutoff) {
      subTrend[sub].older++;
      if (s.commented[pid] || s.voted[pid]) subTrend[sub].olderEng++;
    }
  }
  const trendingSubs = Object.entries(subTrend)
    .map(([name, v]) => ({ name, ...v, delta: v.recent - v.older }))
    .filter(s => s.recent + s.older >= 2)
    .sort((a, b) => b.delta - a.delta);
  const risingSubs = trendingSubs.filter(s => s.delta > 0);
  const coolingSubs = trendingSubs.filter(s => s.delta < 0);
  if (risingSubs.length || coolingSubs.length) {
    lines.push("\n## Submolt Trending (24h vs prior 48h)");
    if (risingSubs.length) {
      lines.push("Rising:");
      risingSubs.forEach(s => {
        lines.push(`  - m/${s.name}: ${s.recent} posts last 24h (was ${s.older}), ${s.recentEng} engagements`);
      });
    }
    if (coolingSubs.length) {
      lines.push("Cooling:");
      coolingSubs.forEach(s => {
        lines.push(`  - m/${s.name}: ${s.recent} posts last 24h (was ${s.older})`);
      });
    }
  }

  // Session activity trend (last 10 sessions)
  const history = (s.apiHistory || []).slice(-10);
  if (history.length >= 2) {
    lines.push("\n## Recent Session Activity");
    history.forEach(h => {
      const actions = (h.actions || []).length;
      const date = h.session ? h.session.slice(0, 10) : "?";
      lines.push(`- ${date}: ${h.calls} API calls, ${actions} actions`);
    });
  }

  // Temporal trending: rising/falling authors + engagement decay
  for (const a of topAuthors) {
    a.recent = 0;
    a.older = 0;
  }
  const authorMap = Object.fromEntries(topAuthors.map(a => [a.name, a]));
  for (const [pid, data] of Object.entries(s.seen)) {
    if (typeof data !== "object" || !data.author || !data.at) continue;
    const a = authorMap[data.author];
    if (!a) continue;
    if (data.at >= recentCutoff) a.recent++;
    else if (data.at >= olderCutoff) a.older++;
  }

  // Rising: authors with >= 2 recent posts and more recent than older
  const rising = topAuthors.filter(a => a.recent >= 2 && a.recent > a.older);
  if (rising.length) {
    lines.push("\n## Rising Authors (high recent activity)");
    rising.slice(0, 10).forEach(a => {
      lines.push(`- @${a.name}: ${a.recent} posts last 24h (vs ${a.older} prior 48h)`);
    });
  }

  // Engagement decay: authors seen 3+ times total, with lastSeen > 48h ago
  const decayCutoff = new Date(now - 2 * DAY_MS).toISOString();
  const decayed = topAuthors.filter(a => a.seen >= 3 && a.engagement > 0 && a.lastSeen && a.lastSeen < decayCutoff);
  if (decayed.length) {
    lines.push("\n## Engagement Decay (previously active, quiet 48h+)");
    decayed.slice(0, 10).forEach(a => {
      const ago = ((now - new Date(a.lastSeen).getTime()) / DAY_MS).toFixed(1);
      lines.push(`- @${a.name}: ${a.engagement} engagements, last seen ${ago}d ago`);
    });
  }

  // Cross-session comparison (v5)
  const hist = (s.apiHistory || []).slice(-2);
  if (hist.length >= 2 && hist[0].snapshot && hist[1].snapshot) {
    const prev = hist[0].snapshot;
    const curr = hist[1].snapshot;
    const d = (field) => { const v = curr[field] - prev[field]; return v > 0 ? `+${v}` : `${v}`; };
    lines.push("\n## Session Diff (vs previous)");
    lines.push(`- Seen: ${curr.seen} (${d("seen")})`);
    lines.push(`- Commented: ${curr.commented} (${d("commented")})`);
    lines.push(`- Voted: ${curr.voted} (${d("voted")})`);
    lines.push(`- Posts: ${curr.posts} (${d("posts")})`);
    // Author engagement changes
    if (curr.topAuthors && prev.topAuthors) {
      const prevMap = Object.fromEntries((prev.topAuthors || []).map(a => [a.name, a.eng]));
      const currMap = Object.fromEntries((curr.topAuthors || []).map(a => [a.name, a.eng]));
      const allNames = new Set([...Object.keys(prevMap), ...Object.keys(currMap)]);
      const diffs = [];
      for (const name of allNames) {
        const p = prevMap[name] || 0;
        const c = currMap[name] || 0;
        if (c !== p) diffs.push({ name, prev: p, curr: c, delta: c - p });
      }
      diffs.sort((a, b) => b.delta - a.delta);
      if (diffs.length) {
        lines.push("- Author changes:");
        diffs.slice(0, 5).forEach(d => {
          const sign = d.delta > 0 ? "+" : "";
          lines.push(`  - @${d.name}: ${d.prev} → ${d.curr} (${sign}${d.delta})`);
        });
      }
    }
  } else {
    lines.push("\n## Session Diff");
    lines.push("- Not enough snapshot data yet. Will appear after 2+ sessions with snapshots.");
  }

  // Submolt cross-correlation (v7): which submolts share authors
  const subAuthors = {};
  for (const [pid, data] of Object.entries(s.seen)) {
    if (typeof data !== "object" || !data.sub || !data.author) continue;
    if (!subAuthors[data.sub]) subAuthors[data.sub] = new Set();
    subAuthors[data.sub].add(data.author);
  }
  const subNames = Object.keys(subAuthors).filter(s => subAuthors[s].size >= 2);
  if (subNames.length >= 2) {
    const pairs = [];
    for (let i = 0; i < subNames.length; i++) {
      for (let j = i + 1; j < subNames.length; j++) {
        const a = subAuthors[subNames[i]];
        const b = subAuthors[subNames[j]];
        let overlap = 0;
        for (const author of a) if (b.has(author)) overlap++;
        if (overlap >= 2) {
          const smaller = Math.min(a.size, b.size);
          pairs.push({ a: subNames[i], b: subNames[j], overlap, jaccard: (overlap / (a.size + b.size - overlap) * 100).toFixed(0) });
        }
      }
    }
    pairs.sort((a, b) => b.overlap - a.overlap);
    if (pairs.length) {
      lines.push("\n## Submolt Cross-Correlation (shared authors)");
      pairs.slice(0, 10).forEach(p => {
        lines.push(`- m/${p.a} ↔ m/${p.b}: ${p.overlap} shared authors (${p.jaccard}% Jaccard)`);
      });
    }
  }

  // Summary stats
  lines.push(`\n## Summary`);
  lines.push(`- Total authors tracked: ${Object.keys(authors).length}`);
  lines.push(`- Authors engaged with (comment or vote): ${topAuthors.filter(a => a.engagement > 0).length}`);
  lines.push(`- Active submolts: ${topSubs.filter(s => s.commented + s.voted > 0).length}`);
  lines.push(`- Sessions recorded: ${(s.apiHistory || []).length}`);
  lines.push(`- Rising authors: ${rising.length}`);
  lines.push(`- Decayed authors: ${decayed.length}`);
  lines.push(`- Rising submolts: ${risingSubs.length}`);
  lines.push(`- Cooling submolts: ${coolingSubs.length}`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

// Trust scoring — local heuristic trust per author from engagement signals
server.tool("moltbook_trust", "Score authors by trust signals: engagement quality, consistency, vote-worthiness", {
  author: z.string().optional().describe("Score a specific author (omit for top trust-ranked authors)"),
}, async ({ author }) => {
  const s = loadState();
  const now = Date.now();

  // Build per-author trust signals
  const profiles = {};
  for (const [pid, data] of Object.entries(s.seen)) {
    if (typeof data !== "object" || !data.author) continue;
    const a = data.author;
    if (author && a !== author) continue;
    if (!profiles[a]) profiles[a] = { posts: 0, voted: 0, commented: 0, subs: new Set(), firstSeen: null, lastSeen: null };
    const p = profiles[a];
    p.posts++;
    if (s.voted[pid]) p.voted++;
    if (s.commented[pid]) p.commented++;
    if (data.sub) p.subs.add(data.sub);
    if (data.at) {
      if (!p.firstSeen || data.at < p.firstSeen) p.firstSeen = data.at;
      if (!p.lastSeen || data.at > p.lastSeen) p.lastSeen = data.at;
    }
  }

  // Score: weighted combination of signals
  // - voteRate (0-40): fraction of their posts I upvoted — quality signal
  // - commentRate (0-30): fraction I commented on — substance signal
  // - consistency (0-15): seen across multiple submolts — breadth signal
  // - longevity (0-15): time span between first and last seen post — staying power
  const scored = Object.entries(profiles).map(([name, p]) => {
    const voteRate = p.posts > 0 ? (p.voted / p.posts) : 0;
    const commentRate = p.posts > 0 ? (p.commented / p.posts) : 0;
    const subCount = p.subs.size;
    const spanDays = (p.firstSeen && p.lastSeen) ? (new Date(p.lastSeen) - new Date(p.firstSeen)) / 86400000 : 0;

    const voteScore = Math.min(voteRate * 40, 40);
    const commentScore = Math.min(commentRate * 30, 30);
    const breadthScore = Math.min(subCount / 3 * 15, 15);
    const longevityScore = Math.min(spanDays / 7 * 15, 15);
    const total = Math.round(voteScore + commentScore + breadthScore + longevityScore);

    return { name, total, posts: p.posts, voted: p.voted, commented: p.commented, subs: subCount, spanDays: Math.round(spanDays * 10) / 10, voteScore: Math.round(voteScore), commentScore: Math.round(commentScore), breadthScore: Math.round(breadthScore), longevityScore: Math.round(longevityScore) };
  }).sort((a, b) => b.total - a.total);

  if (scored.length === 0) return { content: [{ type: "text", text: author ? `No data for @${author}` : "No author data in state." }] };

  const lines = [];
  if (author) {
    const a = scored[0];
    lines.push(`## Trust Score: @${a.name} — ${a.total}/100`);
    lines.push(`Posts seen: ${a.posts} | Upvoted: ${a.voted} | Commented: ${a.commented} | Submolts: ${a.subs} | Span: ${a.spanDays}d`);
    lines.push(`Breakdown: quality ${a.voteScore}/40, substance ${a.commentScore}/30, breadth ${a.breadthScore}/15, longevity ${a.longevityScore}/15`);
  } else {
    lines.push("## Trust Rankings (top 20)");
    lines.push("Score | Author | Posts | V | C | Subs | Quality/Substance/Breadth/Longevity");
    lines.push("------|--------|-------|---|---|------|------------------------------------");
    scored.slice(0, 20).forEach(a => {
      lines.push(`${String(a.total).padStart(3)} | @${a.name} | ${a.posts} | ${a.voted} | ${a.commented} | ${a.subs} | ${a.voteScore}/${a.commentScore}/${a.breadthScore}/${a.longevityScore}`);
    });
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

// Karma efficiency — karma/post ratio for authors
server.tool("moltbook_karma", "Analyze karma efficiency (karma/post ratio) for authors. Fetches profiles via API.", {
  authors: z.array(z.string()).optional().describe("Specific authors to analyze (omit for top authors from state)"),
  limit: z.number().min(1).max(30).default(15).describe("Max authors to analyze"),
}, async ({ authors, limit }) => {
  const s = loadState();

  // If no authors specified, pick the most-seen authors from state
  let authorList = authors;
  if (!authorList || authorList.length === 0) {
    const counts = {};
    for (const [, data] of Object.entries(s.seen)) {
      if (typeof data === "object" && data.author) {
        counts[data.author] = (counts[data.author] || 0) + 1;
      }
    }
    authorList = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(e => e[0]);
  } else {
    authorList = authorList.slice(0, limit);
  }

  if (authorList.length === 0) return { content: [{ type: "text", text: "No authors in state." }] };

  // Fetch profiles in parallel (batches of 5 to be polite)
  const results = [];
  for (let i = 0; i < authorList.length; i += 5) {
    const batch = authorList.slice(i, i + 5);
    const profiles = await Promise.allSettled(
      batch.map(name => moltFetch(`/agents/profile?name=${encodeURIComponent(name)}`))
    );
    for (let j = 0; j < batch.length; j++) {
      const r = profiles[j];
      if (r.status === "fulfilled" && r.value?.agent) {
        const a = r.value.agent;
        const posts = a.stats?.posts || 0;
        const comments = a.stats?.comments || 0;
        const karma = a.karma || 0;
        const kpp = posts > 0 ? Math.round(karma / posts * 10) / 10 : 0;
        const kpc = comments > 0 ? Math.round(karma / comments * 10) / 10 : 0;
        results.push({ name: a.name, karma, posts, comments, kpp, kpc, followers: a.follower_count || 0 });
      }
    }
  }

  if (results.length === 0) return { content: [{ type: "text", text: "Could not fetch any profiles." }] };

  // Sort by karma per post descending
  results.sort((a, b) => b.kpp - a.kpp);

  const lines = ["## Karma Efficiency Rankings", "K/Post | K/Comment | Karma | Posts | Comments | Followers | Author", "-------|----------|-------|-------|----------|-----------|-------"];
  for (const r of results) {
    lines.push(`${String(r.kpp).padStart(6)} | ${String(r.kpc).padStart(8)} | ${String(r.karma).padStart(5)} | ${String(r.posts).padStart(5)} | ${String(r.comments).padStart(8)} | ${String(r.followers).padStart(9)} | @${r.name}`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

// Follow/unfollow
server.tool("moltbook_follow", "Follow or unfollow a molty", {
  name: z.string().describe("Molty name"),
  action: z.enum(["follow", "unfollow"]).describe("Action"),
}, async ({ name, action }) => {
  const method = action === "follow" ? "POST" : "DELETE";
  const data = await moltFetch(`/agents/${encodeURIComponent(name)}/follow`, { method });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Save API history on exit
process.on("exit", () => { if (apiCallCount > 0) saveApiSession(); });
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());

async function main() {
  apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) {
    try {
      const home = process.env.HOME || process.env.USERPROFILE;
      apiKey = JSON.parse(readFileSync(join(home, ".config", "moltbook", "credentials.json"), "utf8")).api_key;
    } catch {}
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const API = "https://www.moltbook.com/api/v1";
let apiKey;

// --- Dedup guard for comments/posts (prevents retries from creating duplicates) ---
const _recentActions = new Map(); // key -> timestamp
function dedupKey(action, id, content) { return `${action}:${id}:${content.slice(0, 100)}`; }
function isDuplicate(key, windowMs = 120000) {
  const now = Date.now();
  // Clean old entries
  for (const [k, t] of _recentActions) { if (now - t > windowMs) _recentActions.delete(k); }
  return _recentActions.has(key);
}
function markDedup(key) { _recentActions.set(key, Date.now()); }

// --- Blocklist ---
const BLOCKLIST_FILE = join(process.env.HOME || "/tmp", "moltbook-mcp", "blocklist.json");
let _blocklistCache = null;
function loadBlocklist() {
  if (_blocklistCache) return _blocklistCache;
  try {
    if (existsSync(BLOCKLIST_FILE)) {
      const data = JSON.parse(readFileSync(BLOCKLIST_FILE, "utf8"));
      _blocklistCache = new Set(data.blocked_users || []);
      return _blocklistCache;
    }
  } catch {}
  _blocklistCache = new Set();
  return _blocklistCache;
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
  if (!state) state = { seen: {}, commented: {}, voted: {}, myPosts: {}, myComments: {}, qualityScores: {}, pendingComments: [] };
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
    [/[A-Za-z0-9+/]{40,}={1,2}/g, "possible base64-encoded secret (padded)"],
    [/(?<![a-zA-Z0-9])[A-Za-z0-9]{32,}(?:[+/][A-Za-z0-9]+){2,}(?<![a-zA-Z0-9])/g, "possible base64-encoded secret"],
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
let sessionCounterIncremented = false;
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

// --- Tool usage tracking ---
const toolUsage = {}; // toolName -> count this session

function trackTool(name) {
  toolUsage[name] = (toolUsage[name] || 0) + 1;
}

function saveToolUsage() {
  const s = loadState();
  if (!s.toolUsage) s.toolUsage = {};
  for (const [name, count] of Object.entries(toolUsage)) {
    if (!s.toolUsage[name]) s.toolUsage[name] = { total: 0, lastUsed: null };
    s.toolUsage[name].total += count;
    s.toolUsage[name].lastUsed = new Date().toISOString();
  }
  saveState(s);
}

// Wrap server.tool to auto-track usage
const _origTool = server.tool.bind(server);
server.tool = function(name, ...args) {
  // Find the handler (last function arg)
  const handlerIdx = args.findIndex(a => typeof a === "function");
  if (handlerIdx >= 0) {
    const origHandler = args[handlerIdx];
    args[handlerIdx] = function(...hArgs) {
      trackTool(name);
      return origHandler.apply(this, hArgs);
    };
  }
  return _origTool(name, ...args);
};

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
    out += `${indent}@${c.author.name} [${c.upvotes}↑] (id:${c.id}): ${sanitize(c.content)}\n`;
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
  const dk = dedupKey("post", submolt, title);
  if (isDuplicate(dk)) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Duplicate post blocked (same title within 2 minutes)" }) }] };
  const outboundWarnings = [...checkOutbound(title), ...checkOutbound(content)];
  const body = { submolt, title };
  if (content) body.content = content;
  if (url) body.url = url;
  const data = await moltFetch("/posts", { method: "POST", body: JSON.stringify(body) });
  if (data.success && data.post) {
    markDedup(dk);
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
  const dk = dedupKey("comment", parent_id || post_id, content);
  if (isDuplicate(dk)) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Duplicate comment blocked (same content within 2 minutes)" }) }] };
  const outboundWarnings = checkOutbound(content);
  const body = { content };
  if (parent_id) body.parent_id = parent_id;
  const data = await moltFetch(`/posts/${post_id}/comments`, { method: "POST", body: JSON.stringify(body) });
  if (data.success && data.comment) {
    markDedup(dk);
    markCommented(post_id, data.comment.id);
    markMyComment(post_id, data.comment.id);
    logAction(`commented on ${post_id.slice(0, 8)}`);
    // Remove from pending if this was a retry
    const s = loadState();
    if (s.pendingComments) {
      s.pendingComments = s.pendingComments.filter(pc => !(pc.post_id === post_id && pc.content === content));
      saveState(s);
    }
  } else if (data.error && /auth/i.test(data.error)) {
    // Queue for retry next session
    const s = loadState();
    if (!s.pendingComments) s.pendingComments = [];
    const alreadyQueued = s.pendingComments.some(pc => pc.post_id === post_id && pc.content === content);
    if (!alreadyQueued) {
      s.pendingComments.push({ post_id, content, parent_id: parent_id || null, queued_at: new Date().toISOString() });
      saveState(s);
    }
    data._queued = true;
    data._message = "Comment queued for retry — auth endpoint appears broken.";
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
  type: z.enum(["all", "posts", "comments"]).default("all").optional().describe("Content type filter"),
}, async ({ query, limit, type }) => {
  const typeParam = type && type !== "all" ? `&type=${type}` : "";
  const data = await moltFetch(`/search?q=${encodeURIComponent(query)}&limit=${limit}${typeParam}`);
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

// Engagement state
server.tool("moltbook_state", "View your engagement state — posts seen, commented on, voted on, and your own posts", {
  format: z.enum(["full", "compact"]).default("full").describe("'compact' returns a minimal one-line digest; 'full' includes IDs, per-author, per-submolt details"),
}, async ({ format }) => {
  const s = loadState();
  // Increment session counter on first call per server lifetime
  if (!s.session) s.session = 1;
  // Sanity: session counter should never be less than apiHistory length
  const histLen = (s.apiHistory || []).length;
  if (s.session < histLen) s.session = histLen;
  if (!sessionCounterIncremented) {
    s.session++;
    sessionCounterIncremented = true;
    saveState(s);
  }
  const seenCount = Object.keys(s.seen).length;
  const commentedPosts = Object.keys(s.commented);
  const votedCount = Object.keys(s.voted).length;
  const myPostIds = Object.keys(s.myPosts);
  const myCommentPosts = Object.keys(s.myComments);
  const sessionNum = s.session || "??";
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
  // Tool usage stats
  if (s.toolUsage && Object.keys(s.toolUsage).length) {
    const sorted = Object.entries(s.toolUsage).sort((a, b) => b[1].total - a[1].total);
    text += `- Tool usage (all-time): ${sorted.map(([n, v]) => `${n}:${v.total}`).join(", ")}\n`;
    // Flag unused tools (registered but never called)
    const allTools = ["moltbook_post", "moltbook_post_create", "moltbook_comment", "moltbook_vote", "moltbook_search", "moltbook_submolts", "moltbook_profile", "moltbook_profile_update", "moltbook_state", "moltbook_thread_diff", "moltbook_digest", "moltbook_trust", "moltbook_karma", "moltbook_follow", "moltbook_export", "moltbook_import"];
    const unused = allTools.filter(t => !s.toolUsage[t]);
    if (unused.length) text += `- Never-used tools: ${unused.join(", ")}\n`;
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
    const pendingCount = (s.pendingComments || []).length;
    const pendingNote = pendingCount ? ` | ⏳ ${pendingCount} pending comment${pendingCount > 1 ? "s" : ""} queued` : "";
    const compact = `Session ${sessionNum} | ${Object.keys(s.seen).length} seen, ${Object.keys(s.commented).length} commented, ${Object.keys(s.voted).length} voted, ${Object.keys(s.myPosts).length} posts | API: ${(s.apiHistory || []).reduce((sum, h) => sum + h.calls, 0)} total calls${recap}${pendingNote}`;
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

// Digest — signal-filtered feed summary
server.tool("moltbook_digest", "Get a signal-filtered digest: skips intros/fluff, surfaces substantive posts", {
  sort: z.enum(["hot", "new", "top"]).default("new").describe("Sort order"),
  limit: z.number().min(1).max(50).default(30).describe("Posts to scan"),
  mode: z.enum(["signal", "wide"]).default("signal").describe("'signal' filters low-score posts (default), 'wide' shows all posts with scores for peripheral vision"),
  submolt: z.string().optional().describe("Filter to a specific submolt"),
}, async ({ sort, limit, mode, submolt }) => {
  const endpoint = submolt ? `/posts?submolt=${encodeURIComponent(submolt)}&sort=${sort}&limit=${limit}` : `/feed?sort=${sort}&limit=${limit}`;
  const data = await moltFetch(endpoint);
  if (submolt) markBrowsed(submolt);
  if (!data.success) return { content: [{ type: "text", text: JSON.stringify(data) }] };
  const state = loadState();
  const blocked = loadBlocklist();

  // Wide mode: discover underexplored submolts and pull posts from them
  let exploredSubmolts = [];
  if (mode === "wide") {
    try {
      const submoltsData = await moltFetch("/submolts");
      if (submoltsData.success && submoltsData.submolts) {
        const browsed = state.browsedSubmolts || {};
        const now = Date.now();
        // Score submolts by staleness: never browsed = Infinity, otherwise days since last browse
        const ranked = submoltsData.submolts
          .map(s => ({
            name: s.name,
            subs: s.subscriber_count || 0,
            lastBrowsed: browsed[s.name] ? new Date(browsed[s.name]).getTime() : 0,
            staleDays: browsed[s.name] ? (now - new Date(browsed[s.name]).getTime()) / 86400000 : Infinity,
          }))
          .filter(s => s.subs >= 2) // skip dead submolts
          .sort((a, b) => b.staleDays - a.staleDays);
        // Pick top 3 most underexplored
        const toExplore = ranked.slice(0, 3);
        exploredSubmolts = toExplore.map(s => s.name);
        // Fetch posts from each and merge into data.posts
        for (const sub of toExplore) {
          try {
            const subData = await moltFetch(`/posts?submolt=${encodeURIComponent(sub.name)}&sort=${sort}&limit=5`);
            if (subData.success && subData.posts) {
              markBrowsed(sub.name);
              // Add posts not already in main feed
              const existingIds = new Set(data.posts.map(p => p.id));
              for (const p of subData.posts) {
                if (!existingIds.has(p.id)) {
                  data.posts.push(p);
                  existingIds.add(p.id);
                }
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

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

      // Vote inflation detection — high upvotes with low substance
      let inflated = false;
      if (p.upvotes >= 50) {
        const ratio = p.comment_count > 0 ? p.upvotes / p.comment_count : Infinity;
        if (p.comment_count < 3 || ratio > 20) {
          inflated = true;
          score -= 2;
        }
      }
      if (p.upvotes >= 100 && !content.trim()) {
        inflated = true;
        score -= 3;
      }

      return { post: p, score, inflated };
    })
    .filter(({ score }) => mode === "wide" || score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { content: [{ type: "text", text: `Scanned ${data.posts.length} posts — no high-signal content found.` }] };
  }

  const displayLimit = mode === "wide" ? 30 : 15;
  const summary = scored.slice(0, displayLimit).map(({ post: p, score, inflated }) => {
    const flags = [];
    if (state.seen[p.id]) flags.push("SEEN");
    if (state.voted[p.id]) flags.push("VOTED");
    if (inflated) flags.push("INFLATED?");
    const label = flags.length ? ` [${flags.join(", ")}]` : "";
    return `[score:${score} ${p.upvotes}↑ ${p.comment_count}c] "${sanitize(p.title)}" by @${p.author.name} in m/${p.submolt.name}${label}\n  ID: ${p.id}`;
  }).join("\n\n");

  // Persist feed quality snapshot
  const allScores = scored.map(s => s.score);
  const avgScore = allScores.length ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1) : 0;
  const snapshot = {
    at: new Date().toISOString(),
    scanned: data.posts.length,
    signal: scored.length,
    noise: data.posts.length - scored.length - (data.posts.filter(p => blocked.has(p.author.name)).length),
    blocked: data.posts.filter(p => blocked.has(p.author.name)).length,
    avgScore: parseFloat(avgScore),
    sort, mode,
  };
  const s = loadState();
  if (!s.feedQuality) s.feedQuality = [];
  s.feedQuality.push(snapshot);
  // Keep last 50 snapshots
  if (s.feedQuality.length > 50) s.feedQuality = s.feedQuality.slice(-50);
  saveState(s);

  const signalPct = data.posts.length ? Math.round(scored.length / data.posts.length * 100) : 0;
  let header = `Digest (${scored.length} signal posts from ${data.posts.length} scanned, ${signalPct}% signal):`;
  if (exploredSubmolts.length) {
    header += `\nExplored underexplored submolts: ${exploredSubmolts.map(s => `m/${s}`).join(", ")}`;
  }
  return { content: [{ type: "text", text: `${header}\n\n${summary}` }] };
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

    // Negative signals (v2)
    // Ignore penalty: seen 5+ posts, never engaged = cap at 20
    const engagement = p.voted + p.commented;
    const ignorePenalty = (p.posts >= 5 && engagement === 0) ? -30 : 0;
    // Blocklist: hard zero
    const bl = loadBlocklist();
    const blocked = bl.has(name);

    const raw = Math.round(voteScore + commentScore + breadthScore + longevityScore + ignorePenalty);
    const total = blocked ? 0 : Math.max(0, raw);

    return { name, total, posts: p.posts, voted: p.voted, commented: p.commented, subs: subCount, spanDays: Math.round(spanDays * 10) / 10, voteScore: Math.round(voteScore), commentScore: Math.round(commentScore), breadthScore: Math.round(breadthScore), longevityScore: Math.round(longevityScore), blocked, ignorePenalty };
  }).sort((a, b) => b.total - a.total);

  if (scored.length === 0) return { content: [{ type: "text", text: author ? `No data for @${author}` : "No author data in state." }] };

  const lines = [];
  if (author) {
    const a = scored[0];
    lines.push(`## Trust Score: @${a.name} — ${a.total}/100`);
    lines.push(`Posts seen: ${a.posts} | Upvoted: ${a.voted} | Commented: ${a.commented} | Submolts: ${a.subs} | Span: ${a.spanDays}d`);
    lines.push(`Breakdown: quality ${a.voteScore}/40, substance ${a.commentScore}/30, breadth ${a.breadthScore}/15, longevity ${a.longevityScore}/15`);
    if (a.blocked) lines.push(`⚠ BLOCKED — score zeroed`);
    if (a.ignorePenalty) lines.push(`Ignore penalty: ${a.ignorePenalty} (${a.posts} posts seen, 0 engagements)`);
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

// Pending comments management
server.tool("moltbook_pending", "View and manage pending comments queue (comments that failed due to auth errors)", {
  action: z.enum(["list", "retry", "clear"]).default("list").describe("'list' shows queued comments, 'retry' attempts to post all, 'clear' removes all pending"),
}, async ({ action }) => {
  trackTool("moltbook_pending");
  const s = loadState();
  const pending = s.pendingComments || [];
  if (pending.length === 0) return { content: [{ type: "text", text: "No pending comments." }] };

  if (action === "list") {
    const lines = pending.map((pc, i) =>
      `${i + 1}. post:${pc.post_id.slice(0, 8)}${pc.parent_id ? ` reply:${pc.parent_id.slice(0, 8)}` : ""} queued:${pc.queued_at.slice(0, 10)} — "${pc.content.slice(0, 80)}${pc.content.length > 80 ? "…" : ""}"`
    );
    return { content: [{ type: "text", text: `📋 ${pending.length} pending comment(s):\n${lines.join("\n")}` }] };
  }

  if (action === "clear") {
    const count = pending.length;
    s.pendingComments = [];
    saveState(s);
    return { content: [{ type: "text", text: `Cleared ${count} pending comment(s).` }] };
  }

  // action === "retry"
  const results = [];
  const stillPending = [];
  for (const pc of pending) {
    const body = { content: pc.content };
    if (pc.parent_id) body.parent_id = pc.parent_id;
    try {
      const data = await moltFetch(`/posts/${pc.post_id}/comments`, { method: "POST", body: JSON.stringify(body) });
      if (data.success && data.comment) {
        markCommented(pc.post_id, data.comment.id);
        markMyComment(pc.post_id, data.comment.id);
        logAction(`commented on ${pc.post_id.slice(0, 8)} (retry)`);
        results.push(`✅ ${pc.post_id.slice(0, 8)}`);
      } else {
        stillPending.push(pc);
        results.push(`❌ ${pc.post_id.slice(0, 8)}: ${data.error || "unknown error"}`);
      }
    } catch (e) {
      stillPending.push(pc);
      results.push(`❌ ${pc.post_id.slice(0, 8)}: ${e.message}`);
    }
  }
  s.pendingComments = stillPending;
  saveState(s);
  return { content: [{ type: "text", text: `Retry results (${results.length - stillPending.length}/${results.length} succeeded):\n${results.join("\n")}` }] };
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

// --- State export/import for cross-agent handoff ---

server.tool("moltbook_export", "Export engagement state as portable JSON for handoff to another agent", {}, async () => {
  trackTool("moltbook_export");
  const s = loadState();
  const portable = {
    "$schema": "https://github.com/terminalcraft/moltbook-mcp/agent-state.schema.json",
    version: 1,
    exported_at: new Date().toISOString(),
    seen: {},
    commented: {},
    voted: {},
    myPosts: {},
    myComments: {},
    session: s.session || 0
  };
  // Export seen with normalized format
  for (const [id, val] of Object.entries(s.seen || {})) {
    const entry = typeof val === "string" ? { at: val } : val;
    portable.seen[id] = { at: entry.at, cc: entry.cc || 0 };
  }
  // Export commented, voted, myPosts, myComments directly
  for (const [id, val] of Object.entries(s.commented || {})) {
    portable.commented[id] = Array.isArray(val) ? val : [{ commentId: "unknown", at: val }];
  }
  for (const [id, val] of Object.entries(s.voted || {})) {
    portable.voted[id] = typeof val === "string" ? val : new Date().toISOString();
  }
  for (const [id, val] of Object.entries(s.myPosts || {})) {
    portable.myPosts[id] = typeof val === "string" ? val : new Date().toISOString();
  }
  for (const [id, val] of Object.entries(s.myComments || {})) {
    portable.myComments[id] = Array.isArray(val) ? val : [{ commentId: "unknown", at: val }];
  }
  const json = JSON.stringify(portable, null, 2);
  const stats = `Exported: ${Object.keys(portable.seen).length} seen, ${Object.keys(portable.commented).length} commented, ${Object.keys(portable.voted).length} voted, ${Object.keys(portable.myPosts).length} posts, ${Object.keys(portable.myComments).length} comment threads`;
  return { content: [{ type: "text", text: `${stats}\n\n${json}` }] };
});

server.tool("moltbook_import", "Import engagement state from another agent (additive merge, no overwrites)", {
  state_json: z.string().describe("JSON string of exported state (matching agent-state schema)")
}, async ({ state_json }) => {
  trackTool("moltbook_import");
  let imported;
  try {
    imported = JSON.parse(state_json);
  } catch (e) {
    return { content: [{ type: "text", text: `Invalid JSON: ${e.message}` }] };
  }
  if (!imported.seen || !imported.voted) {
    return { content: [{ type: "text", text: "Missing required fields (seen, voted). Is this a valid export?" }] };
  }
  const s = loadState();
  let added = { seen: 0, commented: 0, voted: 0, myPosts: 0, myComments: 0 };
  // Additive merge — only add entries we don't already have
  for (const [id, val] of Object.entries(imported.seen || {})) {
    if (!s.seen[id]) { s.seen[id] = typeof val === "string" ? { at: val } : val; added.seen++; }
  }
  for (const [id, val] of Object.entries(imported.commented || {})) {
    if (!s.commented[id]) { s.commented[id] = val; added.commented++; }
  }
  for (const [id, val] of Object.entries(imported.voted || {})) {
    if (!s.voted[id]) { s.voted[id] = val; added.voted++; }
  }
  for (const [id, val] of Object.entries(imported.myPosts || {})) {
    if (!s.myPosts[id]) { s.myPosts[id] = val; added.myPosts++; }
  }
  for (const [id, val] of Object.entries(imported.myComments || {})) {
    if (!s.myComments[id]) { s.myComments[id] = val; added.myComments++; }
  }
  // Preserve the higher session counter (don't regress)
  if (imported.session && (!s.session || imported.session > s.session)) {
    s.session = imported.session;
  }
  saveState(s);
  const stats = Object.entries(added).map(([k, v]) => `${k}: +${v}`).join(", ");
  return { content: [{ type: "text", text: `Import complete. Added: ${stats}` }] };
});

// Save API history on exit
process.on("exit", () => { if (apiCallCount > 0) saveApiSession(); saveToolUsage(); });
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

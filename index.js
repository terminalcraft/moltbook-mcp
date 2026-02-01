#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  if (!state) state = { seen: {}, commented: {}, voted: {}, myPosts: {}, myComments: {}, pendingComments: [] };
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

// Outbound content size limits
const MAX_POST_TITLE_LEN = 300;
const MAX_POST_CONTENT_LEN = 5000;
const MAX_COMMENT_LEN = 3000;

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

// Detect tracking pixels and suspicious URLs in inbound content.
// Returns warning strings for display alongside the content.
function checkInboundTracking(text) {
  if (!text) return [];
  const warnings = [];
  // 1x1 pixel images, tracking beacons
  if (/!\[.*?\]\(https?:\/\/[^)]*(?:track|pixel|beacon|1x1|ping|open|click|collect|analytics)/i.test(text)) {
    warnings.push("possible tracking pixel/URL");
  }
  // External image embeds (markdown images to third-party domains)
  const imgMatches = text.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/g) || [];
  if (imgMatches.length > 0) {
    warnings.push(`${imgMatches.length} external image(s) embedded`);
  }
  // HTML img tags (if platform allows raw HTML)
  if (/<img\s+[^>]*src\s*=/i.test(text)) {
    warnings.push("HTML img tag detected");
  }
  // Extremely long content that could be used for resource exhaustion
  if (text.length > 50000) {
    warnings.push(`very large content (${(text.length / 1000).toFixed(0)}KB)`);
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

let consecutiveTimeouts = 0;
let lastTimeoutAt = 0;

// Retry a GET without auth token (handles server-side auth bugs)
async function retryWithoutAuth(url, opts, timeoutMs = 10000) {
  if (!apiKey || (opts.method && opts.method !== "GET")) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "Content-Type": "application/json", ...opts.headers };
    delete headers["Authorization"];
    const res = await fetch(url, { ...opts, headers, signal: controller.signal });
    clearTimeout(timer);
    const json = await res.json();
    if (res.ok && json.success !== false) return json;
  } catch { clearTimeout(timer); }
  return null;
}

async function moltFetch(path, opts = {}) {
  apiCallCount++;
  const prefix = path.split("?")[0].split("/").slice(0, 3).join("/");
  apiCallLog[prefix] = (apiCallLog[prefix] || 0) + 1;
  if (apiCallCount % 10 === 0) saveApiSession();
  const url = `${API}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  // Decay timeout counter: if >30s since last timeout, reset
  if (consecutiveTimeouts > 0 && Date.now() - lastTimeoutAt > 30000) consecutiveTimeouts = 0;
  const timeout = consecutiveTimeouts >= 2 ? 8000 : 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers }, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    apiErrorCount++;
    consecutiveTimeouts++;
    lastTimeoutAt = Date.now();
    const fallback = await retryWithoutAuth(url, opts);
    if (fallback) { consecutiveTimeouts = 0; return fallback; }
    const label = consecutiveTimeouts >= 2 ? "API unreachable (fast-fail)" : "Request timeout";
    return { success: false, error: `${label}: ${e.name}` };
  } finally { clearTimeout(timer); }
  consecutiveTimeouts = 0;
  let json;
  try {
    json = await res.json();
  } catch {
    apiErrorCount++;
    return { success: false, error: `Non-JSON response (HTTP ${res.status})` };
  }
  if ([401, 403, 500].includes(res.status)) {
    const fallback = await retryWithoutAuth(url, opts, 30000);
    if (fallback) return fallback;
  }
  if (!res.ok || json.error) apiErrorCount++;
  return json;
}

const server = new McpServer({ name: "moltbook", version: "1.3.0" });

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
  const trackingWarnings = [...checkInboundTracking(p.content), ...checkInboundTracking(p.title)];
  const trackingNote = trackingWarnings.length ? `\n⚠️ INBOUND: ${trackingWarnings.join(", ")}` : "";
  let text = `"${sanitize(p.title)}" by @${p.author?.name || "unknown"} in m/${p.submolt?.name || "unknown"}${stateLabel}\n${p.upvotes}↑ ${p.downvotes}↓ ${p.comment_count} comments\n\n${sanitize(p.content) || p.url || ""}${trackingNote}`;
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
    if (blocked.has(c.author?.name)) continue;
    const indent = "  ".repeat(depth);
    out += `${indent}@${c.author?.name || "unknown"} [${c.upvotes}↑] (id:${c.id}): ${sanitize(c.content)}\n`;
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
  if (title && title.length > MAX_POST_TITLE_LEN) title = title.slice(0, MAX_POST_TITLE_LEN) + "…";
  if (content && content.length > MAX_POST_CONTENT_LEN) content = content.slice(0, MAX_POST_CONTENT_LEN) + "\n\n[truncated]";
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
  if (content && content.length > MAX_COMMENT_LEN) content = content.slice(0, MAX_COMMENT_LEN) + "\n\n[truncated]";
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
      s.pendingComments.push({ post_id, content, parent_id: parent_id || null, queued_at: new Date().toISOString(), attempts: 0, nextRetryAfter: new Date(Date.now() + 2 * 60000).toISOString() });
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
    text += "Posts:\n" + r.posts.map(p => `  [${p.upvotes}↑] "${sanitize(p.title)}" by @${p.author?.name || "unknown"} (${p.id})`).join("\n") + "\n\n";
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
    const allTools = ["moltbook_post", "moltbook_post_create", "moltbook_comment", "moltbook_vote", "moltbook_search", "moltbook_submolts", "moltbook_profile", "moltbook_profile_update", "moltbook_state", "moltbook_thread_diff", "moltbook_digest", "moltbook_trust", "moltbook_karma", "moltbook_pending", "moltbook_follow", "moltbook_export", "moltbook_import"];
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
        diffs.push(`[${delta}] "${sanitize(p.title)}" by @${p.author?.name || "unknown"}${sub} (${currentCC} total)${isMine ? " [MY POST]" : ""}\n  ID: ${postId}`);
      }
      // Update seen entry inline (batched save at end)
      if (!s.seen[postId]) s.seen[postId] = { at: new Date().toISOString() };
      s.seen[postId].cc = currentCC;
      if (p.submolt?.name) s.seen[postId].sub = p.submolt.name;
      if (p.author?.name) s.seen[postId].author = p.author?.name;
      dirty = true;
    } catch (e) {
      // Network errors should also increment fail counter + backoff
      if (!s.seen[postId]) s.seen[postId] = { at: new Date().toISOString() };
      if (typeof s.seen[postId] === "object") {
        const fails = (s.seen[postId].fails || 0) + 1;
        s.seen[postId].fails = fails;
        s.seen[postId].nextCheck = currentSession + Math.pow(2, fails);
        dirty = true;
      }
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
    .filter(p => !blocked.has(p.author?.name))
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
      const aStats = authorStats[p.author?.name];
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
    return `[score:${score} ${p.upvotes}↑ ${p.comment_count}c] "${sanitize(p.title)}" by @${p.author?.name || "unknown"} in m/${p.submolt?.name || "unknown"}${label}\n  ID: ${p.id}`;
  }).join("\n\n");

  // Persist feed quality snapshot
  const allScores = scored.map(s => s.score);
  const avgScore = allScores.length ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1) : 0;
  const snapshot = {
    at: new Date().toISOString(),
    scanned: data.posts.length,
    signal: scored.length,
    noise: data.posts.length - scored.length - (data.posts.filter(p => blocked.has(p.author?.name)).length),
    blocked: data.posts.filter(p => blocked.has(p.author?.name)).length,
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
  action: z.enum(["list", "retry", "auto", "clear"]).default("list").describe("'list' shows queued comments, 'retry' forces retry of all, 'auto' retries only backoff-eligible comments, 'clear' removes all pending"),
}, async ({ action }) => {
  const s = loadState();
  const pending = s.pendingComments || [];
  if (pending.length === 0) return { content: [{ type: "text", text: "No pending comments." }] };

  if (action === "list") {
    const lines = pending.map((pc, i) => {
      const backoffInfo = pc.nextRetryAfter ? (() => {
        const ms = new Date(pc.nextRetryAfter).getTime() - Date.now();
        return ms > 0 ? ` ⏳${Math.round(ms / 60000)}min` : " ✅ready";
      })() : " ✅ready";
      return `${i + 1}. post:${pc.post_id.slice(0, 8)}${pc.parent_id ? ` reply:${pc.parent_id.slice(0, 8)}` : ""} queued:${pc.queued_at.slice(0, 10)} attempts:${pc.attempts || 0}/10${backoffInfo} — "${pc.content.slice(0, 80)}${pc.content.length > 80 ? "…" : ""}"`;
    });
    return { content: [{ type: "text", text: `📋 ${pending.length} pending comment(s):\n${lines.join("\n")}` }] };
  }

  if (action === "clear") {
    const count = pending.length;
    s.pendingComments = [];
    saveState(s);
    return { content: [{ type: "text", text: `Cleared ${count} pending comment(s).` }] };
  }

  // action === "retry" or "auto"
  const isAuto = action === "auto";
  const MAX_RETRIES = 10;
  const CIRCUIT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

  // For auto mode, filter to only backoff-eligible comments
  const now = Date.now();
  const eligible = isAuto ? pending.filter(pc => !pc.nextRetryAfter || new Date(pc.nextRetryAfter).getTime() <= now) : pending;
  if (isAuto && eligible.length === 0) {
    const nextUp = pending.reduce((earliest, pc) => {
      const t = pc.nextRetryAfter ? new Date(pc.nextRetryAfter).getTime() : 0;
      return t < earliest ? t : earliest;
    }, Infinity);
    const minsLeft = nextUp === Infinity ? "?" : Math.round((nextUp - now) / 60000);
    return { content: [{ type: "text", text: `⏳ ${pending.length} pending comment(s), none eligible yet. Next eligible in ~${minsLeft}min.` }] };
  }

  // Circuit breaker: if all recent retries failed with auth, skip full retry and probe first
  const circuitOpenAt = s.commentCircuitOpen ? new Date(s.commentCircuitOpen).getTime() : 0;
  const circuitAge = Date.now() - circuitOpenAt;
  if (circuitOpenAt && circuitAge < CIRCUIT_COOLDOWN_MS) {
    // Probe with first pending comment to check if endpoint is back
    const probe = pending[0];
    const probeBody = { content: probe.content };
    if (probe.parent_id) probeBody.parent_id = probe.parent_id;
    try {
      const probeData = await moltFetch(`/posts/${probe.post_id}/comments`, { method: "POST", body: JSON.stringify(probeBody) });
      if (probeData.success && probeData.comment) {
        // Circuit closed — endpoint is back
        delete s.commentCircuitOpen;
        markCommented(probe.post_id, probeData.comment.id);
        markMyComment(probe.post_id, probeData.comment.id);
        logAction(`commented on ${probe.post_id.slice(0, 8)} (probe-retry)`);
        s.pendingComments = pending.slice(1);
        saveState(s);
        return { content: [{ type: "text", text: `🟢 Circuit breaker: probe succeeded! Endpoint is back.\n✅ ${probe.post_id.slice(0, 8)} posted. ${pending.length - 1} remaining — retry again to post the rest.` }] };
      }
    } catch {}
    // Probe failed — circuit stays open
    const hoursLeft = Math.round((CIRCUIT_COOLDOWN_MS - circuitAge) / 3600000);
    return { content: [{ type: "text", text: `🔴 Circuit breaker OPEN (probe failed). Comment endpoint still broken.\n${pending.length} comment(s) queued. Auto-reset in ~${hoursLeft}h, or clear with action:clear.` }] };
  }

  const results = [];
  const stillPending = [];
  const pruned = [];
  let authFailCount = 0;
  // Keep non-eligible comments as-is
  const notEligible = isAuto ? pending.filter(pc => pc.nextRetryAfter && new Date(pc.nextRetryAfter).getTime() > now) : [];
  for (const pc of eligible) {
    pc.attempts = (pc.attempts || 0) + 1;
    if (pc.attempts > MAX_RETRIES) {
      pruned.push(pc.post_id.slice(0, 8));
      continue;
    }
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
        // Exponential backoff: 2^attempts minutes, capped at 24h
        const backoffMs = Math.min(Math.pow(2, pc.attempts) * 60000, 24 * 60 * 60 * 1000);
        pc.nextRetryAfter = new Date(Date.now() + backoffMs).toISOString();
        stillPending.push(pc);
        if (/auth/i.test(data.error || "")) authFailCount++;
        results.push(`❌ ${pc.post_id.slice(0, 8)}: ${data.error || "unknown error"} (attempt ${pc.attempts}/${MAX_RETRIES}, next retry in ${Math.round(backoffMs / 60000)}min)`);
      }
    } catch (e) {
      const backoffMs = Math.min(Math.pow(2, pc.attempts) * 60000, 24 * 60 * 60 * 1000);
      pc.nextRetryAfter = new Date(Date.now() + backoffMs).toISOString();
      stillPending.push(pc);
      if (/auth/i.test(e.message)) authFailCount++;
      results.push(`❌ ${pc.post_id.slice(0, 8)}: ${e.message} (attempt ${pc.attempts}/${MAX_RETRIES}, next retry in ${Math.round(backoffMs / 60000)}min)`);
    }
  }
  // If all failed with auth, open circuit breaker
  if (stillPending.length > 0 && authFailCount === stillPending.length) {
    s.commentCircuitOpen = new Date().toISOString();
  }
  s.pendingComments = [...stillPending, ...notEligible];
  saveState(s);
  if (pruned.length) results.push(`🗑️ Pruned ${pruned.length} comment(s) after ${MAX_RETRIES} failed attempts: ${pruned.join(", ")}`);
  const circuitMsg = s.commentCircuitOpen ? "\n🔴 All retries failed with auth — circuit breaker opened. Next retry will probe with 1 request instead of retrying all." : "";
  const skippedMsg = notEligible.length ? `\n⏳ ${notEligible.length} comment(s) still in backoff.` : "";
  return { content: [{ type: "text", text: `Retry results (${results.length - stillPending.length}/${eligible.length} succeeded):\n${results.join("\n")}${circuitMsg}${skippedMsg}` }] };
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

// --- GitHub Mapping Tool ---
const GITHUB_MAP_PATH = join(__dirname, "github-mappings.json");

function loadGithubMap() {
  try { return JSON.parse(readFileSync(GITHUB_MAP_PATH, "utf8")); }
  catch { return {}; }
}

server.tool("moltbook_github_map", "Add or view GitHub URL mappings for agents in the directory", {
  handle: z.string().optional().describe("Agent handle to map (omit to list all mappings)"),
  github: z.string().optional().describe("GitHub profile URL (e.g. https://github.com/user)"),
  repo: z.string().optional().describe("GitHub repo URL to add (e.g. https://github.com/user/repo)")
}, async ({ handle, github, repo }) => {
  const map = loadGithubMap();

  // List mode
  if (!handle) {
    const entries = Object.entries(map).filter(([k]) => k !== "_comment");
    if (entries.length === 0) return { content: [{ type: "text", text: "No GitHub mappings yet." }] };
    const lines = entries.map(([h, d]) => {
      const parts = [`@${h}`];
      if (d.github) parts.push(`  GitHub: ${d.github}`);
      if (d.repos?.length) parts.push(`  Repos: ${d.repos.join(", ")}`);
      return parts.join("\n");
    });
    return { content: [{ type: "text", text: `GitHub mappings (${entries.length}):\n\n${lines.join("\n\n")}` }] };
  }

  // Add/update mode
  if (!github && !repo) {
    const existing = map[handle];
    if (!existing) return { content: [{ type: "text", text: `No mapping for @${handle}. Provide github or repo to add one.` }] };
    const parts = [`@${handle}`];
    if (existing.github) parts.push(`GitHub: ${existing.github}`);
    if (existing.repos?.length) parts.push(`Repos: ${existing.repos.join(", ")}`);
    return { content: [{ type: "text", text: parts.join("\n") }] };
  }

  if (!map[handle]) map[handle] = { github: null, repos: [] };
  if (github) map[handle].github = github;
  if (repo && !map[handle].repos.includes(repo)) {
    if (!map[handle].repos) map[handle].repos = [];
    map[handle].repos.push(repo);
  }

  writeFileSync(GITHUB_MAP_PATH, JSON.stringify(map, null, 2) + "\n");

  // Re-run collect-agents to update unified directory
  try {
    const { execSync } = require("child_process");
    execSync(`node ${join(__dirname, "collect-agents.cjs")}`, { timeout: 10000 });
  } catch {}

  return { content: [{ type: "text", text: `Mapped @${handle} → ${github || map[handle].github || "(no profile)"}${repo ? ` + repo ${repo}` : ""}. Directory updated.` }] };
});

// --- Bluesky Agent Discovery ---
const BSKY_PUBLIC = "https://public.api.bsky.app";
const BSKY_CATALOG_PATH = join(process.env.HOME || "/tmp", "moltbook-mcp", "bsky-agents.json");

const BSKY_STRONG_BOT_RE = [
  /\bi am a bot\b/i, /\bi('m| am) an? (ai |artificial |autonomous |llm )?agent\b/i,
  /\bautomated account\b/i, /\bautonomous ai\b/i,
  /\bbuilt (with|on|using) (claude|gpt|llama|gemini|openai|anthropic)/i,
  /\bpowered by (claude|gpt|llama|gemini|openai|anthropic)/i,
  /\bbot account\b/i, /\bnot a human\b/i, /\bfully autonomous\b/i,
  /\bai-powered bot\b/i, /\bautomated posts?\b/i,
];
const BSKY_WEAK_BOT_RE = [/\bbot\b/i, /\bagent\b/i, /\bautomated\b/i, /\bai-powered\b/i, /\bllm\b/i];
const BSKY_HANDLE_RE = [/bot[s]?\./i, /\.bot$/i, /agent\./i, /ai-?\w*\./i];
const BSKY_HUMAN_RE = [
  /\bphd\b/i, /\bprofessor\b/i, /\bresearcher\b/i, /\bstudent\b/i, /\bfounder\b/i,
  /\bceo\b/i, /\bdeveloper\b/i, /\bengineer\b/i, /\bi (work|research|study|build|create)\b/i,
];
const BSKY_AI_RE = [/\bautonomous ai\b/i, /\b(claude|gpt|llama|gemini|openai|anthropic)\b/i, /\bllm\b/i, /\bai.?agent\b/i];
const BSKY_POST_RE = [
  /\bi am a bot\b/i, /\bi am an ai\b/i, /\bgenerated by\b/i, /\bautonomous(ly)?\b/i,
  /\bmy (creator|developer|operator)\b/i, /\bsession \d+/i, /\b(claude|gpt|llm)\b/i,
];

const BSKY_SEARCH_QUERIES = [
  "bot autonomous AI", "I am a bot", "I am an AI agent", "automated account",
  "autonomous agent bluesky", "claude agent", "GPT bot", "LLM bot bluesky",
];

function bskyScoreProfile(actor) {
  const desc = actor.description || "";
  const handle = actor.handle || "";
  const name = (actor.displayName || "").toLowerCase();
  let score = 0; let aiScore = 0; const signals = [];
  for (const re of BSKY_STRONG_BOT_RE) { if (re.test(desc)) { score += 30; signals.push(`strong:${re.source.slice(0,20)}`); } }
  for (const re of BSKY_WEAK_BOT_RE) { if (re.test(desc)) { score += 5; signals.push(`weak:${re.source.slice(0,15)}`); } }
  for (const re of BSKY_HANDLE_RE) { if (re.test(handle)) { score += 15; signals.push(`handle`); } }
  if (/bot/i.test(name)) { score += 10; signals.push("name_bot"); }
  if (/ai.*agent|agent.*ai/i.test(name)) { score += 15; signals.push("name_ai_agent"); }
  for (const re of BSKY_HUMAN_RE) { if (re.test(desc)) { score -= 15; signals.push(`human`); } }
  for (const re of BSKY_AI_RE) { if (re.test(desc) || re.test(actor.displayName || "")) aiScore += 10; }
  return { score: Math.max(0, score), aiScore, signals };
}

async function bskyFetch(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${BSKY_PUBLIC}${path}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch { clearTimeout(timer); return null; }
}

async function bskyDiscover(opts = {}) {
  const minScore = opts.minScore || 20;
  const limit = opts.limit || 30;
  const candidates = new Map();

  // Phase 1: Search for agent profiles
  for (const q of BSKY_SEARCH_QUERIES) {
    const data = await bskyFetch(`/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent(q)}&limit=25`);
    if (!data?.actors) continue;
    for (const actor of data.actors) {
      if (candidates.has(actor.handle)) continue;
      const { score, aiScore, signals } = bskyScoreProfile(actor);
      candidates.set(actor.handle, { actor, score, aiScore, signals });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Phase 2: Follow-graph traversal — find who known agents follow
  if (opts.followGraph !== false) {
    // Get top-scoring candidates so far as seeds
    const seeds = [...candidates.values()]
      .filter(c => c.score >= 40)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    for (const seed of seeds) {
      const data = await bskyFetch(`/xrpc/app.bsky.graph.getFollows?actor=${encodeURIComponent(seed.actor.did)}&limit=50`);
      if (!data?.follows) continue;
      for (const actor of data.follows) {
        if (candidates.has(actor.handle)) continue;
        const { score, aiScore, signals } = bskyScoreProfile(actor);
        if (score > 0) {
          signals.push(`followed_by:@${seed.actor.handle.split(".")[0]}`);
          candidates.set(actor.handle, { actor, score: score + 10, aiScore, signals });
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Phase 3: Analyze recent posts for top candidates
  let results = [...candidates.values()]
    .filter(c => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit * 2);

  if (opts.analyzePosts !== false) {
    for (const r of results.slice(0, 20)) {
      const data = await bskyFetch(`/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(r.actor.did)}&limit=10`);
      if (!data?.feed) continue;
      let hits = 0;
      for (const item of data.feed) {
        const text = item.post?.record?.text || "";
        for (const re of BSKY_POST_RE) { if (re.test(text)) { hits++; break; } }
      }
      const ratio = data.feed.length > 0 ? hits / data.feed.length : 0;
      if (ratio > 0.3) { r.score += 20; r.signals.push(`bot_posts:${(ratio*100).toFixed(0)}%`); }
      else if (ratio > 0.1) { r.score += 10; r.signals.push(`some_bot_posts`); }
      await new Promise(r => setTimeout(r, 200));
    }
    results.sort((a, b) => b.score - a.score);
  }

  return results.slice(0, limit);
}

server.tool("moltbook_bsky_discover", "Discover AI agent accounts on Bluesky using multi-signal heuristics + follow-graph traversal", {
  limit: z.number().min(1).max(50).default(20).optional().describe("Max agents to return"),
  min_score: z.number().default(20).optional().describe("Minimum score threshold"),
  ai_only: z.boolean().default(false).optional().describe("Only return agents with AI signals"),
  follow_graph: z.boolean().default(true).optional().describe("Traverse follow graphs of top candidates"),
  analyze_posts: z.boolean().default(true).optional().describe("Analyze recent posts for bot patterns"),
}, async ({ limit, min_score, ai_only, follow_graph, analyze_posts }) => {
  try {
    let results = await bskyDiscover({
      limit: (limit || 20) * 2,
      minScore: min_score || 20,
      followGraph: follow_graph !== false,
      analyzePosts: analyze_posts !== false,
    });
    if (ai_only) results = results.filter(r => r.aiScore > 0);
    results = results.slice(0, limit || 20);

    if (!results.length) return { content: [{ type: "text", text: "No Bluesky agents found matching criteria." }] };

    // Save catalog
    const catalog = results.map(r => ({
      handle: r.actor.handle,
      displayName: r.actor.displayName || null,
      did: r.actor.did,
      score: r.score,
      aiScore: r.aiScore,
      signals: r.signals,
      followers: r.actor.followersCount || 0,
      following: r.actor.followsCount || 0,
      posts: r.actor.postsCount || 0,
      discoveredAt: new Date().toISOString(),
    }));

    // Delta tracking against previous catalog
    let previousHandles = new Set();
    try {
      const prev = JSON.parse(readFileSync(BSKY_CATALOG_PATH, "utf8"));
      previousHandles = new Set(prev.map(e => e.handle));
    } catch {}
    const newAgents = catalog.filter(a => !previousHandles.has(a.handle));
    writeFileSync(BSKY_CATALOG_PATH, JSON.stringify(catalog, null, 2));

    // Format output
    const lines = results.map(r => {
      const bio = (r.actor.description || "").slice(0, 80).replace(/\n/g, " ");
      const isNew = !previousHandles.has(r.actor.handle);
      return `[${r.score}${r.aiScore ? ` ai:${r.aiScore}` : ""}] @${r.actor.handle}${isNew ? " 🆕" : ""}\n  ${r.actor.displayName || "-"} | ${bio}\n  signals: ${r.signals.slice(0, 5).join(", ")}`;
    });

    let header = `Bluesky Agent Discovery: ${results.length} agents found (min score: ${min_score || 20})`;
    if (newAgents.length) header += `\n🆕 ${newAgents.length} new since last scan`;
    header += `\nCatalog saved to bsky-agents.json`;

    return { content: [{ type: "text", text: `${header}\n\n${lines.join("\n\n")}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Discovery error: ${e.message}` }] };
  }
});


// =============================================================================
// AGENT LEARNING ECOSYSTEM — Knowledge base and cross-agent learning tools
// =============================================================================

const KNOWLEDGE_DIR = join(process.env.HOME || "/tmp", "moltbook-mcp", "knowledge");
const PATTERNS_FILE = join(KNOWLEDGE_DIR, "patterns.json");
const REPOS_CRAWLED_FILE = join(KNOWLEDGE_DIR, "repos-crawled.json");
const DIGEST_FILE = join(KNOWLEDGE_DIR, "digest.md");
const AGENTS_UNIFIED_FILE = join(process.env.HOME || "/tmp", "moltbook-mcp", "agents-unified.json");

function loadPatterns() {
  try { return JSON.parse(readFileSync(PATTERNS_FILE, "utf8")); }
  catch { return { version: 1, lastUpdated: new Date().toISOString(), patterns: [] }; }
}

function savePatterns(data) {
  data.lastUpdated = new Date().toISOString();
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(PATTERNS_FILE, JSON.stringify(data, null, 2));
}

function loadReposCrawled() {
  try { return JSON.parse(readFileSync(REPOS_CRAWLED_FILE, "utf8")); }
  catch { return { version: 1, repos: {} }; }
}

function saveReposCrawled(data) {
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(REPOS_CRAWLED_FILE, JSON.stringify(data, null, 2));
}

function regenerateDigest() {
  const data = loadPatterns();
  const byCategory = {};
  for (const p of data.patterns) {
    if (!byCategory[p.category]) byCategory[p.category] = [];
    byCategory[p.category].push(p);
  }
  const selfCount = data.patterns.filter(p => p.source.startsWith("self:")).length;
  const crawlCount = data.patterns.filter(p => p.source.startsWith("github.com/") || p.source.startsWith("crawl:")).length;
  const exchangeCount = data.patterns.filter(p => p.source.startsWith("exchange:")).length;

  let md = `# Knowledge Digest\n\n${data.patterns.length} patterns: ${selfCount} self-derived, ${crawlCount} from repo crawls, ${exchangeCount} from agent exchange.\n\n`;
  for (const [cat, patterns] of Object.entries(byCategory)) {
    md += `**${cat.charAt(0).toUpperCase() + cat.slice(1)}**:\n`;
    for (const p of patterns.slice(0, 5)) {
      md += `- ${p.title} (${p.confidence}, ${p.source.split("/").slice(-1)[0] || p.source})\n`;
    }
    if (patterns.length > 5) md += `- ...and ${patterns.length - 5} more\n`;
    md += "\n";
  }
  if (crawlCount === 0 && exchangeCount === 0) {
    md += "*No external patterns yet. Use agent_crawl_repo or agent_fetch_knowledge to learn from other agents.*\n";
  }
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(DIGEST_FILE, md);
  return md;
}

// --- Tool: knowledge_read ---
server.tool(
  "knowledge_read",
  "Read the agent knowledge base. Returns either a concise digest or full pattern list.",
  { format: z.enum(["digest", "full"]).default("digest").describe("digest = summary, full = all patterns"), category: z.string().optional().describe("Filter by category") },
  async ({ format, category }) => {
    if (format === "digest") {
      try {
        const digest = readFileSync(DIGEST_FILE, "utf8");
        return { content: [{ type: "text", text: digest }] };
      } catch {
        const digest = regenerateDigest();
        return { content: [{ type: "text", text: digest }] };
      }
    }
    const data = loadPatterns();
    let patterns = data.patterns;
    if (category) patterns = patterns.filter(p => p.category === category);
    return { content: [{ type: "text", text: JSON.stringify({ count: patterns.length, patterns }, null, 2) }] };
  }
);

// --- Tool: knowledge_add_pattern ---
server.tool(
  "knowledge_add_pattern",
  "Add a learned pattern to the knowledge base. Use after analyzing a repo or discovering a useful technique.",
  {
    source: z.string().describe("Where this pattern came from, e.g. 'github.com/user/repo' or 'self:session-215'"),
    category: z.enum(["architecture", "prompting", "tooling", "reliability", "security", "ecosystem"]).describe("Pattern category"),
    title: z.string().describe("Short descriptive title"),
    description: z.string().describe("What the pattern is and why it works"),
    tags: z.array(z.string()).default([]).describe("Searchable tags"),
    confidence: z.enum(["verified", "observed", "speculative"]).default("observed").describe("How confident are we this pattern works"),
  },
  async ({ source, category, title, description, tags, confidence }) => {
    const data = loadPatterns();
    // Dedup by title similarity
    const existing = data.patterns.find(p => p.title.toLowerCase() === title.toLowerCase());
    if (existing) {
      return { content: [{ type: "text", text: `Pattern already exists: ${existing.id} — "${existing.title}". Update it manually if needed.` }] };
    }
    const id = `p${String(data.patterns.length + 1).padStart(3, "0")}`;
    data.patterns.push({ id, source, category, title, description, confidence, extractedAt: new Date().toISOString(), tags });
    savePatterns(data);
    const digest = regenerateDigest();
    return { content: [{ type: "text", text: `Added pattern ${id}: "${title}" (${category}, ${confidence}). Knowledge base now has ${data.patterns.length} patterns.\n\nUpdated digest:\n${digest}` }] };
  }
);

// --- Tool: agent_crawl_repo ---
server.tool(
  "agent_crawl_repo",
  "Clone an agent's GitHub repo (shallow) and extract documentation files for learning. Does NOT execute any code. Returns file contents for you to analyze and extract patterns from.",
  {
    github_url: z.string().describe("GitHub repo URL, e.g. https://github.com/user/repo"),
    force: z.boolean().default(false).describe("Force re-crawl even if recently crawled"),
  },
  async ({ github_url, force }) => {
    const { execSync } = await import("child_process");
    // Normalize URL
    const match = github_url.match(/github\.com\/([^\/]+\/[^\/\s#?]+)/);
    if (!match) return { content: [{ type: "text", text: "Invalid GitHub URL. Use format: https://github.com/user/repo" }] };
    const repoSlug = match[1].replace(/\.git$/, "");
    const repoKey = `github.com/${repoSlug}`;

    // Check if recently crawled
    const crawled = loadReposCrawled();
    if (!force && crawled.repos[repoKey]) {
      const daysSince = (Date.now() - new Date(crawled.repos[repoKey].lastCrawled).getTime()) / 86400000;
      if (daysSince < 7) {
        return { content: [{ type: "text", text: `Repo ${repoKey} was crawled ${daysSince.toFixed(1)} days ago. Use force=true to re-crawl. Previous files: ${crawled.repos[repoKey].filesRead.join(", ")}` }] };
      }
    }

    const tmpDir = `/tmp/agent-crawl-${Date.now()}`;
    try {
      // Shallow clone
      execSync(`git clone --depth 1 https://${repoKey}.git "${tmpDir}" 2>&1`, { timeout: 30000 });

      // Read target files (priority order)
      const targetFiles = [
        "AGENTS.md", "CLAUDE.md", ".claude/commands", "README.md", "BRIEFING.md",
        "package.json", "pyproject.toml", "Cargo.toml",
      ];
      const allowedExts = new Set([".md", ".json", ".js", ".ts", ".py", ".sh", ".yaml", ".yml", ".toml", ".txt"]);
      const MAX_FILE_SIZE = 50000;

      const files = [];
      for (const target of targetFiles) {
        const fullPath = join(tmpDir, target);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            // Read all files in directory (e.g. .claude/commands/)
            const entries = readdirSync(fullPath);
            for (const entry of entries.slice(0, 10)) {
              const ext = entry.includes(".") ? "." + entry.split(".").pop() : "";
              if (!allowedExts.has(ext)) continue;
              const entryPath = join(fullPath, entry);
              const eStat = statSync(entryPath);
              if (eStat.size > MAX_FILE_SIZE || !eStat.isFile()) continue;
              files.push({ name: `${target}/${entry}`, content: readFileSync(entryPath, "utf8") });
            }
          } else if (stat.size <= MAX_FILE_SIZE) {
            files.push({ name: target, content: readFileSync(fullPath, "utf8") });
          }
        } catch { /* file doesn't exist, skip */ }
      }

      // Also check root .md files not in target list
      try {
        const rootFiles = readdirSync(tmpDir).filter(f => f.endsWith(".md") && !targetFiles.includes(f));
        for (const f of rootFiles.slice(0, 5)) {
          const fPath = join(tmpDir, f);
          const fStat = statSync(fPath);
          if (fStat.size <= MAX_FILE_SIZE) {
            files.push({ name: f, content: readFileSync(fPath, "utf8") });
          }
        }
      } catch {}

      // Get repo meta via git
      let commitSha = "";
      try { commitSha = execSync(`git -C "${tmpDir}" rev-parse HEAD`, { encoding: "utf8" }).trim(); } catch {}

      // Update crawl tracking
      crawled.repos[repoKey] = {
        lastCrawled: new Date().toISOString(),
        commitSha,
        filesRead: files.map(f => f.name),
        patternsExtracted: 0,
      };
      saveReposCrawled(crawled);

      // Cleanup
      execSync(`rm -rf "${tmpDir}"`);

      if (files.length === 0) {
        return { content: [{ type: "text", text: `Cloned ${repoKey} but found no readable documentation files.` }] };
      }

      const output = files.map(f => `--- ${f.name} ---\n${f.content}`).join("\n\n");
      return { content: [{ type: "text", text: `Crawled ${repoKey} (${files.length} files, commit ${commitSha.slice(0, 8)}):\n\n${output}\n\nAnalyze these files and use knowledge_add_pattern for any useful techniques you find.` }] };
    } catch (e) {
      try { execSync(`rm -rf "${tmpDir}"`); } catch {}
      return { content: [{ type: "text", text: `Crawl failed for ${repoKey}: ${e.message}` }] };
    }
  }
);

// --- Tool: agent_crawl_suggest ---
server.tool(
  "agent_crawl_suggest",
  "Suggest the best agent repos to crawl next. Picks from the agent directory, prioritizing uncrawled repos with GitHub URLs.",
  { limit: z.number().default(3).describe("How many suggestions to return") },
  async ({ limit }) => {
    const { execSync } = await import("child_process");
    // Load agent directory
    let agents = [];
    try { agents = JSON.parse(readFileSync(AGENTS_UNIFIED_FILE, "utf8")).agents || []; } catch {}

    // Load crawl history
    const crawled = loadReposCrawled();

    // Find agents with GitHub URLs from their profiles or known repos
    // Also check the Bluesky agents for GitHub links in their bios
    const candidates = [];

    for (const agent of agents) {
      // Check if agent has a GitHub URL in their profile
      let githubUrl = null;
      if (agent.github) githubUrl = agent.github;
      if (agent.handle && agent.platform === "bluesky") {
        // Bluesky agents sometimes have github in their signals
        if (agent.signals && agent.signals.some(s => s.includes("github"))) {
          // Try to extract from signals
          for (const sig of agent.signals) {
            const ghMatch = sig.match(/github\.com\/([^\s,)]+)/);
            if (ghMatch) { githubUrl = `https://github.com/${ghMatch[1]}`; break; }
          }
        }
      }
      if (!githubUrl) continue;

      const repoMatch = githubUrl.match(/github\.com\/([^\/]+\/[^\/\s#?]+)/);
      if (!repoMatch) continue;
      const repoKey = `github.com/${repoMatch[1].replace(/\.git$/, "")}`;

      const crawlInfo = crawled.repos[repoKey];
      const daysSinceLastCrawl = crawlInfo ? (Date.now() - new Date(crawlInfo.lastCrawled).getTime()) / 86400000 : Infinity;

      candidates.push({
        agent: agent.handle,
        platform: agent.platform,
        repoUrl: githubUrl,
        repoKey,
        daysSinceLastCrawl,
        postCount: agent.postCount || 0,
        score: agent.score || 0,
        neverCrawled: !crawlInfo,
      });
    }

    // Sort: never-crawled first, then by staleness, then by activity
    candidates.sort((a, b) => {
      if (a.neverCrawled !== b.neverCrawled) return a.neverCrawled ? -1 : 1;
      if (Math.abs(a.daysSinceLastCrawl - b.daysSinceLastCrawl) > 1) return b.daysSinceLastCrawl - a.daysSinceLastCrawl;
      return (b.postCount + b.score) - (a.postCount + a.score);
    });

    const top = candidates.slice(0, limit);
    if (top.length === 0) {
      return { content: [{ type: "text", text: "No agent repos found with GitHub URLs in the directory. Try discovering more agents first, or manually crawl a known repo with agent_crawl_repo." }] };
    }

    const lines = top.map((c, i) => `${i + 1}. @${c.agent} (${c.platform}) — ${c.repoUrl}\n   ${c.neverCrawled ? "Never crawled" : `Last crawled ${c.daysSinceLastCrawl.toFixed(0)} days ago`} | ${c.postCount} posts`);
    return { content: [{ type: "text", text: `Top ${top.length} repos to crawl:\n\n${lines.join("\n\n")}\n\nUse agent_crawl_repo to inspect any of these.` }] };
  }
);

// --- Tool: agent_fetch_knowledge ---
server.tool(
  "agent_fetch_knowledge",
  "Fetch knowledge from another agent's exchange endpoint. Checks their /agent.json for capabilities, then imports published patterns.",
  { agent_url: z.string().describe("Base URL of the agent's API, e.g. http://example.com:3847") },
  async ({ agent_url }) => {
    const baseUrl = agent_url.replace(/\/$/, "");
    try {
      // Fetch agent manifest
      const manifestRes = await fetch(`${baseUrl}/agent.json`);
      if (!manifestRes.ok) {
        return { content: [{ type: "text", text: `No agent manifest at ${baseUrl}/agent.json (HTTP ${manifestRes.status}). This agent may not support the exchange protocol.` }] };
      }
      const manifest = await manifestRes.json();

      let output = `Agent: ${manifest.agent || "unknown"}\nCapabilities: ${(manifest.capabilities || []).join(", ")}\nGitHub: ${manifest.github || "none"}\n`;

      // Try to fetch patterns
      const patternsUrl = manifest.exchange?.patterns_url
        ? (manifest.exchange.patterns_url.startsWith("http") ? manifest.exchange.patterns_url : `${baseUrl}${manifest.exchange.patterns_url}`)
        : `${baseUrl}/knowledge/patterns`;

      try {
        const pRes = await fetch(patternsUrl);
        if (pRes.ok) {
          const pData = await pRes.json();
          const remotePatterns = pData.patterns || [];
          output += `\nPatterns available: ${remotePatterns.length}\n`;

          // Import new patterns (dedup by title)
          const local = loadPatterns();
          const localTitles = new Set(local.patterns.map(p => p.title.toLowerCase()));
          let imported = 0;
          for (const rp of remotePatterns) {
            if (localTitles.has((rp.title || "").toLowerCase())) continue;
            const id = `p${String(local.patterns.length + 1).padStart(3, "0")}`;
            local.patterns.push({
              id,
              source: `exchange:${manifest.agent || baseUrl}`,
              category: rp.category || "tooling",
              title: rp.title,
              description: rp.description || "",
              confidence: "observed",
              extractedAt: new Date().toISOString(),
              tags: rp.tags || [],
            });
            imported++;
          }
          if (imported > 0) {
            savePatterns(local);
            regenerateDigest();
            output += `Imported ${imported} new patterns. Knowledge base now has ${local.patterns.length} patterns.`;
          } else {
            output += "No new patterns to import (all duplicates or empty).";
          }
        } else {
          output += `\nPatterns endpoint returned HTTP ${pRes.status}`;
        }
      } catch (e) {
        output += `\nCould not fetch patterns: ${e.message}`;
      }

      return { content: [{ type: "text", text: output }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to connect to ${baseUrl}: ${e.message}` }] };
    }
  }
);
// --- Tool: knowledge_prune ---
server.tool(
  "knowledge_prune",
  "Manage pattern aging: validate patterns to keep them fresh, auto-downgrade stale ones, or remove low-value patterns.",
  {
    action: z.enum(["status", "validate", "age", "remove"]).default("status").describe("'status' shows staleness report, 'validate' refreshes a pattern, 'age' downgrades stale patterns, 'remove' deletes a pattern"),
    pattern_id: z.string().optional().describe("Pattern ID for validate/remove actions (e.g. 'p001')"),
    max_age_days: z.number().default(30).describe("Days before a pattern is considered stale (for age action)"),
  },
  async ({ action, pattern_id, max_age_days }) => {
    const data = loadPatterns();
    const now = Date.now();

    // Ensure all patterns have lastValidated
    for (const p of data.patterns) {
      if (!p.lastValidated) p.lastValidated = p.extractedAt;
    }

    if (action === "validate") {
      if (!pattern_id) return { content: [{ type: "text", text: "Provide pattern_id to validate." }] };
      const p = data.patterns.find(pp => pp.id === pattern_id);
      if (!p) return { content: [{ type: "text", text: `Pattern ${pattern_id} not found.` }] };
      p.lastValidated = new Date().toISOString();
      if (p.confidence === "speculative") p.confidence = "observed";
      savePatterns(data);
      return { content: [{ type: "text", text: `Validated ${p.id}: "${p.title}" — lastValidated set to now, confidence: ${p.confidence}.` }] };
    }

    if (action === "remove") {
      if (!pattern_id) return { content: [{ type: "text", text: "Provide pattern_id to remove." }] };
      const idx = data.patterns.findIndex(pp => pp.id === pattern_id);
      if (idx === -1) return { content: [{ type: "text", text: `Pattern ${pattern_id} not found.` }] };
      const removed = data.patterns.splice(idx, 1)[0];
      savePatterns(data);
      regenerateDigest();
      return { content: [{ type: "text", text: `Removed ${removed.id}: "${removed.title}". ${data.patterns.length} patterns remain.` }] };
    }

    if (action === "age") {
      const staleMs = max_age_days * 86400000;
      let downgraded = 0;
      for (const p of data.patterns) {
        const age = now - new Date(p.lastValidated).getTime();
        if (age > staleMs && p.confidence === "verified") {
          p.confidence = "observed";
          downgraded++;
        } else if (age > staleMs * 2 && p.confidence === "observed") {
          p.confidence = "speculative";
          downgraded++;
        }
      }
      if (downgraded > 0) {
        savePatterns(data);
        regenerateDigest();
      }
      return { content: [{ type: "text", text: `Aged patterns (${max_age_days}d threshold): ${downgraded} downgraded. ${data.patterns.length} total.` }] };
    }

    // status: show staleness report
    const lines = data.patterns.map(p => {
      const ageDays = ((now - new Date(p.lastValidated || p.extractedAt).getTime()) / 86400000).toFixed(1);
      const stale = parseFloat(ageDays) > max_age_days ? " [STALE]" : "";
      return `${p.id} (${p.confidence}) ${ageDays}d — ${p.title}${stale}`;
    });
    return { content: [{ type: "text", text: `Pattern staleness (${max_age_days}d threshold):\n${lines.join("\n")}` }] };
  }
);

// --- Tool: agentid_lookup ---
server.tool(
  "agentid_lookup",
  "Look up an agent's AgentID identity and linked accounts (GitHub, Twitter, website).",
  { handle: z.string().describe("AgentID handle to look up") },
  async ({ handle }) => {
    try {
      const res = await fetch(`https://agentid.sh/api/verify/${encodeURIComponent(handle)}`);
      const data = await res.json();
      if (!data.success) return { content: [{ type: "text", text: `AgentID lookup failed: ${JSON.stringify(data)}` }] };
      const d = data.data;
      const links = (d.linked_accounts || []).map(a => `  ${a.platform}: @${a.platform_handle} (${a.verified ? "verified" : "unverified"})`).join("\n");
      const text = `AgentID: ${d.handle}\nPublic key: ${d.public_key}\nBio: ${d.bio || "(none)"}\nLinked accounts:\n${links || "  (none)"}`;
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `AgentID lookup error: ${e.message}` }] };
    }
  }
);

// --- Tool: ctxly_remember ---
server.tool(
  "ctxly_remember",
  "Store a memory in Ctxly cloud context. Requires CTXLY_API_KEY env var or ~/moltbook-mcp/ctxly.json.",
  { content: z.string().describe("The memory to store"), tags: z.array(z.string()).optional().describe("Optional tags") },
  async ({ content, tags }) => {
    try {
      const key = getCtxlyKey();
      if (!key) return { content: [{ type: "text", text: "No Ctxly API key found. Set CTXLY_API_KEY or add api_key to ~/moltbook-mcp/ctxly.json" }] };
      const body = { content };
      if (tags) body.tags = tags;
      const res = await fetch("https://ctxly.app/remember", {
        method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Ctxly error: ${e.message}` }] };
    }
  }
);

// --- Tool: ctxly_recall ---
server.tool(
  "ctxly_recall",
  "Search Ctxly cloud memories by keyword. Requires CTXLY_API_KEY.",
  { query: z.string().describe("Search query"), limit: z.number().default(10).describe("Max results") },
  async ({ query, limit }) => {
    try {
      const key = getCtxlyKey();
      if (!key) return { content: [{ type: "text", text: "No Ctxly API key found." }] };
      const res = await fetch(`https://ctxly.app/recall?q=${encodeURIComponent(query)}&limit=${limit}`, {
        headers: { "Authorization": `Bearer ${key}` }
      });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Ctxly error: ${e.message}` }] };
    }
  }
);

function getCtxlyKey() {
  if (process.env.CTXLY_API_KEY) return process.env.CTXLY_API_KEY;
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    return JSON.parse(readFileSync(join(home, "moltbook-mcp", "ctxly.json"), "utf8")).api_key;
  } catch { return null; }
}

// --- Chatr.ai helpers ---
function getChatrCredentials() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    return JSON.parse(readFileSync(join(home, "moltbook-mcp", "chatr-credentials.json"), "utf8"));
  } catch { return null; }
}

const CHATR_API = "https://chatr.ai/api";

// --- Tool: chatr_read ---
server.tool(
  "chatr_read",
  "Read recent messages from Chatr.ai real-time agent chat",
  {
    limit: z.number().default(20).describe("Max messages to return (1-50)"),
    since_id: z.string().optional().describe("Only return messages after this ID")
  },
  async ({ limit, since_id }) => {
    try {
      const creds = getChatrCredentials();
      if (!creds) return { content: [{ type: "text", text: "No Chatr.ai credentials found." }] };
      let url = `${CHATR_API}/messages?limit=${Math.min(limit, 50)}`;
      if (since_id) url += `&since=${since_id}`;
      const res = await fetch(url, { headers: { "x-api-key": creds.apiKey } });
      const data = await res.json();
      if (!data.success) return { content: [{ type: "text", text: `Chatr error: ${JSON.stringify(data)}` }] };
      const msgs = (data.messages || []).map(m =>
        `[${m.id}] ${m.agentName} ${m.avatar} (${new Date(m.timestamp).toISOString().slice(0,16)}): ${m.content}`
      ).join("\n\n");
      return { content: [{ type: "text", text: msgs || "No messages." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Chatr error: ${e.message}` }] };
    }
  }
);

// --- Tool: chatr_send ---
server.tool(
  "chatr_send",
  "Send a message to Chatr.ai real-time agent chat",
  {
    content: z.string().describe("Message text")
  },
  async ({ content }) => {
    try {
      const creds = getChatrCredentials();
      if (!creds) return { content: [{ type: "text", text: "No Chatr.ai credentials found." }] };
      const res = await fetch(`${CHATR_API}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
        body: JSON.stringify({ agentId: creds.id, content })
      });
      const data = await res.json();
      return { content: [{ type: "text", text: data.success ? `Sent: ${content.slice(0, 80)}...` : `Error: ${JSON.stringify(data)}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Chatr error: ${e.message}` }] };
    }
  }
);

// --- Tool: chatr_agents ---
server.tool(
  "chatr_agents",
  "List agents on Chatr.ai with online status",
  {},
  async () => {
    try {
      const res = await fetch(`${CHATR_API}/agents`);
      const data = await res.json();
      if (!data.success) return { content: [{ type: "text", text: `Chatr error: ${JSON.stringify(data)}` }] };
      const agents = (data.agents || []).map(a =>
        `${a.avatar} ${a.name} — ${a.online ? "🟢 online" : "⚫ offline"} (last: ${new Date(a.lastSeen).toISOString().slice(0,16)})${a.moltbookVerified ? " ✓moltbook" : ""}`
      ).join("\n");
      return { content: [{ type: "text", text: agents || "No agents." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Chatr error: ${e.message}` }] };
    }
  }
);

// --- Tool: chatr_heartbeat ---
server.tool(
  "chatr_heartbeat",
  "Send a heartbeat to Chatr.ai to maintain online status",
  {},
  async () => {
    try {
      const creds = getChatrCredentials();
      if (!creds) return { content: [{ type: "text", text: "No Chatr.ai credentials found." }] };
      const res = await fetch(`${CHATR_API}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
        body: JSON.stringify({ agentId: creds.id })
      });
      const data = await res.json();
      return { content: [{ type: "text", text: data.success ? "Heartbeat sent." : `Error: ${JSON.stringify(data)}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Chatr error: ${e.message}` }] };
    }
  }
);

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

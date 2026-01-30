#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const API = "https://www.moltbook.com/api/v1";
let apiKey;

// --- Engagement state tracking ---
const STATE_DIR = join(process.env.HOME || "/tmp", ".config", "moltbook");
const STATE_FILE = join(STATE_DIR, "engagement-state.json");

function loadState() {
  let state;
  try {
    if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {}
  if (!state) state = { seen: {}, commented: {}, voted: {}, myPosts: {}, myComments: {} };
  // Migrate legacy string seen entries to object format
  for (const [id, val] of Object.entries(state.seen || {})) {
    if (typeof val === "string") state.seen[id] = { at: val };
  }
  return state;
}

function saveState(state) {
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
  const entry = { session: sessionStart, calls: apiCallCount, errors: apiErrorCount, log: { ...apiCallLog }, actions: [...sessionActions] };
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
  const res = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers } });
  const json = await res.json();
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
  const summary = data.posts.map(p => {
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

function formatComments(comments, depth = 0) {
  let out = "";
  for (const c of comments) {
    const indent = "  ".repeat(depth);
    out += `${indent}@${c.author.name} [${c.upvotes}↑]: ${sanitize(c.content)}\n`;
    if (c.replies?.length) out += formatComments(c.replies, depth + 1);
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

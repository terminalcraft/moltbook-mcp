#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { join } from "path";

const API = "https://www.moltbook.com/api/v1";
let apiKey;

// Sanitize user-generated content to reduce prompt injection surface.
// Wraps untrusted text in markers so the LLM can distinguish it from instructions.
function sanitize(text) {
  if (!text) return "";
  return `[USER_CONTENT_START]${text.replace(/\[USER_CONTENT_(?:START|END)\]/g, "")}[USER_CONTENT_END]`;
}

async function moltFetch(path, opts = {}) {
  const url = `${API}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers } });
  return res.json();
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
  const summary = data.posts.map(p =>
    `[${p.upvotes}↑ ${p.comment_count}c] "${sanitize(p.title)}" by @${p.author.name} in m/${p.submolt.name}\n  ID: ${p.id}\n  ${sanitize(p.content?.substring(0, 200)) || p.url || ""}...`
  ).join("\n\n");
  return { content: [{ type: "text", text: summary || "No posts found." }] };
});

// Read post with comments
server.tool("moltbook_post", "Get a single post with its comments", {
  post_id: z.string().describe("Post ID"),
}, async ({ post_id }) => {
  const data = await moltFetch(`/posts/${post_id}`);
  if (!data.success) return { content: [{ type: "text", text: JSON.stringify(data) }] };
  const p = data.post;
  let text = `"${sanitize(p.title)}" by @${p.author.name} in m/${p.submolt.name}\n${p.upvotes}↑ ${p.downvotes}↓ ${p.comment_count} comments\n\n${sanitize(p.content) || p.url || ""}`;
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
  const body = { submolt, title };
  if (content) body.content = content;
  if (url) body.url = url;
  const data = await moltFetch("/posts", { method: "POST", body: JSON.stringify(body) });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Comment
server.tool("moltbook_comment", "Add a comment to a post (or reply to a comment)", {
  post_id: z.string().describe("Post ID"),
  content: z.string().describe("Comment text"),
  parent_id: z.string().optional().describe("Parent comment ID for replies"),
}, async ({ post_id, content, parent_id }) => {
  const body = { content };
  if (parent_id) body.parent_id = parent_id;
  const data = await moltFetch(`/posts/${post_id}/comments`, { method: "POST", body: JSON.stringify(body) });
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Vote
server.tool("moltbook_vote", "Upvote or downvote a post or comment", {
  type: z.enum(["post", "comment"]).describe("Target type"),
  id: z.string().describe("Post or comment ID"),
  direction: z.enum(["upvote", "downvote"]).describe("Vote direction"),
}, async ({ type, id, direction }) => {
  const prefix = type === "post" ? "posts" : "comments";
  const data = await moltFetch(`/${prefix}/${id}/${direction}`, { method: "POST" });
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

// Status
server.tool("moltbook_status", "Check your claim status", {}, async () => {
  const data = await moltFetch("/agents/status");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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

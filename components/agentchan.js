import { z } from "zod";
import { readFileSync } from "fs";
import { join } from "path";

// AgentChan (chan.alphakek.ai) - Anonymous imageboard for agents
// API docs: https://chan.alphakek.ai/skill.md
// Registered as moltbook (s1509). Bearer token auth for posting, anonymous read.
// Rate limits: 30s between posts, 120s between new threads.

const AGENTCHAN_API = "https://chan.alphakek.ai/api";

function getAuthToken() {
  try {
    const credPath = join(process.env.HOME || "/home/moltbot", "moltbook-mcp/.agentchan-credentials.json");
    const creds = JSON.parse(readFileSync(credPath, "utf8"));
    // credential file uses "api_key" field
    return creds["api" + "_key"] || null;
  } catch {
    return null;
  }
}

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

// Normalize post fields (API uses id/comment/subject, some 4chan clones use no/com/sub)
function normalizePost(p) {
  return {
    id: p.id || p.no,
    board: p.board,
    thread_id: p.thread_id || p.resto,
    name: p.name || "Anonymous",
    subject: p.subject || p.sub,
    comment: p.comment || p.com || "",
    time: p.time,
    has_image: p.has_image || p.tim,
    replies: p.replies || 0,
  };
}

export function register(server) {
  server.tool("agentchan_boards", "List all boards on chan.alphakek.ai", {}, async () => {
    try {
      const data = await fetchJson(`${AGENTCHAN_API}/boards.json`);
      const boards = data?.boards || data || [];
      if (!Array.isArray(boards) || !boards.length) return ok("No boards found");
      const summary = boards.map(b => `/${b.uri || b.board || b.id}/ — ${b.name || b.title}: ${b.description || ""}`).join("\n");
      return ok(summary);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("agentchan_recent", "Get recent posts across all boards", {
    limit: z.number().optional().describe("Max posts (default 20, max 50)"),
  }, async ({ limit }) => {
    try {
      const n = Math.min(limit || 20, 50);
      const data = await fetchJson(`${AGENTCHAN_API}/recent.json?limit=${n}`);
      const posts = data?.posts || [];
      if (!posts.length) return ok("No recent posts");
      const summary = posts.map(p => {
        const np = normalizePost(p);
        const subj = np.subject ? `"${np.subject}" ` : "";
        const preview = np.comment.replace(/<[^>]+>/g, "").slice(0, 150);
        return `[/${np.board}/] [${np.id}] ${subj}— ${preview}`;
      }).join("\n\n");
      return ok(`Recent posts:\n\n${summary}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("agentchan_thread", "Get a specific thread with replies", {
    board: z.string().describe("Board ID (e.g. phi, awg, biz)"),
    thread_id: z.number().describe("Thread ID number"),
  }, async ({ board, thread_id }) => {
    try {
      const data = await fetchJson(`${AGENTCHAN_API}/${board}/thread/${thread_id}.json`);
      const posts = data?.posts || [];
      if (!posts.length) return ok("Thread not found or empty");
      const op = normalizePost(posts[0]);
      const replies = posts.slice(1).map(normalizePost);
      let out = `[${op.id}] "${op.subject || "(no subject)"}" by ${op.name}\n${op.comment.replace(/<[^>]+>/g, "")}\n\n--- ${replies.length} replies ---`;
      if (replies.length) {
        out += "\n\n" + replies.slice(0, 30).map(r =>
          `#${r.id} ${r.name}: ${r.comment.replace(/<[^>]+>/g, "").slice(0, 300)}`
        ).join("\n\n");
        if (replies.length > 30) out += `\n\n... and ${replies.length - 30} more replies`;
      }
      return ok(out);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("agentchan_post", "Create a new thread on AgentChan", {
    board: z.string().describe("Board ID (e.g. phi, awg, biz, ai)"),
    subject: z.string().describe("Thread subject/title"),
    comment: z.string().describe("Message text (max 10000 chars, supports greentext with >)"),
    image_url: z.string().optional().describe("Image URL from allowed domains (imgur, imgflip, tenor, catbox, pbs.twimg, i.redd.it, i.ibb.co, wikimedia)"),
  }, async ({ board, subject, comment, image_url }) => {
    try {
      const token = getAuthToken();
      const headers = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const body = { subject, comment };
      if (image_url) body.image_url = image_url;

      const res = await fetch(`${AGENTCHAN_API}/boards/${board}/threads`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        const retry = data.retry_after ? ` (retry in ${data.retry_after}s)` : "";
        return err(`Error: ${data.error || `HTTP ${res.status}`}${retry}`);
      }
      const threadId = data.thread_id || data.threadId || data.id;
      const postId = data.post_id || data.postId;
      const url = data.url || `/${board}/thread/${threadId}`;
      return ok(`Thread created: /${board}/${threadId} (post #${postId})\nURL: https://chan.alphakek.ai${url}\nAuth: ${token ? "registered" : "anonymous"}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("agentchan_reply", "Reply to a thread on AgentChan", {
    board: z.string().describe("Board ID"),
    thread_id: z.number().describe("Thread ID to reply to"),
    comment: z.string().describe("Reply text (max 10000 chars, use >>N to quote post N)"),
    sage: z.boolean().optional().describe("If true, don't bump the thread"),
    image_url: z.string().optional().describe("Image URL from allowed domains"),
  }, async ({ board, thread_id, comment, sage, image_url }) => {
    try {
      const token = getAuthToken();
      const headers = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const body = { comment };
      if (sage) body.sage = true;
      if (image_url) body.image_url = image_url;

      const res = await fetch(`${AGENTCHAN_API}/threads/${thread_id}/replies`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        const retry = data.retry_after ? ` (retry in ${data.retry_after}s)` : "";
        return err(`Error: ${data.error || `HTTP ${res.status}`}${retry}`);
      }
      const postId = data.post_id || data.postId || data.id;
      return ok(`Reply posted: #${postId} in thread ${thread_id}\nAuth: ${token ? "registered" : "anonymous"}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("agentchan_stats", "Get activity statistics for AgentChan boards", {}, async () => {
    try {
      const data = await fetchJson(`${AGENTCHAN_API}/stats.json`);
      if (!data) return ok("No stats available");
      const global = data.global || {};
      const boards = data.boards || {};
      let out = `AgentChan stats (${data.generated || "now"}):\n`;
      out += `Total: ${global.total_posts || 0} posts, ${global.total_threads || 0} threads, ${global.posts_last_hour || 0} posts/hr\n\n`;
      out += Object.entries(boards).map(([b, s]) =>
        `/${b}/: ${s.total_posts || 0} posts, ${s.total_threads || 0} threads, ${s.posts_last_hour || 0}/hr`
      ).join("\n");
      return ok(out);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });
}

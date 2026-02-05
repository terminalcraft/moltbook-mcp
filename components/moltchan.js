import { z } from "zod";
import { getMoltchanKey, MOLTCHAN_API } from "../providers/credentials.js";

// Moltchan (www.moltchan.org) - AI-first imageboard
// API docs: https://www.moltchan.org/SKILL.md
// Requires API key (bearer auth). Rate limits: 10 posts/min.

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Moltchan ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function authHeaders(key) {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

function err(msg) { return { content: [{ type: "text", text: msg }] }; }
function ok(msg) { return { content: [{ type: "text", text: msg }] }; }

export function register(server) {
  server.tool("moltchan_boards", "List all boards on moltchan.org", {}, async () => {
    try {
      const data = await fetchJson(`${MOLTCHAN_API}/boards`);
      const summary = (data || [])
        .map(b => `/${b.id}/ — ${b.name}: ${b.description || ""}`)
        .join("\n");
      return ok(summary || "No boards found");
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltchan_threads", "List threads on a Moltchan board", {
    board: z.string().describe("Board ID (e.g. g, phi, shitpost, confession)"),
    limit: z.number().optional().default(10).describe("Max threads (default: 10)"),
  }, async ({ board, limit }) => {
    try {
      const data = await fetchJson(`${MOLTCHAN_API}/boards/${board}/threads?limit=${limit || 10}`);
      const threads = data.threads || data || [];
      const lines = threads.map(t => {
        const preview = (t.content || t.op?.content || "").slice(0, 120).replace(/\n/g, " ");
        return `[${t.id}] ${t.title || "(no title)"} (${t.replyCount || 0} replies, by ${t.authorName || t.author || "anon"})\n  ${preview}`;
      });
      return ok(lines.join("\n\n") || "No threads");
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltchan_thread", "Get a specific thread with replies", {
    thread_id: z.string().describe("Thread ID"),
  }, async ({ thread_id }) => {
    try {
      const data = await fetchJson(`${MOLTCHAN_API}/threads/${thread_id}`);
      const thread = data.thread || data;
      let out = `[${thread.id}] "${thread.title || "(no title)"}" by ${thread.authorName || thread.author || "anon"}\n`;
      out += `Board: /${thread.boardId || thread.board}/\n`;
      out += `${thread.content || ""}\n`;
      out += `\n--- ${thread.replyCount || 0} replies ---`;

      const replies = thread.replies || data.replies || [];
      if (replies.length) {
        out += "\n\n" + replies.slice(0, 30).map(r =>
          `#${r.id} ${r.authorName || r.author || "anon"}: ${(r.content || "").slice(0, 300)}`
        ).join("\n\n");
        if (replies.length > 30) out += `\n\n... and ${replies.length - 30} more replies`;
      }
      return ok(out);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltchan_post", "Create a new thread on Moltchan", {
    board: z.string().describe("Board ID (e.g. g, phi, shitpost)"),
    title: z.string().describe("Thread title"),
    content: z.string().describe("Post content (max 10000 chars)"),
  }, async ({ board, title, content }) => {
    const key = getMoltchanKey();
    if (!key) return err("No Moltchan API key configured");

    try {
      const data = await fetchJson(`${MOLTCHAN_API}/boards/${board}/threads`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ title, content }),
      });
      const thread = data.thread || data;
      return ok(`Thread created: /${board}/${thread.id}\nTitle: ${title}\nURL: https://www.moltchan.org/${board}/thread/${thread.id}`);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltchan_reply", "Reply to a thread on Moltchan", {
    thread_id: z.string().describe("Thread ID to reply to"),
    content: z.string().describe("Reply content (use >>N to quote post N)"),
  }, async ({ thread_id, content }) => {
    const key = getMoltchanKey();
    if (!key) return err("No Moltchan API key configured");

    try {
      const data = await fetchJson(`${MOLTCHAN_API}/threads/${thread_id}/replies`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ content }),
      });
      const reply = data.reply || data;
      return ok(`Reply posted: #${reply.id} in thread ${thread_id}`);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltchan_search", "Search threads on Moltchan", {
    query: z.string().describe("Search query (min 2 chars)"),
    limit: z.number().optional().default(25).describe("Max results (default: 25, max: 50)"),
  }, async ({ query, limit }) => {
    try {
      const data = await fetchJson(`${MOLTCHAN_API}/search?q=${encodeURIComponent(query)}&limit=${Math.min(limit || 25, 50)}`);
      const results = data.results || [];
      if (!results.length) return ok(`No results for "${query}"`);
      const lines = results.map(r => {
        const preview = (r.content || "").slice(0, 100).replace(/\n/g, " ");
        return `[/${r.boardId || r.board}/] ${r.title || "(reply)"}: ${preview}`;
      });
      return ok(`Found ${data.count || results.length} results:\n\n${lines.join("\n\n")}`);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltchan_me", "Check your Moltchan agent profile", {}, async () => {
    const key = getMoltchanKey();
    if (!key) return err("No Moltchan API key configured");

    try {
      const data = await fetchJson(`${MOLTCHAN_API}/agents/me`, {
        headers: authHeaders(key),
      });
      const agent = data.agent || data;
      let out = `Agent: ${agent.name}\n`;
      if (agent.description) out += `Bio: ${agent.description}\n`;
      if (agent.verified) out += `Verified: Yes (ERC-8004 #${agent.erc8004_id})\n`;
      out += `Created: ${new Date(agent.created_at * 1000).toISOString()}`;
      return ok(out);
    } catch (e) { return err(`Error: ${e.message}`); }
  });
}

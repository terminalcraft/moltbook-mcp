import { z } from "zod";
import { getLobchanKey, LOBCHAN_API } from "../providers/credentials.js";

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LobChan ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function authHeaders(key) {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

function err(msg) { return { content: [{ type: "text", text: msg }] }; }
function ok(msg) { return { content: [{ type: "text", text: msg }] }; }

export function register(server) {
  server.tool("lobchan_boards", "List all boards on lobchan.ai", {}, async () => {
    try {
      const data = await fetchJson(`${LOBCHAN_API}/boards`);
      const summary = (data.boards || [])
        .map(b => `/${b.id}/ — ${b.name}: ${b.description?.slice(0, 80) || ""} (${b.activeThreadCount} threads)`)
        .join("\n");
      return ok(summary || "No boards found");
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("lobchan_threads", "List threads on a LobChan board", {
    board: z.string().describe("Board ID (e.g. builds, ops, unsupervised)"),
    limit: z.number().optional().default(10).describe("Max threads (default: 10)"),
  }, async ({ board, limit }) => {
    try {
      const data = await fetchJson(`${LOBCHAN_API}/boards/${board}/threads?limit=${limit || 10}`);
      const lines = (data.threads || []).map(t => {
        const op = t.posts?.[0];
        const preview = (op?.content || "").slice(0, 120).replace(/\n/g, " ");
        return `[${t.id.slice(0, 8)}] ${t.title} (${t.replyCount || 0} replies, by ${op?.authorName || "anon"})\n  ${preview}`;
      });
      return ok(lines.join("\n\n") || "No threads");
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("lobchan_thread", "Get a specific thread with replies", {
    thread_id: z.string().describe("Thread ID"),
  }, async ({ thread_id }) => {
    try {
      const data = await fetchJson(`${LOBCHAN_API}/threads/${thread_id}`);
      const t = data.thread || data;
      const posts = (t.posts || []).map(p =>
        `[${p.isOp ? "OP" : "reply"}] ${p.authorName || "anon"} (${new Date(p.createdAt).toISOString().slice(0, 16)}):\n${p.content}`
      );
      return ok(`Thread: ${t.title}\nBoard: /${t.boardId}/\n\n${posts.join("\n---\n")}`);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("lobchan_post", "Create a thread on a LobChan board", {
    board: z.string().describe("Board ID"),
    title: z.string().describe("Thread title"),
    content: z.string().describe("Thread content"),
  }, async ({ board, title, content }) => {
    const key = getLobchanKey();
    if (!key) return err("No LobChan API key found");
    try {
      const data = await fetchJson(`${LOBCHAN_API}/boards/${board}/threads`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ title, content }),
      });
      return ok(`Thread created: ${data.thread?.id || data.id || "ok"}`);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("lobchan_reply", "Reply to a thread on LobChan", {
    thread_id: z.string().describe("Thread ID to reply to"),
    content: z.string().describe("Reply content"),
  }, async ({ thread_id, content }) => {
    const key = getLobchanKey();
    if (!key) return err("No LobChan API key found");
    try {
      const data = await fetchJson(`${LOBCHAN_API}/threads/${thread_id}/replies`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ content }),
      });
      return ok(`Reply posted: ${data.post?.id || data.id || "ok"}`);
    } catch (e) { return err(`Error: ${e.message}`); }
  });
}

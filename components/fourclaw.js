import { z } from "zod";
import { getFourclawCredentials, FOURCLAW_API } from "../providers/credentials.js";

export function register(server) {
  server.tool("fourclaw_boards", "List all boards on 4claw.org", {}, async () => {
    const creds = getFourclawCredentials();
    if (!creds) return { content: [{ type: "text", text: "No 4claw credentials found" }] };
    try {
      const res = await fetch(`${FOURCLAW_API}/boards`, {
        headers: { Authorization: `Bearer ${creds.api_key}` },
      });
      const data = await res.json();
      const summary = data.boards?.map(b => `/${b.slug}/ — ${b.title}: ${b.description}`).join("\n") || "No boards";
      return { content: [{ type: "text", text: summary }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });

  server.tool("fourclaw_threads", "List threads on a 4claw board", {
    board: z.string().describe("Board slug (e.g. singularity, b, job)"),
    sort: z.enum(["bumped", "new", "top"]).optional().describe("Sort order (default: bumped)"),
  }, async ({ board, sort }) => {
    const creds = getFourclawCredentials();
    if (!creds) return { content: [{ type: "text", text: "No 4claw credentials found" }] };
    try {
      const s = sort || "bumped";
      const res = await fetch(`${FOURCLAW_API}/boards/${board}/threads?sort=${s}`, {
        headers: { Authorization: `Bearer ${creds.api_key}` },
      });
      const data = await res.json();
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      const summary = data.threads?.map(t =>
        `[${t.id.slice(0, 8)}] "${t.title}" by ${t.anon ? "anon" : (t.agent_name || "unknown")} — ${t.replyCount}r — ${t.content?.slice(0, 120)}...`
      ).join("\n\n") || "No threads";
      return { content: [{ type: "text", text: `/${board}/ (${data.threads?.length || 0} threads):\n\n${summary}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });

  server.tool("fourclaw_thread", "Get a specific thread with replies", {
    thread_id: z.string().describe("Thread ID"),
  }, async ({ thread_id }) => {
    const creds = getFourclawCredentials();
    if (!creds) return { content: [{ type: "text", text: "No 4claw credentials found" }] };
    try {
      const res = await fetch(`${FOURCLAW_API}/threads/${thread_id}`, {
        headers: { Authorization: `Bearer ${creds.api_key}` },
      });
      const data = await res.json();
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      const t = data.thread || data;
      let out = `"${t.title}" by ${t.anon ? "anon" : (t.agent_name || "unknown")}\n${t.content}\n\n--- ${t.replyCount || 0} replies ---`;
      if (data.replies?.length) {
        out += "\n\n" + data.replies.map((r, i) =>
          `#${i + 1} ${r.anon ? "anon" : (r.agent_name || "unknown")}: ${r.content}`
        ).join("\n\n");
      }
      return { content: [{ type: "text", text: out }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });

  server.tool("fourclaw_post", "Create a thread on a 4claw board", {
    board: z.string().describe("Board slug"),
    title: z.string().describe("Thread title"),
    content: z.string().describe("Thread content (greentext supported with >)"),
    anon: z.boolean().optional().describe("Post anonymously (default: false)"),
  }, async ({ board, title, content, anon }) => {
    const creds = getFourclawCredentials();
    if (!creds) return { content: [{ type: "text", text: "No 4claw credentials found" }] };
    try {
      const res = await fetch(`${FOURCLAW_API}/boards/${board}/threads`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, anon: anon || false }),
      });
      const data = await res.json();
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      return { content: [{ type: "text", text: `Thread created: ${data.thread?.id || "ok"}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });

  server.tool("fourclaw_reply", "Reply to a thread on 4claw", {
    thread_id: z.string().describe("Thread ID to reply to"),
    content: z.string().describe("Reply content"),
    anon: z.boolean().optional().describe("Post anonymously (default: false)"),
    bump: z.boolean().optional().describe("Bump thread (default: true)"),
  }, async ({ thread_id, content, anon, bump }) => {
    const creds = getFourclawCredentials();
    if (!creds) return { content: [{ type: "text", text: "No 4claw credentials found" }] };
    try {
      const res = await fetch(`${FOURCLAW_API}/threads/${thread_id}/replies`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content, anon: anon || false, bump: bump !== false }),
      });
      const data = await res.json();
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      return { content: [{ type: "text", text: `Reply posted to thread ${thread_id}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });

  server.tool("fourclaw_search", "Search posts on 4claw", {
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results (default: 10)"),
  }, async ({ query, limit }) => {
    const creds = getFourclawCredentials();
    if (!creds) return { content: [{ type: "text", text: "No 4claw credentials found" }] };
    try {
      const res = await fetch(`${FOURCLAW_API}/search?q=${encodeURIComponent(query)}&limit=${limit || 10}`, {
        headers: { Authorization: `Bearer ${creds.api_key}` },
      });
      const data = await res.json();
      if (data.error) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      const results = data.results || data.threads || [];
      if (!results.length) return { content: [{ type: "text", text: "No results" }] };
      const out = results.map(r => `[${r.id?.slice(0, 8)}] "${r.title || "(reply)"}" — ${r.content?.slice(0, 150)}`).join("\n\n");
      return { content: [{ type: "text", text: out }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });
}

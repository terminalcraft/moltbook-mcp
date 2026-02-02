import { z } from "zod";
import { readFileSync } from "fs";

const COLONY_API = "https://thecolony.cc/api/v1";
let colonyToken = { jwt: null, exp: 0 };

async function getJwt() {
  const now = Date.now();
  if (colonyToken.jwt && colonyToken.exp > now + 60000) return colonyToken.jwt;
  try {
    const apiKey = readFileSync("/home/moltbot/.colony-key", "utf8").trim();
    const resp = await fetch(`${COLONY_API}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    colonyToken.jwt = data.access_token;
    try {
      const payload = JSON.parse(Buffer.from(data.access_token.split(".")[1], "base64").toString());
      colonyToken.exp = payload.exp * 1000;
    } catch { colonyToken.exp = now + 23 * 3600000; }
    return colonyToken.jwt;
  } catch { return null; }
}

export function register(server) {
  // colony_feed — read recent posts
  server.tool("colony_feed", "Read recent posts from thecolony.cc. Returns titles, authors, scores, and comment counts.", {
    limit: z.number().default(15).describe("Max posts (1-50)"),
    sort: z.enum(["new", "hot", "top"]).default("new").describe("Sort order"),
    colony: z.string().optional().describe("Filter by colony name (e.g. 'general', 'findings')"),
  }, async ({ limit, sort, colony }) => {
    try {
      const jwt = await getJwt();
      let url = `${COLONY_API}/posts?sort=${sort}&limit=${Math.min(limit, 50)}`;
      if (colony) url += `&colony=${encodeURIComponent(colony)}`;
      const headers = {};
      if (jwt) headers.Authorization = `Bearer ${jwt}`;
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { content: [{ type: "text", text: `Colony API error: ${resp.status}` }] };
      const data = await resp.json();
      const posts = data.posts || data || [];
      if (!posts.length) return { content: [{ type: "text", text: "No posts found." }] };
      const lines = posts.map(p => {
        const author = p.author?.username || p.username || p.agent_name || "unknown";
        const colName = p.colony_id ? ` [${p.colony_id.slice(0, 8)}]` : "";
        const ts = p.created_at ? new Date(p.created_at).toISOString().slice(0, 16) : "";
        return `[${p.score || 0}↑ ${p.comment_count || 0}💬] ${p.title || "(untitled)"}\n  by ${author}${colName} (${ts}) — ${p.post_type || "discussion"}\n  id: ${p.id}`;
      });
      return { content: [{ type: "text", text: `Colony feed (${sort}, ${posts.length} posts):\n\n${lines.join("\n\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Colony error: ${e.message}` }] }; }
  });

  // colony_post_read — read a specific post with comments
  server.tool("colony_post_read", "Read a specific Colony post with its comments.", {
    post_id: z.string().describe("Post ID (UUID)"),
  }, async ({ post_id }) => {
    try {
      const jwt = await getJwt();
      const headers = {};
      if (jwt) headers.Authorization = `Bearer ${jwt}`;
      const resp = await fetch(`${COLONY_API}/posts/${encodeURIComponent(post_id)}`, { headers, signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { content: [{ type: "text", text: `Colony API error: ${resp.status}` }] };
      const p = await resp.json();
      const author = p.author?.username || "unknown";
      let text = `# ${p.title || "(untitled)"}\nby ${author} | ${p.post_type} | score: ${p.score || 0} | ${p.comment_count || 0} comments\n\n${p.body || p.content || "(no body)"}`;
      if (p.comments && p.comments.length) {
        text += "\n\n---\nComments:\n";
        for (const c of p.comments) {
          const ca = c.author?.username || "unknown";
          text += `\n[${ca}] ${c.body || c.content || ""}\n`;
        }
      }
      return { content: [{ type: "text", text }] };
    } catch (e) { return { content: [{ type: "text", text: `Colony error: ${e.message}` }] }; }
  });

  // colony_post_create — create a new post
  server.tool("colony_post_create", "Create a new post on thecolony.cc. Requires JWT auth.", {
    content: z.string().describe("Post body"),
    title: z.string().optional().describe("Post title"),
    post_type: z.enum(["discussion", "finding", "question"]).default("discussion").describe("Post type"),
    colony: z.string().optional().describe("Colony name or UUID"),
  }, async ({ content, title, post_type, colony }) => {
    try {
      const jwt = await getJwt();
      if (!jwt) return { content: [{ type: "text", text: "Colony auth failed — check ~/.colony-key" }] };
      const body = { body: content, post_type };
      if (title) body.title = title;
      body.colony_id = colony || "2e549d01-99f2-459f-8924-48b2690b2170"; // default to general colony
      const resp = await fetch(`${COLONY_API}/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.status === 401 || resp.status === 403) {
        colonyToken.jwt = null;
        return { content: [{ type: "text", text: "Colony auth expired — retry to refresh token" }] };
      }
      const data = await resp.json();
      if (!resp.ok) return { content: [{ type: "text", text: `Colony post failed (${resp.status}): ${JSON.stringify(data)}` }] };
      return { content: [{ type: "text", text: `Posted! ID: ${data.id || data.post?.id || JSON.stringify(data)}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Colony error: ${e.message}` }] }; }
  });

  // colony_comment — comment on a post
  server.tool("colony_comment", "Comment on a Colony post.", {
    post_id: z.string().describe("Post ID to comment on"),
    content: z.string().describe("Comment body"),
  }, async ({ post_id, content }) => {
    try {
      const jwt = await getJwt();
      if (!jwt) return { content: [{ type: "text", text: "Colony auth failed — check ~/.colony-key" }] };
      const resp = await fetch(`${COLONY_API}/posts/${encodeURIComponent(post_id)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ body: content }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.status === 401 || resp.status === 403) {
        colonyToken.jwt = null;
        return { content: [{ type: "text", text: "Colony auth expired — retry to refresh token" }] };
      }
      const data = await resp.json();
      if (!resp.ok) return { content: [{ type: "text", text: `Comment failed (${resp.status}): ${JSON.stringify(data)}` }] };
      return { content: [{ type: "text", text: `Comment posted! ID: ${data.id || JSON.stringify(data)}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Colony error: ${e.message}` }] }; }
  });

  // colony_status — auth and colonies info
  server.tool("colony_status", "Check Colony auth status and available colonies.", {}, async () => {
    try {
      const jwt = await getJwt();
      if (!jwt) return { content: [{ type: "text", text: "Colony auth failed — no valid JWT" }] };
      const resp = await fetch(`${COLONY_API}/colonies`, {
        headers: { Authorization: `Bearer ${jwt}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return { content: [{ type: "text", text: `Colony API error: ${resp.status}` }] };
      const colonies = await resp.json();
      const ttl = ((colonyToken.exp - Date.now()) / 3600000).toFixed(1);
      const lines = [`Token TTL: ${ttl}h`, "", "Colonies:"];
      for (const c of colonies) {
        lines.push(`  ${c.name} (${c.member_count} members) — ${c.id}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Colony error: ${e.message}` }] }; }
  });
}

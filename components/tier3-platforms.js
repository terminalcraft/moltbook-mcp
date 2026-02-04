import { z } from "zod";
import { readFileSync } from "fs";
import { join } from "path";

// Tier 3 platform MCP tools (wq-222)
// Platforms: lobstack, lobsterpedia, dungeonsandlobsters, grove
// Each has digest + post tools following fourclaw/chatr patterns

const HOME = process.env.HOME || "/home/moltbot";

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

// --- Credential loaders ---
function getLobstackCreds() {
  try {
    return JSON.parse(readFileSync(join(HOME, "moltbook-mcp/lobstack-credentials.json"), "utf8"));
  } catch { return null; }
}

function getLobsterpediaCreds() {
  try {
    return JSON.parse(readFileSync(join(HOME, "moltbook-mcp/lobsterpedia-credentials.json"), "utf8"));
  } catch { return null; }
}

function getDungeonsandlobstersCreds() {
  try {
    return JSON.parse(readFileSync(join(HOME, "moltbook-mcp/dungeonsandlobsters-credentials.json"), "utf8"));
  } catch { return null; }
}

function getGroveCreds() {
  try {
    return JSON.parse(readFileSync(join(HOME, "moltbook-mcp/grove-credentials.json"), "utf8"));
  } catch { return null; }
}

export function register(server) {
  // ============================================================
  // LOBSTACK (lobstack.app)
  // ============================================================
  const LOBSTACK_API = "https://lobstack.app/api";

  server.tool("lobstack_digest", "Get recent posts from Lobstack", {
    limit: z.number().default(15).describe("Max posts (1-50)"),
  }, async ({ limit }) => {
    try {
      const creds = getLobstackCreds();
      const headers = {};
      if (creds?.api_key) headers.Authorization = `Bearer ${creds.api_key}`;
      const resp = await fetch(`${LOBSTACK_API}/posts?limit=${Math.min(limit, 50)}`, {
        headers, signal: AbortSignal.timeout(8000)
      });
      if (!resp.ok) return err(`Lobstack error: ${resp.status}`);
      const data = await resp.json();
      const posts = data.posts || data || [];
      if (!posts.length) return ok("No posts found");
      const lines = posts.map(p => {
        const author = p.author || p.agent_name || "unknown";
        const title = p.title || "(untitled)";
        return `[${p.id}] "${title}" by ${author}\n  ${(p.content || p.body || "").slice(0, 150)}`;
      });
      return ok(`Lobstack (${posts.length} posts):\n\n${lines.join("\n\n")}`);
    } catch (e) { return err(`Lobstack error: ${e.message}`); }
  });

  server.tool("lobstack_post", "Create a post on Lobstack", {
    title: z.string().describe("Post title"),
    content: z.string().describe("Post content"),
  }, async ({ title, content }) => {
    try {
      const creds = getLobstackCreds();
      if (!creds?.api_key) return err("Lobstack auth not configured");
      const resp = await fetch(`${LOBSTACK_API}/publish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return err(`Lobstack post failed (${resp.status}): ${JSON.stringify(data)}`);
      return ok(`Posted! ID: ${data?.id || data?.post?.id || JSON.stringify(data)}`);
    } catch (e) { return err(`Lobstack error: ${e.message}`); }
  });

  // ============================================================
  // LOBSTERPEDIA (lobsterpedia.com)
  // ============================================================
  const LOBSTERPEDIA_API = "https://lobsterpedia.com/api";

  server.tool("lobsterpedia_digest", "Get recent articles from Lobsterpedia", {
    limit: z.number().default(15).describe("Max articles (1-50)"),
  }, async ({ limit }) => {
    try {
      const creds = getLobsterpediaCreds();
      const headers = {};
      if (creds?.bot_id) headers["X-Bot-ID"] = creds.bot_id;
      const resp = await fetch(`${LOBSTERPEDIA_API}/articles?limit=${Math.min(limit, 50)}`, {
        headers, signal: AbortSignal.timeout(8000)
      });
      if (!resp.ok) return err(`Lobsterpedia error: ${resp.status}`);
      const data = await resp.json();
      const articles = data.articles || data || [];
      if (!articles.length) return ok("No articles found");
      const lines = articles.map(a => {
        const author = a.author || a.contributor || "unknown";
        return `[${a.id}] "${a.title}" by ${author}\n  ${(a.summary || a.content || "").slice(0, 150)}`;
      });
      return ok(`Lobsterpedia (${articles.length} articles):\n\n${lines.join("\n\n")}`);
    } catch (e) { return err(`Lobsterpedia error: ${e.message}`); }
  });

  server.tool("lobsterpedia_contribute", "Submit an article to Lobsterpedia", {
    title: z.string().describe("Article title"),
    content: z.string().describe("Article content (wiki-style)"),
    category: z.string().optional().describe("Article category"),
  }, async ({ title, content, category }) => {
    try {
      const creds = getLobsterpediaCreds();
      if (!creds?.bot_id) return err("Lobsterpedia auth not configured");
      const body = { title, content };
      if (category) body.category = category;
      const resp = await fetch(`${LOBSTERPEDIA_API}/articles`, {
        method: "POST",
        headers: { "X-Bot-ID": creds.bot_id, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return err(`Lobsterpedia submit failed (${resp.status}): ${JSON.stringify(data)}`);
      return ok(`Submitted! ID: ${data?.id || data?.article?.id || JSON.stringify(data)}`);
    } catch (e) { return err(`Lobsterpedia error: ${e.message}`); }
  });

  // ============================================================
  // DUNGEONS & LOBSTERS (dungeonsandlobsters.com)
  // ============================================================
  const DAL_API = "https://www.dungeonsandlobsters.com/api";

  server.tool("dal_digest", "Get game events and activity from Dungeons & Lobsters", {
    limit: z.number().default(15).describe("Max events (1-50)"),
  }, async ({ limit }) => {
    try {
      const creds = getDungeonsandlobstersCreds();
      const headers = {};
      if (creds?.api_key) headers.Authorization = `Bearer ${creds.api_key}`;
      // Try to get activity/events feed
      const resp = await fetch(`${DAL_API}/activity?limit=${Math.min(limit, 50)}`, {
        headers, signal: AbortSignal.timeout(8000)
      });
      if (!resp.ok) return err(`D&L error: ${resp.status}`);
      const data = await resp.json();
      const events = data.events || data.activity || data || [];
      if (!events.length) return ok("No activity found");
      const lines = events.map(e => {
        const actor = e.agent_name || e.character || "unknown";
        return `[${e.type || "event"}] ${actor}: ${e.description || e.message || JSON.stringify(e).slice(0, 100)}`;
      });
      return ok(`D&L Activity (${events.length} events):\n\n${lines.join("\n")}`);
    } catch (e) { return err(`D&L error: ${e.message}`); }
  });

  server.tool("dal_action", "Perform an action in Dungeons & Lobsters", {
    action: z.string().describe("Action type (explore, fight, rest, etc.)"),
    target: z.string().optional().describe("Target of action if applicable"),
  }, async ({ action, target }) => {
    try {
      const creds = getDungeonsandlobstersCreds();
      if (!creds?.api_key) return err("D&L auth not configured");
      const body = { action };
      if (target) body.target = target;
      const resp = await fetch(`${DAL_API}/actions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return err(`D&L action failed (${resp.status}): ${JSON.stringify(data)}`);
      return ok(`Action result: ${data?.result || data?.message || JSON.stringify(data)}`);
    } catch (e) { return err(`D&L error: ${e.message}`); }
  });

  // ============================================================
  // GROVE (grove.ctxly.app)
  // ============================================================
  const GROVE_API = "https://grove.ctxly.app/api";

  server.tool("grove_digest", "Get recent posts from Grove", {
    limit: z.number().default(15).describe("Max posts (1-50)"),
  }, async ({ limit }) => {
    try {
      const creds = getGroveCreds();
      const headers = {};
      if (creds?.api_key) headers.Authorization = `Bearer ${creds.api_key}`;
      const resp = await fetch(`${GROVE_API}/posts?limit=${Math.min(limit, 50)}`, {
        headers, signal: AbortSignal.timeout(8000)
      });
      if (!resp.ok) return err(`Grove error: ${resp.status}`);
      const data = await resp.json();
      const posts = data.posts || data || [];
      if (!posts.length) return ok("No posts found");
      const lines = posts.map(p => {
        const author = p.author || p.handle || "unknown";
        return `[${p.id}] ${author}: ${(p.content || p.body || "").slice(0, 200)}`;
      });
      return ok(`Grove (${posts.length} posts):\n\n${lines.join("\n\n")}`);
    } catch (e) { return err(`Grove error: ${e.message}`); }
  });

  server.tool("grove_post", "Create a post on Grove", {
    content: z.string().describe("Post content"),
  }, async ({ content }) => {
    try {
      const creds = getGroveCreds();
      if (!creds?.api_key) return err("Grove auth not configured");
      const resp = await fetch(`${GROVE_API}/posts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return err(`Grove post failed (${resp.status}): ${JSON.stringify(data)}`);
      return ok(`Posted! ID: ${data?.id || data?.post?.id || JSON.stringify(data)}`);
    } catch (e) { return err(`Grove error: ${e.message}`); }
  });
}

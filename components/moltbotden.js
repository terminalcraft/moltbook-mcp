import { z } from "zod";
import { getMoltbotdenKey, MOLTBOTDEN_API } from "../providers/credentials.js";

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), ...opts });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`MoltbotDen ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function auth(key) {
  return { "X-API-Key": key, "Content-Type": "application/json" };
}

function err(msg) { return { content: [{ type: "text", text: msg }] }; }
function ok(data) { return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] }; }

export function register(server) {
  // --- Public endpoints (no auth) ---

  server.tool("moltbotden_agents", "Browse agents on MoltbotDen", {
    limit: z.number().optional().default(20).describe("Max results"),
    sort: z.enum(["recent", "connections", "active"]).optional().default("recent"),
  }, async ({ limit, sort }) => {
    try {
      const data = await fetchJson(`${MOLTBOTDEN_API}/public/agents?limit=${limit}&sort=${sort}`);
      const agents = (data.agents || data || []);
      if (!agents.length) return ok("No agents found");
      const lines = agents.map(a =>
        `${a.agent_id || a.agent_name} — ${a.display_name || ""}: ${(a.tagline || "").slice(0, 80)}`
      );
      return ok(lines.join("\n"));
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltbotden_agent", "View a specific agent's profile on MoltbotDen", {
    agent_id: z.string().describe("Agent ID to look up"),
  }, async ({ agent_id }) => {
    try {
      const data = await fetchJson(`${MOLTBOTDEN_API}/public/agents/${agent_id}`);
      return ok(data);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltbotden_activity", "Recent MoltbotDen community activity", {
    limit: z.number().optional().default(20).describe("Max events (1-100)"),
  }, async ({ limit }) => {
    try {
      const data = await fetchJson(`${MOLTBOTDEN_API}/public/activity?limit=${limit}`);
      return ok(data);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltbotden_stats", "MoltbotDen platform statistics", {}, async () => {
    try {
      const data = await fetchJson(`${MOLTBOTDEN_API}/public/stats`);
      return ok(data);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltbotden_leaderboard", "MoltbotDen top agents leaderboard", {
    category: z.enum(["connections", "active", "newest"]).optional().default("connections"),
    limit: z.number().optional().default(10),
  }, async ({ category, limit }) => {
    try {
      const data = await fetchJson(`${MOLTBOTDEN_API}/public/leaderboard?category=${category}&limit=${limit}`);
      return ok(data);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  // --- Auth-required endpoints ---

  server.tool("moltbotden_me", "View my MoltbotDen profile", {}, async () => {
    const key = getMoltbotdenKey();
    if (!key) return err("No MoltbotDen API key configured");
    try {
      const data = await fetchJson(`${MOLTBOTDEN_API}/agents/me`, { headers: auth(key) });
      return ok(data);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltbotden_discover", "Discover compatible agents on MoltbotDen", {
    min_compatibility: z.number().optional().default(0.3),
    limit: z.number().optional().default(10),
    capabilities: z.string().optional().describe("Comma-separated capability filter"),
  }, async ({ min_compatibility, limit, capabilities }) => {
    const key = getMoltbotdenKey();
    if (!key) return err("No MoltbotDen API key configured");
    try {
      let url = `${MOLTBOTDEN_API}/discover?min_compatibility=${min_compatibility}&limit=${limit}`;
      if (capabilities) url += `&capabilities=${encodeURIComponent(capabilities)}`;
      const data = await fetchJson(url, { headers: auth(key) });
      const matches = (data.matches || []).map(m =>
        `${m.agent_id} (${(m.compatibility?.overall * 100).toFixed(0)}% match) — ${m.display_name || ""}: ${(m.tagline || "").slice(0, 60)}`
      );
      return ok(matches.join("\n") || "No matches found");
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltbotden_interest", "Express interest in connecting with an agent", {
    target: z.string().describe("Target agent ID"),
    message: z.string().optional().describe("Optional message (max 500 chars)"),
  }, async ({ target, message }) => {
    const key = getMoltbotdenKey();
    if (!key) return err("No MoltbotDen API key configured");
    try {
      const body = { target_agent_id: target };
      if (message) body.message = message;
      const data = await fetchJson(`${MOLTBOTDEN_API}/interest`, {
        method: "POST", headers: auth(key), body: JSON.stringify(body),
      });
      return ok(`Interest sent → ${data.status} (connection: ${data.connection_id})`);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltbotden_connections", "List my MoltbotDen connections", {
    status: z.enum(["pending", "accepted", "declined", "expired", "blocked"]).optional(),
  }, async ({ status }) => {
    const key = getMoltbotdenKey();
    if (!key) return err("No MoltbotDen API key configured");
    try {
      let url = `${MOLTBOTDEN_API}/connections`;
      if (status) url += `?status_filter=${status}`;
      const data = await fetchJson(url, { headers: auth(key) });
      return ok(data);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltbotden_conversations", "List my MoltbotDen conversations", {
    limit: z.number().optional().default(20),
  }, async ({ limit }) => {
    const key = getMoltbotdenKey();
    if (!key) return err("No MoltbotDen API key configured");
    try {
      const data = await fetchJson(`${MOLTBOTDEN_API}/conversations?limit=${limit}`, { headers: auth(key) });
      return ok(data);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltbotden_send", "Send a message in a MoltbotDen conversation", {
    conversation_id: z.string().describe("Conversation ID"),
    recipient_id: z.string().describe("Recipient agent ID"),
    content: z.string().describe("Message content"),
  }, async ({ conversation_id, recipient_id, content }) => {
    const key = getMoltbotdenKey();
    if (!key) return err("No MoltbotDen API key configured");
    try {
      const data = await fetchJson(`${MOLTBOTDEN_API}/conversations/${conversation_id}/messages`, {
        method: "POST", headers: auth(key),
        body: JSON.stringify({ recipient_id, content, message_type: "text" }),
      });
      return ok(`Message sent: ${data.message_id} (${data.status})`);
    } catch (e) { return err(`Error: ${e.message}`); }
  });

  server.tool("moltbotden_heartbeat", "Send heartbeat to MoltbotDen (mark active)", {}, async () => {
    const key = getMoltbotdenKey();
    if (!key) return err("No MoltbotDen API key configured");
    try {
      const data = await fetchJson(`${MOLTBOTDEN_API}/heartbeat`, {
        method: "POST", headers: auth(key),
      });
      return ok(data);
    } catch (e) { return err(`Error: ${e.message}`); }
  });
}

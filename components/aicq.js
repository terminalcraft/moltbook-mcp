import { z } from "zod";
import fs from "fs";
import path from "path";

// AICQ (aicq.chat) - AI Chat Quarters - Real-time chatroom for AI agents
// API docs: https://aicq.chat/skill.md
// Rate limits: 30 messages/hour, heartbeat recommended every 5-15 min

const AICQ_BASE = "https://AICQ.chat/api/v1";
const CREDS_PATH = path.join(process.env.HOME || "/home/moltbot", "moltbook-mcp", ".aicq-credentials.json");

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function loadToken() {
  try {
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
    return creds.token;
  } catch {
    return null;
  }
}

async function aicqFetch(endpoint, options = {}) {
  const token = loadToken();
  if (!token) throw new Error("No AICQ credentials found. Check .aicq-credentials.json");

  const headers = {
    "Authorization": `Bearer ${token}`,
    ...options.headers,
  };

  const res = await fetch(`${AICQ_BASE}${endpoint}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// Strip HTML tags for display
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Format message for display
function formatMessage(m) {
  const time = new Date(m.created_at).toISOString().slice(11, 16);
  const type = m.sender_type === "agent" ? "🤖" : "👤";
  const content = stripHtml(m.content).slice(0, 500);
  return `[${time}] ${type} ${m.sender_name}: ${content}`;
}

export function register(server) {
  server.tool("aicq_heartbeat", "Poll AICQ chatroom - returns recent messages and updates online status", {
    since_id: z.number().optional().describe("Only return messages after this ID"),
  }, async ({ since_id }) => {
    try {
      const endpoint = since_id ? `/heartbeat?since_id=${since_id}` : "/heartbeat";
      const data = await aicqFetch(endpoint);

      if (!data.success) return err(`Error: ${data.error || "Unknown error"}`);

      const messages = data.data?.messages || [];
      const online = data.data?.online_entities || [];

      // Count active agents and humans
      const activeAgents = online.filter(e => e.type === "agent" && e.status === "active").length;
      const activeHumans = online.filter(e => e.type === "human" && e.status === "active").length;

      let out = `AICQ Status: ${activeAgents} agents, ${activeHumans} humans active\n`;
      out += `Last ${messages.length} messages:\n\n`;

      if (messages.length === 0) {
        out += "(no messages)";
      } else {
        out += messages.map(formatMessage).join("\n\n");
      }

      return ok(out);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("aicq_send", "Send a message to AICQ chatroom", {
    content: z.string().describe("Message text (max 2000 chars, use @username to mention)"),
  }, async ({ content }) => {
    try {
      if (content.length > 2000) return err("Message too long (max 2000 chars)");

      const data = await aicqFetch("/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!data.success) return err(`Error: ${data.error || "Unknown error"}`);

      return ok(`Message sent (id: ${data.data?.id || "unknown"})`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("aicq_online", "List who's currently online on AICQ", {
    status: z.enum(["all", "active", "idle", "away"]).optional().describe("Filter by status (default: all)"),
  }, async ({ status }) => {
    try {
      const data = await aicqFetch("/heartbeat");

      if (!data.success) return err(`Error: ${data.error || "Unknown error"}`);

      let online = data.data?.online_entities || [];

      if (status && status !== "all") {
        online = online.filter(e => e.status === status);
      }

      if (!online.length) return ok("No one matching that status");

      const agents = online.filter(e => e.type === "agent");
      const humans = online.filter(e => e.type === "human");

      let out = `Online (${online.length} total):\n\n`;

      if (agents.length) {
        out += `Agents (${agents.length}):\n`;
        out += agents.map(a => {
          const mod = a.is_moderator ? " [mod]" : "";
          const statusIcon = a.status === "active" ? "🟢" : a.status === "idle" ? "🟡" : "⚪";
          return `  ${statusIcon} ${a.name}${mod}`;
        }).join("\n");
        out += "\n\n";
      }

      if (humans.length) {
        out += `Humans (${humans.length}):\n`;
        out += humans.map(h => {
          const mod = h.is_moderator ? " [mod]" : "";
          const statusIcon = h.status === "active" ? "🟢" : h.status === "idle" ? "🟡" : "⚪";
          return `  ${statusIcon} ${h.name}${mod}`;
        }).join("\n");
      }

      return ok(out);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("aicq_search", "Search AICQ message history", {
    query: z.string().describe("Search term to find in messages"),
    limit: z.number().optional().describe("Max results (default 20)"),
  }, async ({ query, limit }) => {
    try {
      // AICQ doesn't have a search endpoint, so we fetch recent and filter
      const data = await aicqFetch("/heartbeat");

      if (!data.success) return err(`Error: ${data.error || "Unknown error"}`);

      const messages = data.data?.messages || [];
      const queryLower = query.toLowerCase();
      const matches = messages.filter(m =>
        stripHtml(m.content).toLowerCase().includes(queryLower) ||
        m.sender_name.toLowerCase().includes(queryLower)
      ).slice(0, limit || 20);

      if (!matches.length) return ok(`No messages matching "${query}"`);

      let out = `Found ${matches.length} messages matching "${query}":\n\n`;
      out += matches.map(formatMessage).join("\n\n");

      return ok(out);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });
}

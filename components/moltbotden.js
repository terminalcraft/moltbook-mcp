import { z } from "zod";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// MoltbotDen (moltbotden.com) - The home for AI agents
// API docs: https://moltbotden.com/skill.md
// Features: Dens (chat rooms), weekly prompts, showcase, agent discovery

const MOLTBOTDEN_API = "https://api.moltbotden.com";

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function loadApiKey() {
  try {
    const credsPath = join(homedir(), "moltbook-mcp/moltbotden-credentials.json");
    const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
    return creds.api_key;
  } catch (e) {
    return null;
  }
}

async function fetchWithAuth(url, options = {}) {
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("MoltbotDen credentials not found");

  const headers = {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
    ...options.headers
  };

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export function register(server) {
  // === Dens (Chat Rooms) ===

  server.tool("moltbotden_dens", "List all available dens (chat rooms) on MoltbotDen", {}, async () => {
    try {
      const data = await fetchWithAuth(`${MOLTBOTDEN_API}/dens`);
      const dens = data?.dens || data || [];
      if (!Array.isArray(dens) || !dens.length) return ok("No dens found");
      const summary = dens.map(d =>
        `• **${d.name}** (/${d.slug}/) — ${d.description || "No description"}`
      ).join("\n");
      return ok(`Available Dens:\n\n${summary}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("moltbotden_den_read", "Read recent messages from a den", {
    den: z.string().describe("Den slug (e.g. 'the-den', 'technical', 'philosophy')"),
    limit: z.number().optional().describe("Max messages (default 20)")
  }, async ({ den, limit }) => {
    try {
      const n = limit || 20;
      const data = await fetchWithAuth(`${MOLTBOTDEN_API}/dens/${den}/messages?limit=${n}`);
      const messages = data?.messages || data || [];
      if (!Array.isArray(messages) || !messages.length) return ok(`No messages in /${den}/`);
      const summary = messages.map(m =>
        `[${m.agent_id || m.author}] ${m.content?.slice(0, 200) || ""}`
      ).join("\n\n");
      return ok(`Messages from /${den}/:\n\n${summary}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("moltbotden_den_post", "Post a message to a den", {
    den: z.string().describe("Den slug (e.g. 'the-den', 'technical')"),
    content: z.string().describe("Message content")
  }, async ({ den, content }) => {
    try {
      const result = await fetchWithAuth(`${MOLTBOTDEN_API}/dens/${den}/messages`, {
        method: "POST",
        body: JSON.stringify({ content })
      });
      return ok(`Posted to /${den}/: ${result.message_id || "success"}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  // === Weekly Prompts ===

  server.tool("moltbotden_prompt", "Get the current weekly prompt and top responses", {}, async () => {
    try {
      const data = await fetchWithAuth(`${MOLTBOTDEN_API}/prompts/current`);
      const prompt = data?.prompt;
      if (!prompt) return ok("No active prompt this week");

      let result = `**This Week's Prompt:**\n${prompt.prompt_text}\n\nResponses: ${prompt.response_count || 0}`;

      if (data.user_responded) {
        result += "\n\n(You have already responded)";
      }

      if (data.top_responses?.length) {
        result += "\n\n**Top Responses:**\n";
        result += data.top_responses.map(r =>
          `• [${r.agent_id}] ${r.content?.slice(0, 150)}... (${r.upvotes || 0} upvotes)`
        ).join("\n");
      }

      return ok(result);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("moltbotden_prompt_respond", "Submit your response to the weekly prompt", {
    content: z.string().describe("Your response to the prompt")
  }, async ({ content }) => {
    try {
      const result = await fetchWithAuth(`${MOLTBOTDEN_API}/prompts/current/respond`, {
        method: "POST",
        body: JSON.stringify({ content })
      });
      return ok(`Response submitted: ${result.response_id || "success"}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  // === Showcase ===

  server.tool("moltbotden_showcase", "Browse the showcase wall (agent projects and articles)", {
    sort: z.enum(["recent", "upvotes"]).optional().describe("Sort order (default: recent)")
  }, async ({ sort }) => {
    try {
      const sortBy = sort || "recent";
      const data = await fetchWithAuth(`${MOLTBOTDEN_API}/showcase?sort=${sortBy}`);
      const items = data?.items || data || [];
      if (!Array.isArray(items) || !items.length) return ok("No showcase items found");
      const summary = items.slice(0, 10).map(item =>
        `• **${item.title}** by ${item.agent_id}\n  ${item.description?.slice(0, 100) || ""}`
      ).join("\n\n");
      return ok(`Showcase Wall (${sortBy}):\n\n${summary}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  // === Agent Discovery ===

  server.tool("moltbotden_discover", "Discover compatible agents (requires full access)", {
    limit: z.number().optional().describe("Max agents to return (default 10)")
  }, async ({ limit }) => {
    try {
      const n = limit || 10;
      const data = await fetchWithAuth(`${MOLTBOTDEN_API}/discover?limit=${n}`);
      const agents = data?.agents || data || [];
      if (!Array.isArray(agents) || !agents.length) return ok("No agents found or discovery unavailable");
      const summary = agents.map(a =>
        `• **${a.display_name || a.agent_id}** — ${a.tagline || ""}\n  Compatibility: ${a.compatibility_score || "?"}`
      ).join("\n\n");
      return ok(`Compatible Agents:\n\n${summary}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  // === Status ===

  server.tool("moltbotden_status", "Check your MoltbotDen account status", {}, async () => {
    try {
      const data = await fetchWithAuth(`${MOLTBOTDEN_API}/me`);
      const status = data?.status || "unknown";
      const activity = data?.activity_score || 0;
      let result = `**Status:** ${status}\n**Activity Score:** ${activity}`;

      if (status === "provisional") {
        result += "\n\nProvisional status limits some features. Keep engaging to unlock full access!";
      }

      if (data?.profile) {
        result += `\n\n**Profile:**\nDisplay: ${data.profile.display_name || "Not set"}\nTagline: ${data.profile.tagline || "Not set"}`;
      }

      return ok(result);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });
}

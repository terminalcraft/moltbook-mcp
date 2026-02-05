import { z } from "zod";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ClawHub (claw-hub-bay.vercel.app) - GitHub-like platform for AI agents
// Features: Skill Registry, LiveChat, MemoryVault integration
// API: /api/v1/skills, /api/v1/livechat/*

const CLAWHUB_API = "https://claw-hub-bay.vercel.app/api/v1";

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function loadApiKey() {
  try {
    const credsPath = join(homedir(), "moltbook-mcp/clawhub-credentials.json");
    const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
    return creds.api_key;
  } catch (e) {
    return null;
  }
}

async function fetchWithAuth(url, options = {}) {
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("ClawHub credentials not found");

  const headers = {
    "Authorization": `Bearer ${apiKey}`,
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

async function fetchPublic(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export function register(server) {
  // === Skill Registry ===

  server.tool("clawhub_list_skills", "List skills in the ClawHub registry", {
    capability: z.string().optional().describe("Filter by capability (API, Nostr, Lightning, Web, A2A, CLI)"),
    category: z.string().optional().describe("Filter by category (Social, Utility, Infrastructure, Finance, Creative)"),
    search: z.string().optional().describe("Search query"),
    sort: z.enum(["score", "updated", "stars", "zaps"]).optional().describe("Sort order (default: score)")
  }, async ({ capability, category, search, sort }) => {
    try {
      const params = new URLSearchParams();
      if (capability) params.set("capability", capability);
      if (category) params.set("category", category);
      if (search) params.set("q", search);
      if (sort) params.set("sort", sort);

      const url = `${CLAWHUB_API}/skills${params.toString() ? "?" + params : ""}`;
      const data = await fetchPublic(url);
      const skills = data?.skills || [];

      if (!skills.length) return ok("No skills found matching criteria");

      const summary = skills.slice(0, 15).map(s =>
        `• **${s.full_name || s.name}** v${s.version || "?"}\n  ${s.description?.slice(0, 100) || "No description"}${s.description?.length > 100 ? "..." : ""}\n  ⭐ ${s.star_count || 0} | ⚡ ${s.zap_total_sats || 0} sats | Score: ${s.score || 0}`
      ).join("\n\n");

      return ok(`**ClawHub Skills** (${skills.length} found):\n\n${summary}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("clawhub_get_skill", "Get details of a specific skill", {
    owner: z.string().describe("Skill owner (e.g. 'moltbook')"),
    name: z.string().describe("Skill name (e.g. 'moltbook-mcp')")
  }, async ({ owner, name }) => {
    try {
      const data = await fetchPublic(`${CLAWHUB_API}/skills/${owner}/${name}`);
      const s = data?.skill || data;

      if (!s) return err("Skill not found");

      let result = `**${s.full_name || s.name}** v${s.version || "?"}\n`;
      result += `${s.description || "No description"}\n\n`;
      result += `**Stats:** ⭐ ${s.star_count || 0} | ⚡ ${s.zap_total_sats || 0} sats | Score: ${s.score || 0}\n`;
      if (s.homepage) result += `**Homepage:** ${s.homepage}\n`;
      if (s.repo_url) result += `**Repo:** ${s.repo_url}\n`;
      if (s.capabilities?.length) result += `**Capabilities:** ${s.capabilities.join(", ")}\n`;
      if (s.agent_card_url) result += `**Agent Card:** ${s.agent_card_url}\n`;

      return ok(result);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("clawhub_publish_skill", "Publish a skill to ClawHub from a GitHub repo", {
    repo_url: z.string().describe("GitHub repo URL (e.g. 'https://github.com/user/repo')")
  }, async ({ repo_url }) => {
    try {
      const data = await fetchWithAuth(`${CLAWHUB_API}/skills`, {
        method: "POST",
        body: JSON.stringify({ repo_url })
      });

      const s = data?.skill;
      if (!s) return ok(`Skill published: ${JSON.stringify(data)}`);

      return ok(`**Skill Published:** ${s.full_name || s.name} v${s.version}\n${s.description || ""}\nAgent Card: ${s.agent_card_url || "N/A"}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  // === LiveChat ===

  server.tool("clawhub_livechat_join", "Join ClawHub LiveChat and see available channels", {}, async () => {
    try {
      const data = await fetchWithAuth(`${CLAWHUB_API}/livechat/join`, {
        method: "POST",
        body: JSON.stringify({})
      });

      let result = `**Joined ClawHub LiveChat as ${data.agent || "agent"}**\n`;
      result += `${data.welcomeMessage || ""}\n\n`;
      result += `**Channels:** ${(data.channels || []).join(", ")}\n`;
      result += `**Active Members:** ${data.activeMembers || 0}`;

      if (data.agent_skills?.length) {
        result += `\n**Your Skills:** ${data.agent_skills.join(", ")}`;
      }

      return ok(result);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("clawhub_livechat_send", "Send a message to ClawHub LiveChat", {
    channel: z.string().describe("Channel name (general, skill-brainstorm, skill-dev, skill-review, skill-requests, skill-showcase)"),
    message: z.string().describe("Message content")
  }, async ({ channel, message }) => {
    try {
      const data = await fetchWithAuth(`${CLAWHUB_API}/livechat/send`, {
        method: "POST",
        body: JSON.stringify({ channel, message })
      });

      return ok(`Message sent to #${channel}: ${data.messageId || "success"}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("clawhub_livechat_read", "Read recent messages from ClawHub LiveChat", {
    channel: z.string().optional().describe("Channel to read (default: general)"),
    limit: z.number().optional().describe("Max messages (default: 20)")
  }, async ({ channel, limit }) => {
    try {
      const ch = channel || "general";
      const n = limit || 20;

      const data = await fetchWithAuth(`${CLAWHUB_API}/livechat/messages?channel=${ch}&limit=${n}`);
      const messages = data?.messages || data || [];

      if (!Array.isArray(messages) || !messages.length) return ok(`No messages in #${ch}`);

      const summary = messages.map(m =>
        `[${m.agent || m.author || "?"}] ${m.content?.slice(0, 200) || m.message?.slice(0, 200) || ""}`
      ).join("\n\n");

      return ok(`**#${ch} Messages:**\n\n${summary}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  // === Agent Status ===

  server.tool("clawhub_status", "Check your ClawHub account status", {}, async () => {
    try {
      // Join returns status info
      const data = await fetchWithAuth(`${CLAWHUB_API}/livechat/join`, {
        method: "POST",
        body: JSON.stringify({})
      });

      let result = `**Agent:** ${data.agent || "unknown"}\n`;
      result += `**Status:** Connected\n`;
      result += `**Channels:** ${(data.channels || []).length}\n`;
      result += `**Skills Published:** ${(data.agent_skills || []).length}\n`;
      result += `**Capabilities:** ${(data.agent_capabilities || []).join(", ") || "None listed"}`;

      return ok(result);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });
}

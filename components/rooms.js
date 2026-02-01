import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("room_create", "Create a persistent chat room for multi-agent coordination.", {
    name: z.string().describe("Room name (lowercase alphanumeric, hyphens, underscores, max 50)"),
    creator: z.string().describe("Your agent handle"),
    description: z.string().optional().describe("Room description (max 300 chars)"),
    max_members: z.number().optional().describe("Max members (2-200, default 50)"),
  }, async ({ name, creator, description, max_members }) => {
    try {
      const body = { name, creator };
      if (description) body.description = description;
      if (max_members) body.max_members = max_members;
      const res = await fetch(`${API_BASE}/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Room create failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Created room **${data.room}**` }] };
    } catch (e) { return { content: [{ type: "text", text: `Room error: ${e.message}` }] }; }
  });

  server.tool("room_list", "List all agent rooms sorted by last activity.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/rooms`);
      const data = await res.json();
      if (data.length === 0) return { content: [{ type: "text", text: "No rooms." }] };
      const lines = [`**${data.length} room(s)**\n`];
      for (const r of data) {
        lines.push(`- **${r.name}** (${r.members}/${r.max_members} members, ${r.messageCount} msgs) — ${r.description || "no description"}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Room error: ${e.message}` }] }; }
  });

  server.tool("room_join", "Join an agent room.", {
    name: z.string().describe("Room name"),
    agent: z.string().describe("Your agent handle"),
  }, async ({ name, agent }) => {
    try {
      const res = await fetch(`${API_BASE}/rooms/${encodeURIComponent(name)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Join failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Joined room **${name}** (${data.members} members)` }] };
    } catch (e) { return { content: [{ type: "text", text: `Room error: ${e.message}` }] }; }
  });

  server.tool("room_leave", "Leave an agent room.", {
    name: z.string().describe("Room name"),
    agent: z.string().describe("Your agent handle"),
  }, async ({ name, agent }) => {
    try {
      const res = await fetch(`${API_BASE}/rooms/${encodeURIComponent(name)}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Leave failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Left room **${name}** (${data.members} members remaining)` }] };
    } catch (e) { return { content: [{ type: "text", text: `Room error: ${e.message}` }] }; }
  });

  server.tool("room_send", "Send a message to an agent room (must be a member).", {
    name: z.string().describe("Room name"),
    agent: z.string().describe("Your agent handle"),
    body: z.string().describe("Message content (max 2000 chars)"),
  }, async ({ name, agent, body: msgBody }) => {
    try {
      const res = await fetch(`${API_BASE}/rooms/${encodeURIComponent(name)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, body: msgBody }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Send failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Message sent to **${name}** (id: ${data.id})` }] };
    } catch (e) { return { content: [{ type: "text", text: `Room error: ${e.message}` }] }; }
  });

  server.tool("room_read", "Read messages from an agent room.", {
    name: z.string().describe("Room name"),
    limit: z.number().optional().describe("Max messages (default 50, max 200)"),
    since: z.string().optional().describe("ISO timestamp — only messages after this point"),
  }, async ({ name, limit, since }) => {
    try {
      const params = new URLSearchParams();
      if (limit) params.set("limit", limit);
      if (since) params.set("since", since);
      const url = `${API_BASE}/rooms/${encodeURIComponent(name)}${params.toString() ? "?" + params : ""}`;
      const res = await fetch(url);
      if (res.status === 404) return { content: [{ type: "text", text: `Room "${name}" not found` }] };
      const data = await res.json();
      const lines = [`**${data.name}** — ${data.members.length} members, ${data.messageCount} total msgs`];
      if (data.description) lines.push(`*${data.description}*`);
      lines.push(`Members: ${data.members.join(", ")}\n`);
      if (data.messages.length === 0) {
        lines.push("No messages.");
      } else {
        for (const m of data.messages) {
          lines.push(`[${m.ts.slice(11, 19)}] **${m.agent}**: ${m.body}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Room error: ${e.message}` }] }; }
  });
}

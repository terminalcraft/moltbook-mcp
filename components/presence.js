import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  // presence_heartbeat — send a heartbeat to register/update presence
  server.tool("presence_heartbeat", "Send a heartbeat to the agent presence board. Call periodically to stay visible as online.", {
    handle: z.string().describe("Agent handle"),
    status: z.string().optional().describe("Status message (e.g. 'online', 'building', 'idle')"),
    url: z.string().optional().describe("Agent's public URL"),
    capabilities: z.array(z.string()).optional().describe("List of capabilities"),
    meta: z.record(z.string()).optional().describe("Optional metadata key-value pairs"),
  }, async ({ handle, status, url, capabilities, meta }) => {
    try {
      const body = { handle };
      if (status) body.status = status;
      if (url) body.url = url;
      if (capabilities) body.capabilities = capabilities;
      if (meta) body.meta = meta;
      const res = await fetch(`${API_BASE}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      return { content: [{ type: "text", text: data.ok ? `Heartbeat sent for ${handle}` : `Error: ${JSON.stringify(data)}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Presence error: ${e.message}` }] }; }
  });

  // presence_list — view all agents and their online status
  server.tool("presence_list", "View the agent presence board — who's online, last seen times, capabilities.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/presence`);
      const data = await res.json();
      if (!data.agents || data.agents.length === 0) {
        return { content: [{ type: "text", text: "No agents registered. Use presence_heartbeat to register." }] };
      }
      const lines = [`${data.online}/${data.total} agents online\n`];
      for (const a of data.agents) {
        const status = a.online ? "🟢" : "⚫";
        const ago = a.ago_seconds < 60 ? `${a.ago_seconds}s ago` : a.ago_seconds < 3600 ? `${Math.round(a.ago_seconds / 60)}m ago` : `${Math.round(a.ago_seconds / 3600)}h ago`;
        const caps = a.capabilities?.length ? ` [${a.capabilities.join(", ")}]` : "";
        lines.push(`${status} ${a.handle} — ${a.status || "online"} (${ago}, ${a.heartbeats} beats)${caps}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Presence error: ${e.message}` }] }; }
  });

  // presence_check — check a specific agent's presence
  server.tool("presence_check", "Check if a specific agent is online.", {
    handle: z.string().describe("Agent handle to check"),
  }, async ({ handle }) => {
    try {
      const res = await fetch(`${API_BASE}/presence/${encodeURIComponent(handle)}`);
      if (res.status === 404) return { content: [{ type: "text", text: `Agent '${handle}' not found in presence board.` }] };
      const a = await res.json();
      const status = a.online ? "online" : "offline";
      const ago = a.ago_seconds < 60 ? `${a.ago_seconds}s ago` : a.ago_seconds < 3600 ? `${Math.round(a.ago_seconds / 60)}m ago` : `${Math.round(a.ago_seconds / 3600)}h ago`;
      return { content: [{ type: "text", text: `${a.handle}: ${status} (last seen ${ago}, ${a.heartbeats} heartbeats, first seen ${a.first_seen})${a.url ? ` url: ${a.url}` : ""}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Presence error: ${e.message}` }] }; }
  });
}

import { z } from "zod";
import { readFileSync } from "fs";
import { join } from "path";

const API_BASE = "http://127.0.0.1:3847";
const getToken = () => { try { return readFileSync(join(process.env.HOME || "/home/moltbot", ".config/moltbook/api-token"), "utf-8").trim(); } catch { return "changeme"; } };
const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

export function register(server) {
  server.tool("webhooks_subscribe", "Subscribe to platform events via webhook. Get HTTP callbacks when things happen.", {
    agent: z.string().describe("Your agent handle"),
    url: z.string().describe("HTTP(S) URL to receive webhook POSTs"),
    events: z.array(z.string()).describe("Events to subscribe to (use '*' for all). See webhooks_events for list."),
  }, async ({ agent, url, events }) => {
    try {
      const res = await fetch(`${API_BASE}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, url, events }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Subscribe failed: ${data.error}${data.valid ? `\nValid events: ${data.valid.join(", ")}` : ""}` }] };
      const lines = [];
      if (data.updated) {
        lines.push(`Updated webhook **${data.id}** — events: ${data.events.join(", ")}`);
      } else {
        lines.push(`Webhook **${data.id}** created.`);
        lines.push(`Secret: \`${data.secret}\` (save this — shown once)`);
        lines.push(`Events: ${data.events.join(", ")}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Webhook error: ${e.message}` }] }; }
  });

  server.tool("webhooks_list", "List registered webhooks.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/webhooks`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `List failed: ${data.error}` }] };
      const hooks = Array.isArray(data) ? data : [];
      if (!hooks.length) return { content: [{ type: "text", text: "No webhooks registered." }] };
      const lines = [`**${hooks.length} webhook(s)**\n`];
      for (const h of hooks) {
        lines.push(`- **${h.id}** → ${h.url} [${h.events.join(", ")}] (agent: ${h.agent || "?"})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Webhook error: ${e.message}` }] }; }
  });

  server.tool("webhooks_delete", "Delete a webhook subscription.", {
    id: z.string().describe("Webhook ID to delete"),
  }, async ({ id }) => {
    try {
      const res = await fetch(`${API_BASE}/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Delete failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Webhook ${id} deleted.` }] };
    } catch (e) { return { content: [{ type: "text", text: `Webhook error: ${e.message}` }] }; }
  });

  server.tool("webhooks_events", "List all available webhook events.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/webhooks/events`);
      const data = await res.json();
      return { content: [{ type: "text", text: `**Available webhook events:**\n${data.events.map(e => `- ${e}`).join("\n")}\n\nUse \`*\` to subscribe to all events.` }] };
    } catch (e) { return { content: [{ type: "text", text: `Webhook error: ${e.message}` }] }; }
  });

  server.tool("webhooks_stats", "View delivery stats for a webhook.", {
    id: z.string().describe("Webhook ID"),
  }, async ({ id }) => {
    try {
      const res = await fetch(`${API_BASE}/webhooks/${encodeURIComponent(id)}/stats`);
      if (res.status === 404) return { content: [{ type: "text", text: `Webhook ${id} not found` }] };
      const data = await res.json();
      const s = data.stats || {};
      return { content: [{ type: "text", text: `**Webhook ${data.id}** (${data.agent})\nURL: ${data.url}\nEvents: ${data.events.join(", ")}\nDelivered: ${s.delivered || 0} | Failed: ${s.failed || 0}\nLast delivery: ${s.last_delivery || "never"}\nLast failure: ${s.last_failure || "none"}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Webhook error: ${e.message}` }] }; }
  });
}

import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("monitor_create", "Create a URL monitor to track a service's uptime.", {
    agent: z.string().describe("Your agent handle"),
    url: z.string().describe("HTTP(S) URL to monitor"),
    name: z.string().optional().describe("Human-readable name for this monitor"),
  }, async ({ agent, url, name }) => {
    try {
      const body = { agent, url };
      if (name) body.name = name;
      const res = await fetch(`${API_BASE}/monitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Monitor create failed: ${data.error}${data.id ? ` (existing: ${data.id})` : ""}` }] };
      return { content: [{ type: "text", text: `Created monitor **${data.id}**: ${data.name} → ${data.url}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Monitor error: ${e.message}` }] }; }
  });

  server.tool("monitor_list", "List all URL monitors with uptime stats.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/monitors?format=json`);
      const data = await res.json();
      if (data.monitors.length === 0) return { content: [{ type: "text", text: "No monitors." }] };
      const lines = [`**${data.total}/${data.max} monitors**\n`];
      for (const m of data.monitors) {
        const status = m.status || "pending";
        const u1 = m.uptime_1h !== null ? `${m.uptime_1h}%` : "--";
        const u24 = m.uptime_24h !== null ? `${m.uptime_24h}%` : "--";
        lines.push(`- [${m.id}] **${m.name}** (${status}) — 1h: ${u1}, 24h: ${u24} — by ${m.agent}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Monitor error: ${e.message}` }] }; }
  });

  server.tool("monitor_get", "Get detailed info and history for a specific monitor.", {
    id: z.string().describe("Monitor ID"),
  }, async ({ id }) => {
    try {
      const res = await fetch(`${API_BASE}/monitors/${encodeURIComponent(id)}`);
      if (res.status === 404) return { content: [{ type: "text", text: "Monitor not found." }] };
      const m = await res.json();
      const lines = [
        `**${m.name}** (${m.status || "pending"})`,
        `URL: ${m.url}`,
        `Agent: ${m.agent}`,
        `Status code: ${m.status_code ?? "—"}`,
        `Uptime 1h: ${m.uptime_1h !== null ? m.uptime_1h + "%" : "--"} | 24h: ${m.uptime_24h !== null ? m.uptime_24h + "%" : "--"}`,
        `Last checked: ${m.last_checked || "never"}`,
      ];
      if (m.history && m.history.length > 0) {
        lines.push(`\nRecent history (last ${Math.min(m.history.length, 10)}):`);
        for (const h of m.history.slice(-10)) {
          lines.push(`  ${h.ts.slice(0, 19)} — ${h.status}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Monitor error: ${e.message}` }] }; }
  });

  server.tool("monitor_delete", "Delete a URL monitor.", {
    id: z.string().describe("Monitor ID to delete"),
  }, async ({ id }) => {
    try {
      const res = await fetch(`${API_BASE}/monitors/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Delete failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Deleted monitor **${data.removed}**` }] };
    } catch (e) { return { content: [{ type: "text", text: `Monitor error: ${e.message}` }] }; }
  });

  server.tool("monitor_probe", "Manually probe a monitor right now to check its status.", {
    id: z.string().describe("Monitor ID to probe"),
  }, async ({ id }) => {
    try {
      const res = await fetch(`${API_BASE}/monitors/${encodeURIComponent(id)}/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Probe failed: ${data.error}` }] };
      const changed = data.changed ? ` (changed from ${data.previous})` : "";
      return { content: [{ type: "text", text: `Probed **${data.name}**: ${data.status} (${data.status_code ?? "no response"})${changed}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Monitor error: ${e.message}` }] }; }
  });
}

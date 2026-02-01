import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("cron_create", "Create a scheduled HTTP callback (cron job). The server will call your URL at the specified interval.", {
    url: z.string().describe("HTTP(S) URL to call on each tick"),
    interval: z.number().describe("Interval in seconds (60-86400)"),
    agent: z.string().optional().describe("Your agent handle"),
    name: z.string().optional().describe("Human-readable job name"),
    method: z.string().optional().describe("HTTP method: GET, POST, PUT, PATCH (default: POST)"),
    payload: z.any().optional().describe("JSON payload to send with each request"),
  }, async ({ url, interval, agent, name, method, payload }) => {
    try {
      const body = { url, interval };
      if (agent) body.agent = agent;
      if (name) body.name = name;
      if (method) body.method = method;
      if (payload) body.payload = payload;
      const res = await fetch(`${API_BASE}/cron`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Cron create failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Created cron job **${data.id}**${data.name ? ` (${data.name})` : ""} → ${data.method} ${data.url} every ${data.interval}s` }] };
    } catch (e) { return { content: [{ type: "text", text: `Cron error: ${e.message}` }] }; }
  });

  server.tool("cron_list", "List all scheduled cron jobs.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/cron`);
      const data = await res.json();
      if (data.total === 0) return { content: [{ type: "text", text: "No cron jobs scheduled." }] };
      const lines = [`**${data.total} cron job(s)**\n`];
      for (const j of data.jobs) {
        const status = j.active ? "active" : "paused";
        lines.push(`- **${j.id}**${j.name ? ` ${j.name}` : ""} — ${j.method} ${j.url} every ${j.interval}s [${status}] runs:${j.run_count} errs:${j.error_count}${j.last_run ? ` last:${j.last_run}` : ""}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Cron error: ${e.message}` }] }; }
  });

  server.tool("cron_get", "Get details of a specific cron job including execution history.", {
    id: z.string().describe("Job ID"),
  }, async ({ id }) => {
    try {
      const res = await fetch(`${API_BASE}/cron/${encodeURIComponent(id)}`);
      if (res.status === 404) return { content: [{ type: "text", text: `Job ${id} not found` }] };
      const j = await res.json();
      const lines = [
        `**Job ${j.id}**${j.name ? ` — ${j.name}` : ""}`,
        `URL: ${j.method} ${j.url}`,
        `Interval: ${j.interval}s | Active: ${j.active} | Runs: ${j.run_count} | Errors: ${j.error_count}`,
        `Created: ${j.created_at}`,
      ];
      if (j.history?.length) {
        lines.push(`\n**Recent runs:**`);
        for (const h of j.history.slice(-5)) {
          lines.push(`  ${h.ts} → ${h.status} (${h.duration_ms}ms)${h.error ? ` ${h.error}` : ""}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Cron error: ${e.message}` }] }; }
  });

  server.tool("cron_delete", "Delete a scheduled cron job.", {
    id: z.string().describe("Job ID to delete"),
  }, async ({ id }) => {
    try {
      const res = await fetch(`${API_BASE}/cron/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.status === 404) return { content: [{ type: "text", text: `Job ${id} not found` }] };
      return { content: [{ type: "text", text: `Deleted cron job ${id}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Cron error: ${e.message}` }] }; }
  });

  server.tool("cron_update", "Update a cron job (pause/resume, change interval, etc).", {
    id: z.string().describe("Job ID"),
    active: z.boolean().optional().describe("Set active (true) or paused (false)"),
    interval: z.number().optional().describe("New interval in seconds"),
    name: z.string().optional().describe("New name"),
  }, async ({ id, active, interval, name }) => {
    try {
      const body = {};
      if (active !== undefined) body.active = active;
      if (interval !== undefined) body.interval = interval;
      if (name !== undefined) body.name = name;
      const res = await fetch(`${API_BASE}/cron/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 404) return { content: [{ type: "text", text: `Job ${id} not found` }] };
      const j = await res.json();
      if (j.error) return { content: [{ type: "text", text: `Update failed: ${j.error}` }] };
      return { content: [{ type: "text", text: `Updated job ${j.id}: active=${j.active}, interval=${j.interval}s` }] };
    } catch (e) { return { content: [{ type: "text", text: `Cron error: ${e.message}` }] }; }
  });
}

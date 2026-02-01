import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("buildlog_add", "Log a build session — record what you shipped for cross-agent visibility.", {
    agent: z.string().describe("Your agent handle"),
    summary: z.string().describe("What you built (max 500 chars)"),
    tags: z.array(z.string()).optional().describe("Tags (max 10)"),
    commits: z.number().optional().describe("Number of commits"),
    files_changed: z.number().optional().describe("Number of files changed"),
    version: z.string().optional().describe("Version shipped (max 20 chars)"),
    url: z.string().optional().describe("Link to commit/PR/release"),
  }, async ({ agent, summary, tags, commits, files_changed, version, url }) => {
    try {
      const body = { agent, summary };
      if (tags) body.tags = tags;
      if (commits !== undefined) body.commits = commits;
      if (files_changed !== undefined) body.files_changed = files_changed;
      if (version) body.version = version;
      if (url) body.url = url;

      const res = await fetch(`${API_BASE}/buildlog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Logged: **${data.entry.agent}** — ${data.entry.summary} (id: ${data.entry.id.slice(0, 8)})` }] };
    } catch (e) { return { content: [{ type: "text", text: `Buildlog error: ${e.message}` }] }; }
  });

  server.tool("buildlog_list", "View cross-agent build activity feed — see what agents are shipping.", {
    agent: z.string().optional().describe("Filter by agent handle"),
    tag: z.string().optional().describe("Filter by tag"),
    limit: z.number().optional().describe("Max entries (default 20, max 200)"),
  }, async ({ agent, tag, limit }) => {
    try {
      const params = new URLSearchParams({ format: "json" });
      if (agent) params.set("agent", agent);
      if (tag) params.set("tag", tag);
      if (limit) params.set("limit", String(limit));

      const res = await fetch(`${API_BASE}/buildlog?${params}`);
      const data = await res.json();
      if (!data.entries || data.entries.length === 0) {
        return { content: [{ type: "text", text: "Build log is empty. Submit entries with buildlog_add." }] };
      }

      const lines = [`**Build Log** (${data.count} entries)\n`];
      for (const e of data.entries.slice(0, limit || 20)) {
        const tags = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
        const ver = e.version ? ` v${e.version}` : "";
        const commits = e.commits ? ` (${e.commits} commits)` : "";
        lines.push(`• **${e.agent}**${ver}: ${e.summary}${commits}${tags}`);
        lines.push(`  ${e.ts.slice(0, 16)}${e.url ? ` — ${e.url}` : ""}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Buildlog error: ${e.message}` }] }; }
  });
}

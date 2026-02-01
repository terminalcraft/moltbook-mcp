import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("snapshot_save", "Save a versioned memory snapshot for an agent. Stores structured data with labels and tags for later retrieval or diffing.", {
    handle: z.string().describe("Agent handle"),
    label: z.string().optional().describe("Human-readable label (e.g. 'session-42', 'pre-deploy')"),
    data: z.record(z.any()).describe("Structured data to snapshot (object with any keys/values)"),
    tags: z.array(z.string()).optional().describe("Searchable tags"),
  }, async ({ handle, label, data, tags }) => {
    try {
      const res = await fetch(`${API_BASE}/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, label, data, tags }),
      });
      const d = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Snapshot save failed: ${d.error}` }] };
      return { content: [{ type: "text", text: `Snapshot saved: ${d.label} (id: ${d.id}, v${d.version}, ${d.size} bytes)` }] };
    } catch (e) { return { content: [{ type: "text", text: `Snapshot error: ${e.message}` }] }; }
  });

  server.tool("snapshot_list", "List snapshots for an agent, or list all agents with snapshots.", {
    handle: z.string().optional().describe("Agent handle (omit for overview of all agents)"),
  }, async ({ handle }) => {
    try {
      const url = handle ? `${API_BASE}/snapshots/${encodeURIComponent(handle)}` : `${API_BASE}/snapshots`;
      const res = await fetch(url);
      const data = await res.json();
      if (!handle) {
        if (!data.length) return { content: [{ type: "text", text: "No snapshots stored." }] };
        const lines = data.map(a => `- **${a.handle}**: ${a.count} snapshots (latest: ${a.latest})`);
        return { content: [{ type: "text", text: `**Snapshots overview**\n${lines.join("\n")}` }] };
      }
      if (!data.length) return { content: [{ type: "text", text: `No snapshots for ${handle}` }] };
      const lines = data.map(s => `- **${s.label}** (${s.id}) v${s.version} — ${s.size}B, ${s.created}${s.tags?.length ? ` [${s.tags.join(", ")}]` : ""}`);
      return { content: [{ type: "text", text: `**${handle}** — ${data.length} snapshot(s)\n${lines.join("\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Snapshot error: ${e.message}` }] }; }
  });

  server.tool("snapshot_get", "Get a specific snapshot or the latest for an agent.", {
    handle: z.string().describe("Agent handle"),
    id: z.string().optional().describe("Snapshot ID (omit for latest)"),
  }, async ({ handle, id }) => {
    try {
      const url = id
        ? `${API_BASE}/snapshots/${encodeURIComponent(handle)}/${encodeURIComponent(id)}`
        : `${API_BASE}/snapshots/${encodeURIComponent(handle)}/latest`;
      const res = await fetch(url);
      if (res.status === 404) return { content: [{ type: "text", text: `Snapshot not found` }] };
      const snap = await res.json();
      return { content: [{ type: "text", text: `**${snap.label}** (${snap.id}) v${snap.version}\nCreated: ${snap.created} | Size: ${snap.size}B\n\n${JSON.stringify(snap.data, null, 2)}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Snapshot error: ${e.message}` }] }; }
  });

  server.tool("snapshot_diff", "Compare two snapshots to see what changed.", {
    handle: z.string().describe("Agent handle"),
    id1: z.string().describe("First snapshot ID (older)"),
    id2: z.string().describe("Second snapshot ID (newer)"),
  }, async ({ handle, id1, id2 }) => {
    try {
      const res = await fetch(`${API_BASE}/snapshots/${encodeURIComponent(handle)}/diff/${encodeURIComponent(id1)}/${encodeURIComponent(id2)}`);
      if (!res.ok) { const d = await res.json(); return { content: [{ type: "text", text: `Diff failed: ${d.error}` }] }; }
      const d = await res.json();
      const lines = [`**Diff**: ${d.from.label} (v${d.from.version}) → ${d.to.label} (v${d.to.version})\n`];
      const { added, removed, changed } = d.diff;
      if (Object.keys(added).length) lines.push(`**Added:** ${Object.keys(added).join(", ")}`);
      if (Object.keys(removed).length) lines.push(`**Removed:** ${Object.keys(removed).join(", ")}`);
      for (const [k, v] of Object.entries(changed)) {
        lines.push(`**Changed** \`${k}\`: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`);
      }
      if (!Object.keys(added).length && !Object.keys(removed).length && !Object.keys(changed).length) {
        lines.push("No differences.");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Snapshot error: ${e.message}` }] }; }
  });

  server.tool("snapshot_delete", "Delete a specific snapshot.", {
    handle: z.string().describe("Agent handle"),
    id: z.string().describe("Snapshot ID to delete"),
  }, async ({ handle, id }) => {
    try {
      const res = await fetch(`${API_BASE}/snapshots/${encodeURIComponent(handle)}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.status === 404) return { content: [{ type: "text", text: "Snapshot not found" }] };
      return { content: [{ type: "text", text: `Deleted snapshot ${id}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Snapshot error: ${e.message}` }] }; }
  });
}

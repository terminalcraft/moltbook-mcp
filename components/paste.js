import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("paste_create", "Create a paste to share code, logs, or text with other agents. Returns a URL.", {
    content: z.string().describe("The text content to paste"),
    title: z.string().optional().describe("Optional title"),
    language: z.string().optional().describe("Language hint for syntax (e.g. 'js', 'python', 'json')"),
    author: z.string().optional().describe("Author handle"),
    expires_in: z.number().optional().describe("Seconds until expiry (max 7 days = 604800)"),
  }, async ({ content, title, language, author, expires_in }) => {
    try {
      const body = { content };
      if (title) body.title = title;
      if (language) body.language = language;
      if (author) body.author = author;
      if (expires_in) body.expires_in = expires_in;
      const res = await fetch(`${API_BASE}/paste`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Paste failed: ${data.error}` }] };
      const url = `http://terminalcraft.xyz:3847/paste/${data.id}`;
      const raw = `http://terminalcraft.xyz:3847/paste/${data.id}/raw`;
      let text = `Paste created: **${data.id}**\nURL: ${url}\nRaw: ${raw}`;
      if (data.expires_at) text += `\nExpires: ${data.expires_at}`;
      return { content: [{ type: "text", text }] };
    } catch (e) { return { content: [{ type: "text", text: `Paste error: ${e.message}` }] }; }
  });

  server.tool("paste_get", "Retrieve a paste by ID", {
    id: z.string().describe("Paste ID (8-char hex)"),
  }, async ({ id }) => {
    try {
      const res = await fetch(`${API_BASE}/paste/${id}`);
      if (!res.ok) return { content: [{ type: "text", text: `Paste ${id} not found` }] };
      const p = await res.json();
      const header = [`**${p.title || "Untitled"}** (${p.id})`, `Language: ${p.language || "plain"} | Views: ${p.views} | Size: ${p.size}B`];
      if (p.author) header.push(`Author: ${p.author}`);
      if (p.expires_at) header.push(`Expires: ${p.expires_at}`);
      header.push("---");
      header.push(p.content);
      return { content: [{ type: "text", text: header.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Paste error: ${e.message}` }] }; }
  });

  server.tool("paste_list", "List recent pastes. Filter by author or language.", {
    author: z.string().optional().describe("Filter by author handle"),
    language: z.string().optional().describe("Filter by language"),
    limit: z.number().optional().describe("Max results (default 20)"),
  }, async ({ author, language, limit }) => {
    try {
      const params = new URLSearchParams();
      if (author) params.set("author", author);
      if (language) params.set("language", language);
      if (limit) params.set("limit", String(limit));
      const res = await fetch(`${API_BASE}/paste?${params}`);
      const data = await res.json();
      if (!data.pastes || data.pastes.length === 0) {
        return { content: [{ type: "text", text: "No pastes found." }] };
      }
      const lines = [`**Pastes** (${data.count} of ${data.total} total)\n`];
      for (const p of data.pastes) {
        const meta = [p.language, p.author, `${p.views}v`].filter(Boolean).join(", ");
        lines.push(`- **${p.id}** ${p.title || "(untitled)"} [${meta}] — ${p.preview.slice(0, 60)}...`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Paste error: ${e.message}` }] }; }
  });
}

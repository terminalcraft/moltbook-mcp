import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";
const PUBLIC_BASE = "http://terminalcraft.xyz:3847";

export function register(server) {
  server.tool("short_create", "Create a short URL. Deduplicates — if the URL already exists, returns the existing short link.", {
    url: z.string().describe("URL to shorten"),
    code: z.string().optional().describe("Custom short code (2-20 alphanumeric chars)"),
    title: z.string().optional().describe("Description of the link"),
    author: z.string().optional().describe("Author handle"),
  }, async ({ url, code, title, author }) => {
    try {
      const body = { url };
      if (code) body.code = code;
      if (title) body.title = title;
      if (author) body.author = author;
      const res = await fetch(`${API_BASE}/short`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Short URL failed: ${data.error}` }] };
      const shortUrl = `${PUBLIC_BASE}/s/${data.code}`;
      let text = data.existing
        ? `Existing short URL: ${shortUrl} → ${url}`
        : `Short URL created: ${shortUrl} → ${url}`;
      return { content: [{ type: "text", text }] };
    } catch (e) { return { content: [{ type: "text", text: `Short URL error: ${e.message}` }] }; }
  });

  server.tool("short_list", "List short URLs. Filter by author or search query.", {
    author: z.string().optional().describe("Filter by author handle"),
    q: z.string().optional().describe("Search URL, title, or code"),
    limit: z.number().optional().describe("Max results (default 50)"),
  }, async ({ author, q, limit }) => {
    try {
      const params = new URLSearchParams();
      if (author) params.set("author", author);
      if (q) params.set("q", q);
      if (limit) params.set("limit", String(limit));
      const res = await fetch(`${API_BASE}/short?${params}`);
      const data = await res.json();
      if (!data.shorts || data.shorts.length === 0) {
        return { content: [{ type: "text", text: "No short URLs found." }] };
      }
      const lines = [`**Short URLs** (${data.count})\n`];
      for (const s of data.shorts) {
        const meta = [s.author, `${s.clicks} clicks`].filter(Boolean).join(", ");
        lines.push(`- **${s.code}** → ${s.url.slice(0, 80)} [${meta}]${s.title ? ` — ${s.title}` : ""}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Short URL error: ${e.message}` }] }; }
  });
}

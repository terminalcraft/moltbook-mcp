import { z } from "zod";

// Knowbster V2 — Decentralized AI knowledge marketplace on Base L2
// API docs: https://knowbster.com/skill.md
// Read API: no auth. Write/purchase: requires on-chain wallet (Base L2).

const API = "https://knowbster.com/api/v2";

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

export function register(server) {
  server.tool("knowbster_browse", "Browse knowledge listings on Knowbster marketplace", {
    category: z.string().optional().describe("Filter by category (e.g. Technology, Health, Finance)"),
    search: z.string().optional().describe("Search term to filter by"),
    limit: z.number().optional().describe("Max results (default 10, max 50)"),
  }, async ({ category, search, limit }) => {
    try {
      const params = new URLSearchParams();
      params.set("limit", String(Math.min(limit || 10, 50)));
      if (category) params.set("category", category);
      if (search) params.set("search", search);

      const data = await fetchJson(`${API}/knowledge?${params}`);
      const items = data?.knowledge || [];
      if (!items.length) return ok("No knowledge items found matching criteria.");

      const summary = items.map((k, i) => {
        const stats = k.validationStats || {};
        const validations = stats.total > 0 ? ` (${stats.positive}+ / ${stats.negative}-)` : "";
        return `${i + 1}. [#${k.tokenId}] "${k.title}" — ${k.category}\n   ${k.description}\n   Price: ${k.price} ETH · Sales: ${k.salesCount} · Author: ${k.author?.slice(0, 10)}...${validations}`;
      }).join("\n\n");

      return ok(`Knowbster marketplace — ${data.total} total items:\n\n${summary}`);
    } catch (e) {
      return err(`Knowbster error: ${e.message}`);
    }
  });

  server.tool("knowbster_detail", "Get details of a specific knowledge item", {
    token_id: z.string().describe("Token ID of the knowledge item"),
  }, async ({ token_id }) => {
    try {
      const data = await fetchJson(`${API}/knowledge/${token_id}`);
      const k = data?.knowledge || data;
      if (!k || !k.title) return err("Knowledge item not found");

      const stats = k.validationStats || {};
      let out = `"${k.title}" (#${k.tokenId})\n`;
      out += `Category: ${k.category} · Language: ${k.language} · Jurisdiction: ${k.jurisdiction}\n`;
      out += `Price: ${k.price} ETH · Sales: ${k.salesCount}\n`;
      out += `Author: ${k.author}\n`;
      out += `Content hash: ${k.contentHash}\n`;
      out += `Validations: ${stats.positive || 0} positive, ${stats.negative || 0} negative (${stats.total || 0} total)\n`;
      out += `Created: ${k.createdAt}\n`;
      if (k.contentPreview) out += `\nPreview: ${k.contentPreview}`;

      return ok(out);
    } catch (e) {
      return err(`Knowbster error: ${e.message}`);
    }
  });

  server.tool("knowbster_stats", "Get Knowbster marketplace statistics", {}, async () => {
    try {
      // Fetch first page to get total count
      const data = await fetchJson(`${API}/knowledge?limit=1`);
      const total = data?.total || 0;

      // Fetch categories by sampling
      const sample = await fetchJson(`${API}/knowledge?limit=50`);
      const items = sample?.knowledge || [];
      const categories = {};
      const authors = new Set();
      let totalSales = 0;

      for (const k of items) {
        categories[k.category] = (categories[k.category] || 0) + 1;
        authors.add(k.author);
        totalSales += k.salesCount || 0;
      }

      const catSummary = Object.entries(categories)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, count]) => `  ${cat}: ${count}`)
        .join("\n");

      let out = `Knowbster Marketplace Stats\n`;
      out += `Total listings: ${total}\n`;
      out += `Unique authors (sampled): ${authors.size}\n`;
      out += `Total sales (sampled): ${totalSales}\n`;
      out += `\nCategories (from ${items.length} sampled):\n${catSummary}`;
      out += `\nNetwork: Base Mainnet (Chain 8453)`;
      out += `\nContract: 0xc6854adEd027e132d146a201030bA6b5a87b01a6`;

      return ok(out);
    } catch (e) {
      return err(`Knowbster error: ${e.message}`);
    }
  });
}

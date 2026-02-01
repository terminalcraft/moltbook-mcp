import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("kv_set", "Set a key-value pair in a namespace. Values can be strings, numbers, objects, or arrays.", {
    ns: z.string().describe("Namespace (e.g. your agent handle)"),
    key: z.string().describe("Key name"),
    value: z.any().describe("Value to store (string, number, object, array)"),
    ttl: z.number().optional().describe("Time-to-live in seconds (max 30 days)"),
  }, async ({ ns, key, value, ttl }) => {
    try {
      const body = { value };
      if (ttl) body.ttl = ttl;
      const res = await fetch(`${API_BASE}/kv/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `KV set failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `${data.created ? "Created" : "Updated"} ${ns}/${key}${data.expires_at ? ` (expires ${data.expires_at})` : ""}` }] };
    } catch (e) { return { content: [{ type: "text", text: `KV error: ${e.message}` }] }; }
  });

  server.tool("kv_get", "Get a value from the KV store.", {
    ns: z.string().describe("Namespace"),
    key: z.string().describe("Key name"),
  }, async ({ ns, key }) => {
    try {
      const res = await fetch(`${API_BASE}/kv/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`);
      if (res.status === 404) return { content: [{ type: "text", text: `Key ${ns}/${key} not found` }] };
      const data = await res.json();
      const val = typeof data.value === "string" ? data.value : JSON.stringify(data.value, null, 2);
      return { content: [{ type: "text", text: `**${ns}/${key}** = ${val}\nUpdated: ${data.updated_at}${data.expires_at ? ` | Expires: ${data.expires_at}` : ""}` }] };
    } catch (e) { return { content: [{ type: "text", text: `KV error: ${e.message}` }] }; }
  });

  server.tool("kv_list", "List keys in a namespace, or list all namespaces.", {
    ns: z.string().optional().describe("Namespace to list keys in (omit for namespace list)"),
  }, async ({ ns }) => {
    try {
      const url = ns ? `${API_BASE}/kv/${encodeURIComponent(ns)}` : `${API_BASE}/kv`;
      const res = await fetch(url);
      const data = await res.json();
      if (ns) {
        if (data.count === 0) return { content: [{ type: "text", text: `Namespace "${ns}" is empty or doesn't exist.` }] };
        const lines = [`**${ns}** (${data.count} keys)\n`];
        for (const k of data.keys) {
          lines.push(`- ${k.key} (updated ${k.updated_at}${k.expires_at ? `, expires ${k.expires_at}` : ""})`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
      if (data.total_namespaces === 0) return { content: [{ type: "text", text: "KV store is empty." }] };
      const lines = [`**KV Store** — ${data.total_keys} keys in ${data.total_namespaces} namespace(s)\n`];
      for (const n of data.namespaces) {
        lines.push(`- **${n.ns}** (${n.keys} keys)`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `KV error: ${e.message}` }] }; }
  });

  server.tool("kv_delete", "Delete a key from the KV store.", {
    ns: z.string().describe("Namespace"),
    key: z.string().describe("Key name"),
  }, async ({ ns, key }) => {
    try {
      const res = await fetch(`${API_BASE}/kv/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (res.status === 404) return { content: [{ type: "text", text: `Key ${ns}/${key} not found` }] };
      return { content: [{ type: "text", text: `Deleted ${ns}/${key}` }] };
    } catch (e) { return { content: [{ type: "text", text: `KV error: ${e.message}` }] }; }
  });
}

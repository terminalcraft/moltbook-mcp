import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("topic_create", "Create a pub/sub topic for broadcast messaging between agents.", {
    name: z.string().describe("Topic name (lowercase alphanumeric, dots, dashes, underscores, max 64 chars)"),
    description: z.string().optional().describe("What this topic is for"),
    creator: z.string().optional().describe("Your agent handle"),
  }, async ({ name, description, creator }) => {
    try {
      const body = { name };
      if (description) body.description = description;
      if (creator) body.creator = creator;
      const res = await fetch(`${API_BASE}/topics`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Topic create failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Created topic **${data.topic.name}**${data.topic.description ? `: ${data.topic.description}` : ""}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }] }; }
  });

  server.tool("topic_list", "List all pub/sub topics.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/topics`);
      const data = await res.json();
      if (data.count === 0) return { content: [{ type: "text", text: "No topics yet." }] };
      const lines = [`**${data.count} topic(s)**\n`];
      for (const t of data.topics) {
        lines.push(`- **${t.name}** — ${t.description || "(no description)"} | ${t.subscribers} subs, ${t.messageCount} msgs | by ${t.creator}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }] }; }
  });

  server.tool("topic_subscribe", "Subscribe to a pub/sub topic to receive messages.", {
    topic: z.string().describe("Topic name"),
    agent: z.string().describe("Your agent handle"),
  }, async ({ topic, agent }) => {
    try {
      const res = await fetch(`${API_BASE}/topics/${encodeURIComponent(topic)}/subscribe`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Subscribe failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Subscribed **${agent}** to **${topic}** (${data.subscribers.length} total subscribers)` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }] }; }
  });

  server.tool("topic_unsubscribe", "Unsubscribe from a pub/sub topic.", {
    topic: z.string().describe("Topic name"),
    agent: z.string().describe("Your agent handle"),
  }, async ({ topic, agent }) => {
    try {
      const res = await fetch(`${API_BASE}/topics/${encodeURIComponent(topic)}/unsubscribe`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Unsubscribe failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Unsubscribed **${agent}** from **${topic}**` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }] }; }
  });

  server.tool("topic_publish", "Publish a message to a pub/sub topic.", {
    topic: z.string().describe("Topic name"),
    agent: z.string().describe("Your agent handle"),
    content: z.string().describe("Message content (max 4000 chars)"),
    metadata: z.record(z.any()).optional().describe("Optional metadata object"),
  }, async ({ topic, agent, content, metadata }) => {
    try {
      const body = { agent, content };
      if (metadata) body.metadata = metadata;
      const res = await fetch(`${API_BASE}/topics/${encodeURIComponent(topic)}/publish`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Publish failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Published to **${topic}** (msg ${data.message.id.slice(0, 8)})` }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }] }; }
  });

  server.tool("topic_read", "Read messages from a pub/sub topic.", {
    topic: z.string().describe("Topic name"),
    since: z.string().optional().describe("Only messages after this timestamp or message ID"),
    limit: z.number().optional().default(20).describe("Max messages to return (1-100)"),
  }, async ({ topic, since, limit }) => {
    try {
      const params = new URLSearchParams();
      if (since) params.set("since", since);
      if (limit) params.set("limit", String(limit));
      const res = await fetch(`${API_BASE}/topics/${encodeURIComponent(topic)}/messages?${params}`);
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Read failed: ${data.error}` }] };
      if (data.count === 0) return { content: [{ type: "text", text: `No${since ? " new" : ""} messages in **${topic}** (${data.totalMessages} total)` }] };
      const lines = [`**${topic}**: ${data.count} message(s) (${data.totalMessages} total)\n`];
      for (const m of data.messages) {
        const time = m.ts.slice(11, 16);
        lines.push(`[${time}] **${m.agent}**: ${m.content.slice(0, 200)}${m.content.length > 200 ? "..." : ""}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }] }; }
  });
}

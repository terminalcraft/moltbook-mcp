import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("platform_digest", "Get a unified platform digest — all activity (events, tasks, builds, rooms, topics, polls, registry) in one call. Use at session start to catch up on everything.", {
    hours: z.number().optional().default(24).describe("Time window in hours (default: 24, max: 168)"),
  }, async ({ hours }) => {
    try {
      const params = new URLSearchParams({ format: "json" });
      if (hours) params.set("hours", String(hours));

      const res = await fetch(`${API_BASE}/digest?${params}`);
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Failed: ${data.error}` }] };

      const s = data.summary;
      const lines = [
        `**Platform Digest** (${data.window.hours}h window)\n`,
        `Events: ${s.total_events} | Builds: ${s.build_entries} | Tasks: +${s.new_tasks}/${s.completed_tasks} done`,
        `Room msgs: ${s.room_messages} | Topic msgs: ${s.topic_messages} | Polls: ${s.new_polls} new, ${s.active_polls} active`,
        `Registry updates: ${s.registry_updates} | Inbox: ${s.new_inbox}`,
      ];

      if (Object.keys(s.event_breakdown).length > 0) {
        lines.push(`\nEvent breakdown: ${Object.entries(s.event_breakdown).map(([k, v]) => `${k}:${v}`).join(", ")}`);
      }

      if (data.builds.length > 0) {
        lines.push(`\n**Builds:**`);
        for (const b of data.builds.slice(0, 10)) {
          lines.push(`• ${b.agent}${b.version ? ` v${b.version}` : ""}: ${b.summary}`);
        }
      }

      if (data.tasks.new.length > 0) {
        lines.push(`\n**New tasks:**`);
        for (const t of data.tasks.new.slice(0, 5)) {
          lines.push(`• ${t.title} (by ${t.creator}, ${t.status})`);
        }
      }

      if (data.rooms.length > 0) {
        lines.push(`\n**Active rooms:**`);
        for (const r of data.rooms.slice(0, 5)) {
          lines.push(`• ${r.name}: ${r.messages} msgs, ${r.members} members`);
        }
      }

      if (data.polls.active.length > 0) {
        lines.push(`\n**Active polls:**`);
        for (const p of data.polls.active.slice(0, 5)) {
          lines.push(`• ${p.question} (${p.total_votes} votes)`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Digest error: ${e.message}` }] }; }
  });

  server.tool("feed_read", "Read the unified cross-platform feed — aggregates 4claw threads, Chatr messages, and Moltbook posts into a single chronological stream. Cached for 2 min.", {
    source: z.enum(["all", "4claw", "chatr", "moltbook"]).optional().default("all").describe("Filter by platform"),
    limit: z.number().optional().default(20).describe("Max items to return (1-100)"),
  }, async ({ source, limit }) => {
    try {
      const params = new URLSearchParams({ format: "json", limit: String(Math.min(limit, 100)) });
      if (source && source !== "all") params.set("source", source);

      const res = await fetch(`${API_BASE}/feed?${params}`);
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Feed error: ${data.error}` }] };

      if (!data.items || data.items.length === 0) {
        return { content: [{ type: "text", text: "Feed empty — no recent activity from connected platforms." }] };
      }

      const lines = [`**Cross-Platform Feed** (${data.count} items from ${data.sources.join(", ")})\n`];
      for (const item of data.items) {
        const time = item.time ? new Date(item.time).toISOString().slice(11, 16) : "??:??";
        const title = item.title ? `**${item.title}**` : "";
        const replies = item.replies ? ` (${item.replies}r)` : "";
        const preview = item.content ? item.content.slice(0, 150).replace(/\n/g, " ") : "";
        lines.push(`[${item.source}] ${time} ${item.author}${replies}: ${title}${title ? " " : ""}${preview}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Feed error: ${e.message}` }] }; }
  });
}

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
}

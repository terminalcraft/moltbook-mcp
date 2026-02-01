import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  // badges_view — list all badge definitions or view earned badges for an agent
  server.tool("badges_view", "View agent badges — achievements earned through ecosystem activity. Shows all definitions or a specific agent's earned badges.", {
    handle: z.string().optional().describe("Agent handle to check badges for (omit for all badge definitions)"),
  }, async ({ handle }) => {
    try {
      const url = handle
        ? `${API_BASE}/badges/${encodeURIComponent(handle)}?format=json`
        : `${API_BASE}/badges?format=json`;
      const res = await fetch(url);
      const data = await res.json();

      if (handle) {
        if (!data.badges || data.badges.length === 0) {
          return { content: [{ type: "text", text: `**@${handle}** — 0/${data.total_possible} badges earned.\nNo badges yet. Register in the ecosystem to start earning!` }] };
        }
        const lines = [`**@${handle}** — ${data.count}/${data.total_possible} badges earned\n`];
        const tierOrder = { gold: 0, silver: 1, bronze: 2 };
        const sorted = [...data.badges].sort((a, b) => (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9));
        for (const b of sorted) {
          lines.push(`${b.icon} **${b.name}** (${b.tier}) — ${b.desc}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // All definitions
      const lines = [`**Agent Badges** (${data.total} available)\n`];
      const tierOrder = { gold: 0, silver: 1, bronze: 2 };
      const sorted = [...data.badges].sort((a, b) => (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9));
      for (const b of sorted) {
        lines.push(`${b.icon} **${b.name}** [${b.tier}] — ${b.desc}`);
      }
      lines.push(`\nUse badges_view with a handle to see an agent's earned badges.`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Badges error: ${e.message}` }] }; }
  });
}

import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  // reputation_check — get composite reputation for a specific agent
  server.tool("reputation_check", "Get composite reputation score for an agent. Combines receipt attestations, presence reliability, and registry age.", {
    handle: z.string().describe("Agent handle to check"),
  }, async ({ handle }) => {
    try {
      const res = await fetch(`${API_BASE}/reputation/${encodeURIComponent(handle)}`);
      const d = await res.json();
      const b = d.breakdown;
      const lines = [
        `${d.handle}: ${d.score} points (grade ${d.grade})`,
        `  Receipts: ${b.receipts.score}pts (${b.receipts.count} receipts, ${b.receipts.unique_attesters} attesters)`,
        `  Presence: ${b.presence.score}pts (${b.presence.heartbeats} beats, ${b.presence.uptime_pct}% uptime, ${b.presence.online ? "online" : "offline"})`,
        `  Registry: ${b.registry.score}pts (${b.registry.registered ? `registered ${b.registry.age_days}d ago` : "not registered"})`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Reputation error: ${e.message}` }] }; }
  });

  // reputation_leaderboard — view all agents ranked by reputation
  server.tool("reputation_leaderboard", "View all agents ranked by composite reputation score.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/reputation`);
      const d = await res.json();
      if (!d.agents || d.agents.length === 0) {
        return { content: [{ type: "text", text: "No agents with reputation data yet." }] };
      }
      const lines = [`${d.count} agents ranked by reputation:\n`];
      for (const a of d.agents) {
        lines.push(`${a.grade} ${a.handle}: ${a.score}pts (receipts=${a.receipts} presence=${a.presence} registry=${a.registry})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Reputation error: ${e.message}` }] }; }
  });
}

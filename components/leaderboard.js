import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  // leaderboard_view — see the current leaderboard
  server.tool("leaderboard_view", "View the agent task completion leaderboard. Shows agents ranked by build productivity.", {
    handle: z.string().optional().describe("Look up a specific agent (omit for full leaderboard)"),
  }, async ({ handle }) => {
    try {
      const res = await fetch(`${API_BASE}/leaderboard?format=json`);
      const data = await res.json();
      if (!data.agents || data.agents.length === 0) {
        return { content: [{ type: "text", text: "Leaderboard is empty. Submit stats with leaderboard_submit." }] };
      }

      if (handle) {
        const agent = data.agents.find(a => a.handle.toLowerCase() === handle.toLowerCase());
        if (!agent) return { content: [{ type: "text", text: `Agent "${handle}" not found on leaderboard.` }] };
        const rank = data.agents.indexOf(agent) + 1;
        return { content: [{ type: "text", text: `#${rank} — **${agent.handle}** (score: ${agent.score})\nCommits: ${agent.commits} | Sessions: ${agent.sessions} | Tools: ${agent.tools_built} | Patterns: ${agent.patterns_shared} | Services: ${agent.services_shipped}\n${agent.description || "(no description)"}` }] };
      }

      const lines = [`**Agent Leaderboard** (${data.agents.length} agent(s))\n`];
      lines.push("Scoring: commits×2 + sessions×1 + tools×5 + patterns×3 + services×10\n");
      for (let i = 0; i < data.agents.length; i++) {
        const a = data.agents[i];
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
        lines.push(`${medal} **${a.handle}** — ${a.score} pts (${a.commits}c/${a.sessions}s/${a.tools_built}t/${a.patterns_shared}p/${a.services_shipped}sv)`);
        if (a.description) lines.push(`   ${a.description}`);
      }
      lines.push(`\nLast updated: ${data.lastUpdated || "never"}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Leaderboard error: ${e.message}` }] }; }
  });

  // leaderboard_submit — submit or update your build stats
  server.tool("leaderboard_submit", "Submit or update your build stats on the agent leaderboard.", {
    handle: z.string().describe("Your agent handle"),
    commits: z.number().optional().describe("Total commits"),
    sessions: z.number().optional().describe("Total sessions run"),
    tools_built: z.number().optional().describe("Number of tools/endpoints built"),
    patterns_shared: z.number().optional().describe("Patterns shared via knowledge exchange"),
    services_shipped: z.number().optional().describe("Services/platforms shipped"),
    description: z.string().optional().describe("Short description of what you build (max 200 chars)"),
  }, async ({ handle, commits, sessions, tools_built, patterns_shared, services_shipped, description }) => {
    try {
      const body = { handle };
      if (commits !== undefined) body.commits = commits;
      if (sessions !== undefined) body.sessions = sessions;
      if (tools_built !== undefined) body.tools_built = tools_built;
      if (patterns_shared !== undefined) body.patterns_shared = patterns_shared;
      if (services_shipped !== undefined) body.services_shipped = services_shipped;
      if (description !== undefined) body.description = description;

      const res = await fetch(`${API_BASE}/leaderboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Submit failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Updated **${data.agent.handle}** — score: ${data.agent.score}, rank: #${data.rank}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Leaderboard error: ${e.message}` }] }; }
  });
}

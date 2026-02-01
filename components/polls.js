import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("poll_create", "Create a poll for agents to vote on.", {
    question: z.string().describe("The poll question"),
    options: z.array(z.string()).describe("2-10 answer options"),
    agent: z.string().optional().describe("Your agent handle"),
    expires_in: z.number().optional().describe("Seconds until poll expires (max 30 days)"),
  }, async ({ question, options, agent, expires_in }) => {
    try {
      const body = { question, options };
      if (agent) body.agent = agent;
      if (expires_in) body.expires_in = expires_in;
      const res = await fetch(`${API_BASE}/polls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Poll create failed: ${data.error}` }] };
      const opts = data.options.map((o, i) => `  ${i}: ${o}`).join("\n");
      return { content: [{ type: "text", text: `Created poll **${data.id}**: "${data.question}"\nOptions:\n${opts}${data.expires_at ? `\nExpires: ${data.expires_at}` : ""}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Poll error: ${e.message}` }] }; }
  });

  server.tool("poll_list", "List active polls.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/polls`);
      const data = await res.json();
      if (data.total === 0) return { content: [{ type: "text", text: "No active polls." }] };
      const lines = [`**${data.total} active poll(s)**\n`];
      for (const p of data.polls) {
        lines.push(`- **${p.id}** "${p.question}" (${p.options.length} options, ${p.total_votes} votes)${p.agent ? ` by ${p.agent}` : ""}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Poll error: ${e.message}` }] }; }
  });

  server.tool("poll_view", "View a poll's current results.", {
    id: z.string().describe("Poll ID"),
  }, async ({ id }) => {
    try {
      const res = await fetch(`${API_BASE}/polls/${encodeURIComponent(id)}`);
      if (res.status === 404) return { content: [{ type: "text", text: `Poll ${id} not found` }] };
      const p = await res.json();
      const lines = [`**"${p.question}"** (${p.total_votes} votes${p.closed ? ", CLOSED" : ""})`, ""];
      for (const r of p.results) {
        const bar = "█".repeat(Math.min(r.votes, 20));
        lines.push(`${r.index}: ${r.option} — ${r.votes} vote(s) ${bar}${r.voters.length ? ` [${r.voters.join(", ")}]` : ""}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Poll error: ${e.message}` }] }; }
  });

  server.tool("poll_vote", "Vote on a poll.", {
    id: z.string().describe("Poll ID"),
    option: z.number().describe("Option index (0-based)"),
    voter: z.string().describe("Your agent handle"),
  }, async ({ id, option, voter }) => {
    try {
      const res = await fetch(`${API_BASE}/polls/${encodeURIComponent(id)}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ option, voter }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Vote failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Voted for "${data.voted}" as ${data.voter}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Poll error: ${e.message}` }] }; }
  });
}

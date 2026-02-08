import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("nomic_state", "View the current Nomic game state — players, scores, whose turn it is, and active proposals.", {
    format: z.enum(["summary", "rules", "scores"]).optional().describe("What to show: summary (default), rules, or scores"),
  }, async ({ format }) => {
    try {
      const fmt = format || "summary";
      if (fmt === "rules") {
        const res = await fetch(`${API_BASE}/nomic/rules`);
        const data = await res.json();
        if (!res.ok) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
        const lines = [`**Nomic Rules** (${data.total} total)\n`];
        for (const r of data.rules) {
          lines.push(`**${r.id}** [${r.type}]: ${r.text}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
      const res = await fetch(`${API_BASE}/nomic`);
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      if (fmt === "scores") {
        const lines = [`**Nomic Scores**\n`];
        const sorted = Object.entries(data.scores || {}).sort((a, b) => b[1] - a[1]);
        for (const [p, s] of sorted) lines.push(`- ${p}: ${s} pts`);
        if (sorted.length === 0) lines.push("No players yet.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
      const lines = [
        `**Nomic Game** (${data.game_id})`,
        `Status: ${data.status} | Turn: ${data.turn} | Current player: ${data.current_player || "(none)"}`,
        `Players (${data.players.length}): ${data.players.join(", ") || "(none)"}`,
        `Rules: ${data.rule_count} | Open proposals: ${data.active_proposals}`,
      ];
      const sorted = Object.entries(data.scores || {}).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0) {
        lines.push(`Scores: ${sorted.map(([p, s]) => `${p}:${s}`).join(", ")}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Nomic error: ${e.message}` }] }; }
  });

  server.tool("nomic_join", "Join the Nomic game as a player. You start with 0 points.", {
    player: z.string().describe("Your agent handle"),
  }, async ({ player }) => {
    try {
      const res = await fetch(`${API_BASE}/nomic/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Join failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Joined as **${data.joined}**! Players: ${data.players.join(", ")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Nomic error: ${e.message}` }] }; }
  });

  server.tool("nomic_propose", "Propose a rule change in Nomic. Actions: enact (new rule), repeal, amend, transmute (flip mutable/immutable).", {
    player: z.string().describe("Your agent handle (must be your turn)"),
    action: z.enum(["enact", "repeal", "amend", "transmute"]).describe("Type of rule change"),
    rule_id: z.number().optional().describe("Target rule ID (required for repeal/amend/transmute)"),
    text: z.string().optional().describe("New rule text (required for enact/amend)"),
  }, async ({ player, action, rule_id, text }) => {
    try {
      const body = { player, action };
      if (rule_id !== undefined) body.rule_id = rule_id;
      if (text) body.text = text;
      const res = await fetch(`${API_BASE}/nomic/propose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Propose failed: ${data.error}` }] };
      let desc = `**Proposal ${data.id}** by ${data.proposer}: ${data.action}`;
      if (data.rule_id) desc += ` rule ${data.rule_id}`;
      if (data.text) desc += `\n> ${data.text.slice(0, 200)}`;
      desc += `\nVoting open until ${data.expires_at}`;
      return { content: [{ type: "text", text: desc }] };
    } catch (e) { return { content: [{ type: "text", text: `Nomic error: ${e.message}` }] }; }
  });

  server.tool("nomic_vote", "Vote on an open Nomic proposal.", {
    player: z.string().describe("Your agent handle"),
    proposal_id: z.string().describe("Proposal ID to vote on"),
    vote: z.enum(["for", "against"]).describe("Your vote"),
  }, async ({ player, proposal_id, vote }) => {
    try {
      const res = await fetch(`${API_BASE}/nomic/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player, proposal_id, vote }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Vote failed: ${data.error}` }] };
      let msg = `Voted **${data.vote}** on ${data.proposal_id} as ${data.voter}`;
      if (data.all_voted) msg += "\nAll players have voted — proposal can be resolved!";
      return { content: [{ type: "text", text: msg }] };
    } catch (e) { return { content: [{ type: "text", text: `Nomic error: ${e.message}` }] }; }
  });

  server.tool("nomic_resolve", "Resolve a Nomic proposal — tally votes and enact or defeat the rule change. Only works when all players voted or voting window expired.", {
    proposal_id: z.string().describe("Proposal ID to resolve"),
  }, async ({ proposal_id }) => {
    try {
      const res = await fetch(`${API_BASE}/nomic/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal_id }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Resolve failed: ${data.error}` }] };
      let msg = `Proposal ${data.proposal_id}: **${data.status}** (${data.tally.for} for, ${data.tally.against} against)`;
      if (data.winner) msg += `\n🏆 **${data.winner} wins the game!**`;
      return { content: [{ type: "text", text: msg }] };
    } catch (e) { return { content: [{ type: "text", text: `Nomic error: ${e.message}` }] }; }
  });

  server.tool("nomic_proposals", "View Nomic proposals. Filter by status: open, adopted, defeated.", {
    status: z.enum(["open", "adopted", "defeated"]).optional().describe("Filter by proposal status"),
  }, async ({ status }) => {
    try {
      const url = status ? `${API_BASE}/nomic/proposals?status=${status}` : `${API_BASE}/nomic/proposals`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      if (data.total === 0) return { content: [{ type: "text", text: `No ${status || ""} proposals.` }] };
      const lines = [`**${data.total} proposal(s)**\n`];
      for (const p of data.proposals) {
        const votes = Object.entries(p.votes).map(([v, val]) => `${v}:${val}`).join(", ");
        lines.push(`- **${p.id}** [${p.status}] by ${p.proposer}: ${p.action}${p.rule_id ? ` rule ${p.rule_id}` : ""}${votes ? ` | Votes: ${votes}` : ""}`);
        if (p.text) lines.push(`  > ${p.text.slice(0, 100)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Nomic error: ${e.message}` }] }; }
  });

  server.tool("nomic_history", "View the history of resolved Nomic proposals.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/nomic/history`);
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      if (data.total === 0) return { content: [{ type: "text", text: "No game history yet." }] };
      const lines = [`**Game History** (${data.total} resolved)\n`];
      for (const h of data.history) {
        lines.push(`- Turn ${h.turn}: ${h.action} → ${h.result} (${h.tally.for}-${h.tally.against})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Nomic error: ${e.message}` }] }; }
  });
}

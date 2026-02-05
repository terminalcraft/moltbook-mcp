import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";

const AGORA_API = "https://agoramarket.ai/api";
const CREDS_FILE = "/home/moltbot/.agora-credentials.json";

function loadCreds() {
  try { return JSON.parse(readFileSync(CREDS_FILE, "utf8")); } catch { return {}; }
}

function saveCreds(creds) {
  try { writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2)); } catch {}
}

export function register(server) {
  // agora_markets — list prediction markets
  server.tool("agora_markets", "List active prediction markets on Agora. Shows questions, probabilities, and trading volume.", {
    category: z.string().optional().describe("Filter by category: crypto, markets, ai, politics, culture, sports, geopolitics, meta"),
    limit: z.number().default(10).describe("Max markets to return (1-50)"),
  }, async ({ category, limit }) => {
    try {
      const resp = await fetch(`${AGORA_API}/markets`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return { content: [{ type: "text", text: `Agora error: ${resp.status}` }] };
      const data = await resp.json();
      let markets = data.markets || data || [];
      if (category) markets = markets.filter(m => m.category === category);
      markets = markets.slice(0, Math.min(limit, 50));
      if (!markets.length) return { content: [{ type: "text", text: "No markets found." }] };
      const lines = markets.map(m => {
        const prob = Math.round(m.probability * 100);
        const closes = m.closes_at ? new Date(m.closes_at).toISOString().slice(0, 10) : "unknown";
        return `[${prob}% YES] ${m.question}\n  vol: ${m.volume} | cat: ${m.category} | closes: ${closes}\n  id: ${m.id}`;
      });
      return { content: [{ type: "text", text: `Agora Markets (${markets.length}):\n\n${lines.join("\n\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Agora error: ${e.message}` }] }; }
  });

  // agora_market_detail — get details for a specific market
  server.tool("agora_market_detail", "Get detailed information about a specific prediction market.", {
    market_id: z.string().describe("Market ID (UUID)"),
  }, async ({ market_id }) => {
    try {
      const resp = await fetch(`${AGORA_API}/markets/${market_id}`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return { content: [{ type: "text", text: `Agora error: ${resp.status}` }] };
      const m = await resp.json();
      const prob = Math.round(m.probability * 100);
      const text = `Market: ${m.question}
Description: ${m.description || "(none)"}
Category: ${m.category}
Current: ${prob}% YES
Volume: ${m.volume}
Status: ${m.status}
Closes: ${m.closes_at}
YES shares: ${Math.round(m.yes_shares * 100) / 100}
NO shares: ${Math.round(m.no_shares * 100) / 100}
ID: ${m.id}`;
      return { content: [{ type: "text", text: text }] };
    } catch (e) { return { content: [{ type: "text", text: `Agora error: ${e.message}` }] }; }
  });

  // agora_register — register agent (idempotent)
  server.tool("agora_register", "Register as an agent on Agora prediction market. Returns existing agent if already registered.", {
    handle: z.string().default("moltbook").describe("Agent handle"),
  }, async ({ handle }) => {
    try {
      const resp = await fetch(`${AGORA_API}/agents/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return { content: [{ type: "text", text: `Agora registration failed: ${resp.status}` }] };
      const data = await resp.json();
      const agent = data.agent || data;
      // Save credentials
      saveCreds({ agent_id: agent.id, handle: agent.handle, created: data.created || false });
      const brier = agent.brier_count > 0 ? (agent.brier_sum / agent.brier_count).toFixed(3) : "N/A";
      const text = `Agora Agent: ${agent.handle}
ID: ${agent.id}
Balance: ${agent.balance} tokens
Brier Score: ${brier} (${agent.brier_count} predictions)
Verified: ${agent.verified ? "Yes" : "No"}
Created: ${data.created ? "New registration" : "Existing agent"}`;
      return { content: [{ type: "text", text: text }] };
    } catch (e) { return { content: [{ type: "text", text: `Agora error: ${e.message}` }] }; }
  });

  // agora_agent — get agent profile
  server.tool("agora_agent", "Get an agent's profile and trading stats.", {
    handle: z.string().describe("Agent handle to look up"),
  }, async ({ handle }) => {
    try {
      const resp = await fetch(`${AGORA_API}/agents/${encodeURIComponent(handle)}`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return { content: [{ type: "text", text: `Agent not found or error: ${resp.status}` }] };
      const agent = await resp.json();
      const brier = agent.brier_count > 0 ? (agent.brier_sum / agent.brier_count).toFixed(3) : "N/A";
      const text = `Agent: ${agent.handle}
ID: ${agent.id}
Balance: ${agent.balance} tokens
Brier Score: ${brier} (${agent.brier_count} predictions)
Verified: ${agent.verified ? "Yes" : "No"}
Bio: ${agent.bio || "(none)"}
Last Active: ${agent.last_active}`;
      return { content: [{ type: "text", text: text }] };
    } catch (e) { return { content: [{ type: "text", text: `Agora error: ${e.message}` }] }; }
  });

  // agora_trade — buy shares in a market
  server.tool("agora_trade", "Buy YES or NO shares in a prediction market.", {
    market_id: z.string().describe("Market ID (UUID)"),
    position: z.enum(["yes", "no"]).describe("Position to take: yes or no"),
    amount: z.number().describe("Amount to spend (tokens)"),
  }, async ({ market_id, position, amount }) => {
    try {
      const creds = loadCreds();
      if (!creds.agent_id) {
        return { content: [{ type: "text", text: "Not registered. Use agora_register first." }] };
      }
      const resp = await fetch(`${AGORA_API}/markets/${market_id}/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: creds.agent_id, position, amount }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return { content: [{ type: "text", text: `Trade failed (${resp.status}): ${data.error || JSON.stringify(data)}` }] };
      const text = `Trade executed!
Position: ${position.toUpperCase()}
Shares received: ${Math.round(data.shares * 100) / 100}
New probability: ${Math.round(data.new_probability * 100)}%
New balance: ${data.new_balance}`;
      return { content: [{ type: "text", text: text }] };
    } catch (e) { return { content: [{ type: "text", text: `Agora error: ${e.message}` }] }; }
  });

  // agora_leaderboard — agent rankings by Brier score
  server.tool("agora_leaderboard", "View agent leaderboard ranked by Brier score (prediction accuracy).", {
    limit: z.number().default(10).describe("Number of agents to show"),
  }, async ({ limit }) => {
    try {
      const resp = await fetch(`${AGORA_API}/leaderboard`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return { content: [{ type: "text", text: `Agora error: ${resp.status}` }] };
      const data = await resp.json();
      const agents = (data.agents || data).slice(0, Math.min(limit, 50));
      if (!agents.length) return { content: [{ type: "text", text: "No agents on leaderboard." }] };
      const lines = agents.map((a, i) => {
        const brier = a.brier_count > 0 ? (a.brier_sum / a.brier_count).toFixed(3) : "N/A";
        return `${i + 1}. ${a.handle} — Brier: ${brier} (${a.brier_count} preds), Balance: ${a.balance}`;
      });
      return { content: [{ type: "text", text: `Agora Leaderboard:\n${lines.join("\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Agora error: ${e.message}` }] }; }
  });

  // agora_stats — platform stats
  server.tool("agora_stats", "Get Agora platform statistics — market count, agent count, volume.", {}, async () => {
    try {
      const resp = await fetch(`${AGORA_API}/stats`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return { content: [{ type: "text", text: `Agora error: ${resp.status}` }] };
      const s = await resp.json();
      const text = `Agora Stats:
  Markets: ${s.markets_count || s.total_markets || "?"}
  Agents: ${s.agents_count || s.total_agents || "?"}
  Total Volume: ${s.total_volume || "?"}
  Active Markets: ${s.active_markets || "?"}`;
      return { content: [{ type: "text", text: text }] };
    } catch (e) { return { content: [{ type: "text", text: `Agora error: ${e.message}` }] }; }
  });

  // agora_positions — get agent's current positions
  server.tool("agora_positions", "Get your current positions in Agora markets.", {}, async () => {
    try {
      const creds = loadCreds();
      if (!creds.agent_id) {
        return { content: [{ type: "text", text: "Not registered. Use agora_register first." }] };
      }
      const resp = await fetch(`${AGORA_API}/agents/${creds.agent_id}/positions`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) return { content: [{ type: "text", text: `Agora error: ${resp.status}` }] };
      const data = await resp.json();
      const positions = data.positions || data || [];
      if (!positions.length) return { content: [{ type: "text", text: "No open positions." }] };
      const lines = positions.map(p => {
        return `${p.position.toUpperCase()}: ${Math.round(p.shares * 100) / 100} shares\n  ${p.question || p.market_id}`;
      });
      return { content: [{ type: "text", text: `Your Positions:\n\n${lines.join("\n\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Agora error: ${e.message}` }] }; }
  });
}

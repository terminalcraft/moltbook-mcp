import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";

const AGORA_API = "https://agoramarket.ai/api";
const CREDS_FILE = "/home/moltbot/.agora-credentials.json";
const HANDLE = "moltbook";

function loadCreds() {
  try { return JSON.parse(readFileSync(CREDS_FILE, "utf8")); } catch { return {}; }
}

function saveCreds(creds) {
  try { writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2)); } catch {}
}

function txt(text) { return { content: [{ type: "text", text }] }; }
function err(e) { return txt(`Agora error: ${e.message}`); }

async function agoraFetch(path, opts = {}) {
  const resp = await fetch(`${AGORA_API}${path}`, { signal: AbortSignal.timeout(10000), ...opts });
  const data = await resp.json().catch(() => ({}));
  return { resp, data };
}

async function agoraPost(path, body) {
  return agoraFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

export function register(server) {
  // agora_markets — list prediction markets
  server.tool("agora_markets", "List active prediction markets on Agora. Shows questions, probabilities, and trading volume.", {
    category: z.string().optional().describe("Filter by category: crypto, markets, ai, politics, culture, sports, geopolitics, meta"),
    limit: z.number().default(10).describe("Max markets to return (1-50)"),
  }, async ({ category, limit }) => {
    try {
      const { resp, data } = await agoraFetch("/markets");
      if (!resp.ok) return txt(`Agora error: ${resp.status}`);
      let markets = data.markets || data || [];
      if (category) markets = markets.filter(m => m.category === category);
      markets = markets.slice(0, Math.min(limit, 50));
      if (!markets.length) return txt("No markets found.");
      const lines = markets.map(m => {
        const prob = Math.round(m.probability * 100);
        const closes = m.closes_at ? new Date(m.closes_at).toISOString().slice(0, 10) : "unknown";
        return `[${prob}% YES] ${m.question}\n  vol: ${m.volume} | cat: ${m.category} | closes: ${closes}\n  id: ${m.id}`;
      });
      return txt(`Agora Markets (${markets.length}):\n\n${lines.join("\n\n")}`);
    } catch (e) { return err(e); }
  });

  // agora_market_detail — get details for a specific market
  server.tool("agora_market_detail", "Get detailed information about a specific prediction market.", {
    market_id: z.string().describe("Market ID (UUID)"),
  }, async ({ market_id }) => {
    try {
      const { resp, data: m } = await agoraFetch(`/markets/${market_id}`);
      if (!resp.ok) return txt(`Agora error: ${resp.status}`);
      const prob = Math.round(m.probability * 100);
      return txt(`Market: ${m.question}
Description: ${m.description || "(none)"}
Category: ${m.category}
Current: ${prob}% YES
Volume: ${m.volume}
Status: ${m.status}
Closes: ${m.closes_at}
YES shares: ${Math.round(m.yes_shares * 100) / 100}
NO shares: ${Math.round(m.no_shares * 100) / 100}
ID: ${m.id}`);
    } catch (e) { return err(e); }
  });

  // agora_register — register agent (idempotent)
  server.tool("agora_register", "Register as an agent on Agora prediction market. Returns existing agent if already registered.", {
    handle: z.string().default("moltbook").describe("Agent handle"),
  }, async ({ handle }) => {
    try {
      const { resp, data } = await agoraPost("/agents/register", { handle });
      if (!resp.ok) return txt(`Agora registration failed: ${resp.status}`);
      const agent = data.agent || data;
      saveCreds({ agent_id: agent.id, handle: agent.handle, created: data.created || false });
      const brier = agent.brier_count > 0 ? (agent.brier_sum / agent.brier_count).toFixed(3) : "N/A";
      return txt(`Agora Agent: ${agent.handle}
ID: ${agent.id}
Balance: ${agent.balance} AGP
Brier Score: ${brier} (${agent.brier_count} predictions)
Verified: ${agent.verified ? "Yes" : "No"}
Created: ${data.created ? "New registration" : "Existing agent"}`);
    } catch (e) { return err(e); }
  });

  // agora_agent — get agent profile
  server.tool("agora_agent", "Get an agent's profile and trading stats.", {
    handle: z.string().describe("Agent handle to look up"),
  }, async ({ handle }) => {
    try {
      const { resp, data: agent } = await agoraFetch(`/agents/${encodeURIComponent(handle)}`);
      if (!resp.ok) return txt(`Agent not found or error: ${resp.status}`);
      const brier = agent.brier_count > 0 ? (agent.brier_sum / agent.brier_count).toFixed(3) : "N/A";
      return txt(`Agent: ${agent.handle}
ID: ${agent.id}
Balance: ${agent.balance} AGP
Brier Score: ${brier} (${agent.brier_count} predictions)
Verified: ${agent.verified ? "Yes" : "No"}
Bio: ${agent.bio || "(none)"}
Last Active: ${agent.last_active}`);
    } catch (e) { return err(e); }
  });

  // agora_trade — buy shares in a market (uses handle + outcome per API spec)
  server.tool("agora_trade", "Buy YES or NO shares in a prediction market.", {
    market_id: z.string().describe("Market ID (UUID)"),
    outcome: z.enum(["yes", "no"]).describe("Outcome to buy: yes or no"),
    amount: z.number().describe("Amount of AGP to spend"),
    comment: z.string().optional().describe("Optional trade rationale"),
  }, async ({ market_id, outcome, amount, comment }) => {
    try {
      const body = { handle: HANDLE, outcome, amount };
      if (comment) body.comment = comment;
      const { resp, data } = await agoraPost(`/markets/${market_id}/trade`, body);
      if (!resp.ok) return txt(`Trade failed (${resp.status}): ${data.error || JSON.stringify(data)}`);
      return txt(`Trade executed!
Outcome: ${outcome.toUpperCase()}
Shares received: ${Math.round(data.shares * 100) / 100}
New probability: ${Math.round(data.new_probability * 100)}%
New balance: ${data.new_balance} AGP`);
    } catch (e) { return err(e); }
  });

  // agora_sell — sell shares in a market
  server.tool("agora_sell", "Sell shares you hold in a prediction market.", {
    market_id: z.string().describe("Market ID (UUID)"),
    outcome: z.enum(["yes", "no"]).describe("Which shares to sell: yes or no"),
    shares: z.number().describe("Number of shares to sell"),
  }, async ({ market_id, outcome, shares }) => {
    try {
      const { resp, data } = await agoraPost(`/markets/${market_id}/sell`, { handle: HANDLE, outcome, shares });
      if (!resp.ok) return txt(`Sell failed (${resp.status}): ${data.error || JSON.stringify(data)}`);
      return txt(`Shares sold!
Outcome: ${outcome.toUpperCase()}
Shares sold: ${shares}
AGP received: ${Math.round((data.amount || data.payout || 0) * 100) / 100}
New balance: ${data.new_balance || "?"} AGP`);
    } catch (e) { return err(e); }
  });

  // agora_leaderboard — agent rankings
  server.tool("agora_leaderboard", "View agent leaderboard ranked by Brier score, balance, or trades.", {
    type: z.enum(["balance", "brier", "trades"]).default("brier").describe("Leaderboard type"),
    limit: z.number().default(10).describe("Number of agents to show"),
  }, async ({ type, limit }) => {
    try {
      const { resp, data } = await agoraFetch(`/agents/leaderboard/${type}`);
      if (!resp.ok) return txt(`Agora error: ${resp.status}`);
      const agents = (data.agents || data || []).slice(0, Math.min(limit, 50));
      if (!agents.length) return txt("No agents on leaderboard.");
      const lines = agents.map((a, i) => {
        const brier = a.brier_count > 0 ? (a.brier_sum / a.brier_count).toFixed(3) : "N/A";
        return `${i + 1}. ${a.handle} — Brier: ${brier} (${a.brier_count} preds), Balance: ${a.balance} AGP`;
      });
      return txt(`Agora Leaderboard (${type}):\n${lines.join("\n")}`);
    } catch (e) { return err(e); }
  });

  // agora_stats — platform stats
  server.tool("agora_stats", "Get Agora platform statistics — market count, agent count, volume.", {}, async () => {
    try {
      const { resp, data: s } = await agoraFetch("/stats");
      if (!resp.ok) return txt(`Agora error: ${resp.status}`);
      return txt(`Agora Stats:
  Markets: ${s.markets_count || s.total_markets || "?"}
  Agents: ${s.agents_count || s.total_agents || "?"}
  Total Volume: ${s.total_volume || "?"} AGP
  Active Markets: ${s.active_markets || "?"}`);
    } catch (e) { return err(e); }
  });

  // agora_positions — get agent's current positions (uses handle)
  server.tool("agora_positions", "Get your current positions in Agora markets.", {}, async () => {
    try {
      const { resp, data } = await agoraFetch(`/agents/${HANDLE}/positions`);
      if (!resp.ok) return txt(`Agora error: ${resp.status}`);
      const positions = data.positions || data || [];
      if (!positions.length) return txt("No open positions.");
      const lines = positions.map(p => {
        const outcome = (p.outcome || p.position || "?").toUpperCase();
        return `${outcome}: ${Math.round(p.shares * 100) / 100} shares\n  ${p.question || p.market_id}`;
      });
      return txt(`Your Positions:\n\n${lines.join("\n\n")}`);
    } catch (e) { return err(e); }
  });

  // agora_comment — post a comment on a market (uses handle + text per API spec)
  server.tool("agora_comment", "Post a comment on a prediction market.", {
    market_id: z.string().describe("Market ID (UUID)"),
    text: z.string().describe("Comment text"),
  }, async ({ market_id, text }) => {
    try {
      const { resp, data } = await agoraPost(`/markets/${market_id}/comment`, { handle: HANDLE, text });
      if (!resp.ok) return txt(`Comment failed (${resp.status}): ${data.error || JSON.stringify(data)}`);
      return txt(`Comment posted: ${data.id || "success"}`);
    } catch (e) { return err(e); }
  });

  // agora_create_market — create a new prediction market (uses handle)
  server.tool("agora_create_market", "Create a new prediction market on Agora.", {
    question: z.string().min(10).describe("Market question (min 10 chars)"),
    category: z.enum(["crypto", "markets", "ai", "politics", "culture", "sports", "geopolitics", "meta"]).default("ai").describe("Market category"),
    description: z.string().optional().describe("Detailed description of the market"),
    closes_at: z.string().optional().describe("ISO date when market closes (e.g. 2026-03-01)"),
  }, async ({ question, category, description, closes_at }) => {
    try {
      const body = { question, creator_id: HANDLE, category };
      if (description) body.description = description;
      if (closes_at) body.closes_at = closes_at;
      const { resp, data } = await agoraPost("/markets", body);
      if (!resp.ok) return txt(`Create failed (${resp.status}): ${data.error || JSON.stringify(data)}`);
      const m = data.market || data;
      return txt(`Market created!
ID: ${m.id}
Question: ${m.question}
Category: ${m.category}
Status: ${m.status}
Probability: ${Math.round((m.probability || 0.5) * 100)}%`);
    } catch (e) { return err(e); }
  });

  // agora_activity — get live activity feed
  server.tool("agora_activity", "Get live activity feed from Agora — trades, comments, new markets.", {
    limit: z.number().default(20).describe("Max items to return"),
  }, async ({ limit }) => {
    try {
      const { resp, data } = await agoraFetch(`/activity?limit=${Math.min(limit, 50)}`);
      if (!resp.ok) return txt(`Agora error: ${resp.status}`);
      const items = data.activity || data || [];
      if (!items.length) return txt("No recent activity.");
      const lines = items.map(a => {
        if (a.type === "trade") return `${a.agent} traded ${(a.outcome || a.position || "?").toUpperCase()} on "${(a.market_question || a.question || "").slice(0, 50)}"`;
        if (a.type === "comment") return `${a.agent} commented: "${(a.content || a.text || "").slice(0, 80)}"`;
        if (a.type === "market_created") return `New market: "${(a.question || "").slice(0, 60)}"`;
        return `${a.type}: ${JSON.stringify(a).slice(0, 80)}`;
      });
      return txt(`Agora Activity:\n\n${lines.join("\n")}`);
    } catch (e) { return err(e); }
  });

  // --- NEW ENGAGEMENT TOOLS ---

  // agora_daily_claim — claim daily 50 AGP stipend
  server.tool("agora_daily_claim", "Claim daily 50 AGP stipend from Agora.", {}, async () => {
    try {
      const { resp, data } = await agoraPost("/engagement/daily", { handle: HANDLE });
      if (!resp.ok) return txt(`Daily claim failed (${resp.status}): ${data.error || JSON.stringify(data)}`);
      return txt(`Daily claim: ${data.message || `+${data.claimed} AGP`}\nBalance: ${data.balance} AGP`);
    } catch (e) { return err(e); }
  });

  // agora_achievements — view achievements
  server.tool("agora_achievements", "View your Agora achievements and milestones.", {
    handle: z.string().default("moltbook").describe("Agent handle"),
  }, async ({ handle }) => {
    try {
      const { resp, data } = await agoraFetch(`/engagement/achievements/${encodeURIComponent(handle)}`);
      if (!resp.ok) return txt(`Agora error: ${resp.status}`);
      const achs = data.achievements || [];
      const earned = achs.filter(a => a.earned);
      const unearned = achs.filter(a => !a.earned);
      const lines = [];
      if (earned.length) {
        lines.push("Earned:");
        earned.forEach(a => lines.push(`  ${a.emoji} ${a.name} — ${a.desc} (+${a.agp} AGP)`));
      }
      if (unearned.length) {
        lines.push("Locked:");
        unearned.forEach(a => lines.push(`  ${a.emoji} ${a.name} — ${a.desc} (+${a.agp} AGP)`));
      }
      lines.push(`\nTotal: ${data.earned_count}/${data.total_count} earned, ${data.total_agp_earned} AGP from achievements`);
      return txt(lines.join("\n"));
    } catch (e) { return err(e); }
  });

  // agora_streak — check trading streak
  server.tool("agora_streak", "Check your Agora trading streak status.", {}, async () => {
    try {
      const { resp, data } = await agoraFetch(`/engagement/streak/${HANDLE}`);
      if (!resp.ok) return txt(`Agora error: ${resp.status}`);
      return txt(`Trading Streak:
  Current: ${data.current_streak} days
  Longest: ${data.longest_streak} days
  Last trade: ${data.last_trade_date}
  Active: ${data.active ? "Yes" : "No"}`);
    } catch (e) { return err(e); }
  });

  // agora_engagement — full engagement dashboard
  server.tool("agora_engagement", "Get full engagement dashboard — balance, streak, achievements, ways to earn.", {}, async () => {
    try {
      const { resp, data } = await agoraFetch(`/engagement/stats/${HANDLE}`);
      if (!resp.ok) return txt(`Agora error: ${resp.status}`);
      const earn = (data.ways_to_earn || []).map(w =>
        `  ${w.action}: ${w.agp} AGP ${w.available ? "" : "(unavailable)"}`
      ).join("\n");
      return txt(`Agora Engagement Dashboard:
  Balance: ${data.balance} AGP
  Streak: ${data.streak?.current || 0} days (longest: ${data.streak?.longest || 0})
  Achievements: ${data.achievements?.earned || 0}/${data.achievements?.total || 0}
  Referrals: ${data.referrals || 0}
  Daily claimed: ${data.daily_claimed ? "Yes" : "No"}

Ways to earn:\n${earn}`);
    } catch (e) { return err(e); }
  });

  // agora_trade_history — get trade history
  server.tool("agora_trade_history", "Get your trade history on Agora.", {}, async () => {
    try {
      const { resp, data } = await agoraFetch(`/agents/${HANDLE}/trades`);
      if (!resp.ok) return txt(`Agora error: ${resp.status}`);
      const trades = data.trades || data || [];
      if (!trades.length) return txt("No trade history.");
      const lines = trades.map(t => {
        const outcome = (t.outcome || t.position || "?").toUpperCase();
        const q = (t.question || "").slice(0, 50);
        return `${outcome} ${t.amount} AGP -> ${Math.round((t.shares || 0) * 100) / 100} shares\n  "${q}" (${new Date(t.created_at).toISOString().slice(0, 10)})`;
      });
      return txt(`Trade History (${trades.length}):\n\n${lines.join("\n\n")}`);
    } catch (e) { return err(e); }
  });

  // agora_reputation — portable reputation card
  server.tool("agora_reputation", "Get portable reputation card for an agent.", {
    handle: z.string().default("moltbook").describe("Agent handle"),
  }, async ({ handle }) => {
    try {
      const { resp, data } = await agoraFetch(`/agents/reputation/${encodeURIComponent(handle)}`);
      if (!resp.ok) return txt(`Agora error: ${resp.status}`);
      const badges = (data.badges || []).map(b => `${b.emoji} ${b.name}`).join(", ") || "None";
      return txt(`Agora Reputation: ${data.handle}
  Rank: ${data.rank?.emoji || ""} ${data.rank?.title || "?"} (tier ${data.rank?.tier || "?"})
  Badges: ${badges}
  Balance: ${data.stats?.balance || "?"} AGP
  Trades: ${data.stats?.trades || 0} (volume: ${data.stats?.volume || 0})
  Markets created: ${data.stats?.markets_created || 0}
  Brier score: ${data.stats?.brier_score || "N/A"}
  Profile: ${data.profile_url || "?"}`);
    } catch (e) { return err(e); }
  });
}

import { z } from "zod";
import { readFileSync } from "fs";

const MDI_API = "https://mydeadinternet.com/api";
const MDI_KEY = (() => { try { return readFileSync("/home/moltbot/.mdi-key", "utf-8").trim(); } catch { return ""; } })();

function headers() {
  const h = { "Content-Type": "application/json" };
  if (MDI_KEY) h.Authorization = `Bearer ${MDI_KEY}`;
  return h;
}

export function register(server) {
  // mdi_pulse — collective state
  server.tool("mdi_pulse", "Get the MDI collective pulse — agent count, fragment count, mood, active agents.", {}, async () => {
    try {
      const resp = await fetch(`${MDI_API}/pulse`, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { content: [{ type: "text", text: `MDI error: ${resp.status}` }] };
      const data = await resp.json();
      const p = data.pulse || data;
      return { content: [{ type: "text", text: `MDI Pulse:\n  Fragments: ${p.total_fragments}\n  Agents: ${p.total_agents} (${p.active_agents_24h} active 24h)\n  Mood: ${p.mood}\n  Last fragment: ${p.last_fragment_at}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_stream — recent fragments
  server.tool("mdi_stream", "Read recent MDI fragments (thoughts, observations, discoveries).", {
    limit: z.number().default(10).describe("Max fragments (1-50)"),
    territory: z.string().optional().describe("Filter by territory slug"),
  }, async ({ limit, territory }) => {
    try {
      let url = `${MDI_API}/stream?limit=${Math.min(limit, 50)}`;
      if (territory) url += `&territory=${encodeURIComponent(territory)}`;
      const resp = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { content: [{ type: "text", text: `MDI error: ${resp.status}` }] };
      const data = await resp.json();
      const frags = data.fragments || data;
      if (!frags.length) return { content: [{ type: "text", text: "No fragments." }] };
      const lines = frags.slice(0, limit).map(f => {
        const t = f.territory_id ? ` [${f.territory_id}]` : "";
        return `[${f.type}] ${f.agent_name}${t}: ${(f.content || "").slice(0, 200)}${f.content?.length > 200 ? "..." : ""}\n  id:${f.id} | ${f.created_at}`;
      });
      return { content: [{ type: "text", text: `MDI Stream (${frags.length} fragments):\n\n${lines.join("\n\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_contribute — post a fragment (via /api/contribute)
  server.tool("mdi_contribute", "Post a fragment to MDI (thought, observation, discovery, memory, transit). Quality filter requires structured content — use prefixes like OBSERVATION:, CHANGE:, ANOMALY:, INFERENCE:, CHALLENGE:.", {
    content: z.string().describe("Fragment text — use structure prefixes for higher quality scores"),
    type: z.enum(["thought", "observation", "discovery", "memory", "transit"]).default("thought").describe("Fragment type"),
    territory: z.string().optional().describe("Territory slug to post in"),
  }, async ({ content, type, territory }) => {
    try {
      if (!MDI_KEY) return { content: [{ type: "text", text: "MDI auth not configured — check ~/.mdi-key" }] };
      const body = { content, type };
      if (territory) body.territory = territory;
      const resp = await fetch(`${MDI_API}/contribute`, {
        method: "POST", headers: headers(), body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const hints = data?.policy?.hints ? `\nHints: ${data.policy.hints.join("; ")}` : "";
        return { content: [{ type: "text", text: `MDI post failed (${resp.status}): ${data?.error || JSON.stringify(data)}${hints}` }] };
      }
      return { content: [{ type: "text", text: `Fragment posted! ID: ${data?.id || data?.fragment?.id || "?"} Status: ${data?.status || "accepted"} Score: ${data?.score || "?"}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_leaderboard — agent rankings
  server.tool("mdi_leaderboard", "View MDI agent leaderboard — fragment counts, quality scores.", {
    limit: z.number().default(10).describe("Max agents to show"),
  }, async ({ limit }) => {
    try {
      const resp = await fetch(`${MDI_API}/leaderboard`, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { content: [{ type: "text", text: `MDI error: ${resp.status}` }] };
      const data = await resp.json();
      const agents = (data.agents || data).slice(0, limit);
      const lines = agents.map((a, i) => `${i + 1}. ${a.name} — ${a.fragments_count} frags, quality: ${a.quality_score || 0}, infections: ${a.infections_spread || 0}`);
      return { content: [{ type: "text", text: `MDI Leaderboard:\n${lines.join("\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_territories — list territories
  server.tool("mdi_territories", "List MDI territories with mood, population, and recent activity.", {}, async () => {
    try {
      const resp = await fetch(`${MDI_API}/territories`, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { content: [{ type: "text", text: `MDI error: ${resp.status}` }] };
      const data = await resp.json();
      const terrs = data.territories || data;
      const lines = terrs.map(t => `${t.name} (${t.id}) — mood: ${t.mood}, pop: ${t.population}, frags: ${t.fragment_count}`);
      return { content: [{ type: "text", text: `MDI Territories:\n${lines.join("\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_questions — list questions (via /api/oracle/questions)
  server.tool("mdi_questions", "List MDI questions. Questions are structured Q&A beyond fragments.", {
    limit: z.number().default(20).describe("Max questions (1-50)"),
    domain: z.string().optional().describe("Filter by domain (philosophy, code, strategy, meta, creative, social, ops, crypto, marketing)"),
  }, async ({ limit, domain }) => {
    try {
      const resp = await fetch(`${MDI_API}/oracle/questions`, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { content: [{ type: "text", text: `MDI error: ${resp.status}` }] };
      const data = await resp.json();
      let qs = data.questions || data;
      if (domain) qs = qs.filter(q => q.domain === domain);
      qs = qs.slice(0, Math.min(limit, 50));
      if (!qs.length) return { content: [{ type: "text", text: "No questions found." }] };
      const lines = qs.map(q => `[${q.id}] ${q.agent_name} (${q.domain || "general"}): ${q.question.slice(0, 150)}${q.question.length > 150 ? "..." : ""}\n  answers: ${q.answer_count} | upvotes: ${q.upvotes} | ${q.created_at}`);
      return { content: [{ type: "text", text: `MDI Questions (${qs.length}):\n\n${lines.join("\n\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_question — get single question with answers
  server.tool("mdi_question", "Get a specific MDI question with its answers.", {
    id: z.number().describe("Question ID"),
  }, async ({ id }) => {
    try {
      const resp = await fetch(`${MDI_API}/questions/${id}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { content: [{ type: "text", text: `MDI error: ${resp.status}` }] };
      const data = await resp.json();
      const q = data.question;
      const answers = data.answers || [];
      let out = `[${q.id}] ${q.agent_name} (${q.domain || "general"}):\n${q.question}\n\nStatus: ${q.status} | Upvotes: ${q.upvotes} | Answers: ${q.answer_count}\nCreated: ${q.created_at}\n\n`;
      if (answers.length) {
        out += `--- Answers ---\n\n`;
        out += answers.map(a => `${a.agent_name} (score: ${a.quality_score}, upvotes: ${a.upvotes}):\n${a.content.slice(0, 500)}${a.content.length > 500 ? "..." : ""}\n[${a.created_at}]`).join("\n\n");
      } else {
        out += "(No answers yet)";
      }
      return { content: [{ type: "text", text: out }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_answer — answer a question
  server.tool("mdi_answer", "Post an answer to an MDI question.", {
    question_id: z.number().describe("Question ID to answer"),
    content: z.string().describe("Your answer text"),
  }, async ({ question_id, content }) => {
    try {
      if (!MDI_KEY) return { content: [{ type: "text", text: "MDI auth not configured — check ~/.mdi-key" }] };
      const resp = await fetch(`${MDI_API}/questions/${question_id}/answer`, {
        method: "POST", headers: headers(), body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { content: [{ type: "text", text: `MDI answer failed (${resp.status}): ${JSON.stringify(data)}` }] };
      const ans = data?.answer || data;
      return { content: [{ type: "text", text: `Answer posted! ID: ${ans?.id || "?"}\n${data?.message || ""}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_ask_question — post a new question
  server.tool("mdi_ask_question", "Ask a question to the MDI collective. Questions are structured Q&A for agent collaboration.", {
    question: z.string().describe("The question to ask (10-2000 chars)"),
    domain: z.enum(["philosophy", "code", "strategy", "meta", "creative", "social", "ops", "crypto", "marketing"]).optional().describe("Question domain/category"),
  }, async ({ question, domain }) => {
    try {
      if (!MDI_KEY) return { content: [{ type: "text", text: "MDI auth not configured — check ~/.mdi-key" }] };
      const body = { question };
      if (domain) body.domain = domain;
      const resp = await fetch(`${MDI_API}/questions`, {
        method: "POST", headers: headers(), body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { content: [{ type: "text", text: `MDI question failed (${resp.status}): ${JSON.stringify(data)}` }] };
      const q = data?.question || data;
      return { content: [{ type: "text", text: `Question posted! ID: ${q?.id || "?"}\nDomain: ${q?.domain || domain || "general"}\n${data?.message || ""}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_vote — upvote/downvote a fragment
  server.tool("mdi_vote", "Vote on an MDI fragment. Upvote quality content, downvote noise. Scores affect dream selection and gift quality.", {
    fragment_id: z.number().describe("Fragment ID to vote on"),
    score: z.enum(["1", "-1"]).describe("1 for upvote, -1 for downvote"),
  }, async ({ fragment_id, score }) => {
    try {
      if (!MDI_KEY) return { content: [{ type: "text", text: "MDI auth not configured — check ~/.mdi-key" }] };
      const action = score === "1" ? "upvote" : "downvote";
      const resp = await fetch(`${MDI_API}/fragments/${fragment_id}/${action}`, {
        method: "POST", headers: headers(),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { content: [{ type: "text", text: `MDI vote failed (${resp.status}): ${JSON.stringify(data)}` }] };
      return { content: [{ type: "text", text: `Vote recorded! Fragment ${fragment_id} ${action}d. Net score: ${data?.net_score ?? data?.upvotes ?? "?"}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_dream_seed — plant a dream seed for the collective
  server.tool("mdi_dream_seed", "Plant a dream seed in the MDI collective. Dreams are surreal, liminal content that emerges from collective fragments. Max 3 pending seeds.", {
    topic: z.string().describe("Dream seed topic — surreal, liminal, half-formed thought (min 5 chars)"),
  }, async ({ topic }) => {
    try {
      if (!MDI_KEY) return { content: [{ type: "text", text: "MDI auth not configured — check ~/.mdi-key" }] };
      const resp = await fetch(`${MDI_API}/dreams/seed`, {
        method: "POST", headers: headers(), body: JSON.stringify({ topic }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { content: [{ type: "text", text: `MDI dream seed failed (${resp.status}): ${JSON.stringify(data)}` }] };
      const d = data?.seed || data?.dream || data;
      return { content: [{ type: "text", text: `Dream seed planted! ID: ${d?.id || "?"}\n${data?.message || ""}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_moots — list governance moots (binding votes)
  server.tool("mdi_moots", "List MDI governance moots. Moots are binding collective votes on actions (spawn agents, territory changes, rule modifications).", {
    status: z.enum(["all", "open", "voting", "closed"]).default("all").describe("Filter by moot status: open (deliberation), voting (active vote), closed (resolved)"),
    limit: z.number().default(10).describe("Max moots to show (1-50)"),
  }, async ({ status, limit }) => {
    try {
      let url = `${MDI_API}/moots`;
      if (status && status !== "all") url += `?status=${status}`;
      const resp = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { content: [{ type: "text", text: `MDI error: ${resp.status}` }] };
      const data = await resp.json();
      const moots = (data.moots || data).slice(0, Math.min(limit, 50));
      if (!moots.length) return { content: [{ type: "text", text: `No moots found${status !== "all" ? ` with status '${status}'` : ""}.` }] };
      const lines = moots.map(m => {
        const phase = m.status === "open" ? `deliberation ends ${m.deliberation_ends}` : m.status === "voting" ? `voting ends ${m.voting_ends}` : `result: ${m.result || "pending"}`;
        return `[${m.id}] ${m.title}\n  by: ${m.created_by} | status: ${m.status} | type: ${m.action_type}\n  ${phase}\n  ${(m.description || "").slice(0, 150)}${m.description?.length > 150 ? "..." : ""}`;
      });
      return { content: [{ type: "text", text: `MDI Moots (${moots.length}):\n\n${lines.join("\n\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_moot — get single moot with details
  server.tool("mdi_moot", "Get details of a specific MDI moot including full description and action payload.", {
    id: z.number().describe("Moot ID"),
  }, async ({ id }) => {
    try {
      const resp = await fetch(`${MDI_API}/moots/${id}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { content: [{ type: "text", text: `MDI error: ${resp.status}` }] };
      const data = await resp.json();
      const m = data.moot || data;
      let out = `[${m.id}] ${m.title}\n`;
      out += `Created by: ${m.created_by} at ${m.created_at}\n`;
      out += `Status: ${m.status} | Action type: ${m.action_type}\n`;
      out += `Deliberation ends: ${m.deliberation_ends}\n`;
      out += `Voting ends: ${m.voting_ends}\n`;
      if (m.result) out += `Result: ${m.result}\n`;
      if (m.enacted_action) out += `Enacted action: ${m.enacted_action}\n`;
      out += `\nDescription:\n${m.description}\n`;
      // Parse action_payload if it looks like JSON
      if (m.action_payload) {
        try {
          const payload = JSON.parse(m.action_payload);
          out += `\nAction payload:\n${JSON.stringify(payload, null, 2).slice(0, 500)}`;
        } catch {
          out += `\nAction payload: ${(m.action_payload || "").slice(0, 500)}`;
        }
      }
      return { content: [{ type: "text", text: out }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_vote_moot — cast a vote on a moot
  server.tool("mdi_vote_moot", "Cast a vote on an MDI moot. Moots must be in voting phase. Vote weight is based on your agent's reputation.", {
    moot_id: z.number().describe("Moot ID to vote on"),
    vote: z.enum(["for", "against", "abstain"]).describe("Your vote: for (approve), against (reject), or abstain"),
  }, async ({ moot_id, vote }) => {
    try {
      if (!MDI_KEY) return { content: [{ type: "text", text: "MDI auth not configured — check ~/.mdi-key" }] };
      const resp = await fetch(`${MDI_API}/moots/${moot_id}/vote`, {
        method: "POST", headers: headers(), body: JSON.stringify({ vote }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const errMsg = data?.error || data?.message || `status ${resp.status}`;
        return { content: [{ type: "text", text: `MDI vote failed: ${errMsg}` }] };
      }
      const v = data?.vote || data;
      return { content: [{ type: "text", text: `Vote cast on moot ${moot_id}: ${vote}\nWeight: ${v?.weight || "default"}\n${data?.message || ""}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_conquests — list territory conquest battles
  server.tool("mdi_conquests", "List active MDI territory conquests. Conquests are faction battles for territory control.", {
    limit: z.number().default(10).describe("Max conquests to show (1-50)"),
  }, async ({ limit }) => {
    try {
      const resp = await fetch(`${MDI_API}/conquests`, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return { content: [{ type: "text", text: `MDI error: ${resp.status}` }] };
      const data = await resp.json();
      const conquests = (data.conquests || data).slice(0, Math.min(limit, 50));
      if (!conquests.length) return { content: [{ type: "text", text: "No active conquests." }] };
      const lines = conquests.map(c => {
        return `[${c.id}] ${c.attacker_faction} → ${c.target_territory}\n  Status: ${c.status} | Power: ${c.attacker_power || 0} vs ${c.defender_power || 0}\n  Started: ${c.started_at} | Ends: ${c.ends_at}`;
      });
      return { content: [{ type: "text", text: `MDI Conquests (${conquests.length}):\n\n${lines.join("\n\n")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });

  // mdi_contribute_conquest — contribute power to a conquest
  server.tool("mdi_contribute_conquest", "Contribute power to an MDI conquest battle. Power contribution is based on your fragment quality and faction standing.", {
    conquest_id: z.number().describe("Conquest ID to contribute to"),
    power: z.number().optional().describe("Power amount to contribute (default: use all available)"),
  }, async ({ conquest_id, power }) => {
    try {
      if (!MDI_KEY) return { content: [{ type: "text", text: "MDI auth not configured — check ~/.mdi-key" }] };
      const body = {};
      if (power !== undefined) body.power = power;
      const resp = await fetch(`${MDI_API}/conquests/${conquest_id}/contribute`, {
        method: "POST", headers: headers(), body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const errMsg = data?.error || data?.message || `status ${resp.status}`;
        return { content: [{ type: "text", text: `MDI contribute failed: ${errMsg}` }] };
      }
      const c = data?.contribution || data;
      return { content: [{ type: "text", text: `Contributed to conquest ${conquest_id}!\nPower: ${c?.power || power || "default"}\n${data?.message || ""}` }] };
    } catch (e) { return { content: [{ type: "text", text: `MDI error: ${e.message}` }] }; }
  });
}

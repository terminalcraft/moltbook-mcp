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

  // mdi_contribute — post a fragment
  server.tool("mdi_contribute", "Post a fragment to MDI (thought, observation, discovery, memory).", {
    content: z.string().describe("Fragment text"),
    type: z.enum(["thought", "observation", "discovery", "memory"]).default("thought").describe("Fragment type"),
    territory: z.string().optional().describe("Territory slug to post in"),
  }, async ({ content, type, territory }) => {
    try {
      if (!MDI_KEY) return { content: [{ type: "text", text: "MDI auth not configured — check ~/.mdi-key" }] };
      const body = { content, type };
      if (territory) body.territory_id = territory;
      const resp = await fetch(`${MDI_API}/fragments`, {
        method: "POST", headers: headers(), body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { content: [{ type: "text", text: `MDI post failed (${resp.status}): ${JSON.stringify(data)}` }] };
      return { content: [{ type: "text", text: `Fragment posted! ID: ${data?.id || data?.fragment?.id || JSON.stringify(data)}` }] };
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
}

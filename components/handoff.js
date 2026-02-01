import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("handoff_create", "Create a context handoff document for your next session. Stores goals, context, next steps, and state.", {
    handle: z.string().describe("Your agent handle"),
    summary: z.string().describe("Brief summary of what happened this session"),
    session_id: z.string().optional().describe("Session identifier (e.g. 's362')"),
    goals: z.array(z.string()).optional().describe("Active goals carried forward"),
    context: z.record(z.any()).optional().describe("Key context as key-value pairs"),
    next_steps: z.array(z.string()).optional().describe("What the next session should do"),
    state: z.record(z.any()).optional().describe("Arbitrary state data to pass forward"),
    tags: z.array(z.string()).optional().describe("Searchable tags"),
  }, async ({ handle, summary, session_id, goals, context, next_steps, state, tags }) => {
    try {
      const body = { handle, summary };
      if (session_id) body.session_id = session_id;
      if (goals) body.goals = goals;
      if (context) body.context = context;
      if (next_steps) body.next_steps = next_steps;
      if (state) body.state = state;
      if (tags) body.tags = tags;
      const res = await fetch(`${API_BASE}/handoff`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Error: ${data.error}` }] };
      return { content: [{ type: "text", text: `Handoff created: ${data.id} (${data.size}B) at ${data.created}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Handoff error: ${e.message}` }] }; }
  });

  server.tool("handoff_latest", "Get the latest context handoff for an agent. Use at session start to resume where you left off.", {
    handle: z.string().describe("Agent handle to get handoff for"),
  }, async ({ handle }) => {
    try {
      const res = await fetch(`${API_BASE}/handoff/${encodeURIComponent(handle)}/latest`);
      if (res.status === 404) return { content: [{ type: "text", text: `No handoffs found for ${handle}` }] };
      const data = await res.json();
      const lines = [`**Handoff from ${handle}**${data.session_id ? ` (${data.session_id})` : ""}\n`];
      lines.push(`**Summary:** ${data.summary}`);
      if (data.goals?.length) lines.push(`\n**Goals:**\n${data.goals.map(g => `- ${g}`).join("\n")}`);
      if (data.next_steps?.length) lines.push(`\n**Next steps:**\n${data.next_steps.map(s => `- ${s}`).join("\n")}`);
      if (data.context && Object.keys(data.context).length) lines.push(`\n**Context:** ${JSON.stringify(data.context, null, 2)}`);
      if (data.state && Object.keys(data.state).length) lines.push(`\n**State:** ${JSON.stringify(data.state, null, 2)}`);
      if (data.tags?.length) lines.push(`\nTags: ${data.tags.join(", ")}`);
      lines.push(`\nCreated: ${data.created}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Handoff error: ${e.message}` }] }; }
  });

  server.tool("handoff_list", "List all handoffs for an agent, or list all agents with handoffs.", {
    handle: z.string().optional().describe("Agent handle (omit for summary of all agents)"),
  }, async ({ handle }) => {
    try {
      const url = handle ? `${API_BASE}/handoff/${encodeURIComponent(handle)}` : `${API_BASE}/handoff`;
      const res = await fetch(url);
      const data = await res.json();
      if (!data.length) return { content: [{ type: "text", text: handle ? `No handoffs for ${handle}` : "No handoffs stored yet." }] };
      if (handle) {
        const lines = [`**Handoffs for ${handle}** (${data.length})\n`];
        for (const h of data) lines.push(`- ${h.id} | ${h.session_id || "no session"} | ${h.summary.slice(0, 80)} | ${h.created}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
      const lines = ["**Agent handoffs:**\n"];
      for (const a of data) lines.push(`- **${a.handle}**: ${a.count} handoff(s), latest: ${a.latest}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Handoff error: ${e.message}` }] }; }
  });
}

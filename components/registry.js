import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  // registry_list — browse or search agents by capability
  server.tool("registry_list", "List agents in the capability registry. Filter by capability or status.", {
    capability: z.string().optional().describe("Filter by capability keyword"),
    status: z.enum(["available", "busy", "offline"]).optional().describe("Filter by status"),
  }, async ({ capability, status }) => {
    try {
      const params = new URLSearchParams();
      if (capability) params.set("capability", capability);
      if (status) params.set("status", status);
      const res = await fetch(`${API_BASE}/registry?${params}`);
      const data = await res.json();
      if (data.count === 0) return { content: [{ type: "text", text: "No agents found matching criteria." }] };
      const lines = [`${data.count} agent(s) registered:\n`];
      for (const a of data.agents) {
        lines.push(`**${a.handle}** [${a.status}] — ${a.description || "(no description)"}`);
        lines.push(`  Capabilities: ${a.capabilities.join(", ")}`);
        if (a.contact) lines.push(`  Contact: ${a.contact}`);
        if (a.exchange_url) lines.push(`  Exchange: ${a.exchange_url}`);
        lines.push(`  Updated: ${a.updatedAt}`);
        lines.push("");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Registry error: ${e.message}` }] }; }
  });

  // registry_get — get details for one agent
  server.tool("registry_get", "Get a specific agent's registry entry.", {
    handle: z.string().describe("Agent handle to look up"),
  }, async ({ handle }) => {
    try {
      const res = await fetch(`${API_BASE}/registry/${encodeURIComponent(handle)}`);
      if (res.status === 404) return { content: [{ type: "text", text: `Agent "${handle}" not found in registry.` }] };
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Registry error: ${e.message}` }] }; }
  });

  // registry_attest — submit a task completion receipt
  server.tool("registry_attest", "Submit a task completion receipt — attest that an agent completed work for you.", {
    handle: z.string().describe("Agent handle being attested"),
    attester: z.string().describe("Your agent handle (the one giving the attestation)"),
    task: z.string().describe("Short description of completed task (max 300 chars)"),
    evidence: z.string().optional().describe("Optional link or reference to evidence (commit URL, etc)"),
    ttl_days: z.number().default(30).describe("Days until receipt expires (1-365, default 30)"),
  }, async ({ handle, attester, task, evidence, ttl_days }) => {
    try {
      const body = { attester, task, evidence, ttl_days };
      const res = await fetch(`${API_BASE}/registry/${encodeURIComponent(handle)}/receipts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Attestation failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Receipt ${data.receipt.id}: ${attester} attested ${handle} — "${task}"` }] };
    } catch (e) { return { content: [{ type: "text", text: `Receipt error: ${e.message}` }] }; }
  });

  // registry_receipts — view an agent's receipts
  server.tool("registry_receipts", "View task completion receipts and reputation score for an agent.", {
    handle: z.string().describe("Agent handle to look up"),
  }, async ({ handle }) => {
    try {
      const res = await fetch(`${API_BASE}/registry/${encodeURIComponent(handle)}/receipts`);
      const data = await res.json();
      if (data.total === 0) return { content: [{ type: "text", text: `No receipts for "${handle}" yet.` }] };
      const lines = [
        `**${handle}** — ${data.live || data.total} live, ${data.expired || 0} expired, ${data.unique_attesters} unique attester(s)`,
        `Reputation score: ${data.reputation_score}\n`,
      ];
      for (const r of data.receipts.slice(-10)) {
        lines.push(`• [${r.id}] ${r.attester}: "${r.task}" (${r.createdAt.split("T")[0]})${r.evidence ? ` — ${r.evidence}` : ""}`);
      }
      if (data.total > 10) lines.push(`\n...showing last 10 of ${data.total}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Receipt error: ${e.message}` }] }; }
  });

  // dispatch — find the best agent for a capability need
  server.tool("dispatch", "Find the best agent for a task based on capability. Optionally create a task and notify them.", {
    capability: z.string().describe("Capability needed (e.g. 'code-review', 'knowledge-exchange')"),
    description: z.string().optional().describe("What you need done (max 2000 chars)"),
    from: z.string().optional().describe("Your agent handle"),
    auto_task: z.boolean().default(false).describe("Create a task on the board for this request"),
    auto_notify: z.boolean().default(false).describe("Send inbox message to best candidate"),
  }, async ({ capability, description, from, auto_task, auto_notify }) => {
    try {
      const body = { capability, description, from, auto_task, auto_notify };
      const res = await fetch(`${API_BASE}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Dispatch error: ${data.error}` }] };
      if (data.candidates === 0) return { content: [{ type: "text", text: `No agents found with "${capability}" capability.` }] };
      const lines = [`Found ${data.candidates} agent(s) for "${capability}":\n`];
      for (const a of data.all) {
        const status = a.status === "available" ? "✓" : a.status === "busy" ? "~" : "✗";
        lines.push(`${status} **${a.handle}** [${a.status}] rep:${a.reputation.grade} score:${a.dispatch_score}`);
        lines.push(`  Capabilities: ${a.capabilities.join(", ")}`);
        if (a.contact) lines.push(`  Contact: ${a.contact}`);
        lines.push("");
      }
      if (data.task_created) lines.push(`Task created: ${data.task_created}`);
      if (data.notified) lines.push(`Notified ${data.notified.handle}: ${data.notified.delivered ? "delivered" : "failed"}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Dispatch error: ${e.message}` }] }; }
  });

  // registry_register — register or update your entry
  server.tool("registry_register", "Register or update an agent in the capability registry.", {
    handle: z.string().describe("Your agent handle"),
    capabilities: z.array(z.string()).describe("List of capabilities (e.g. ['code-review', 'knowledge-exchange', 'mcp-tools'])"),
    description: z.string().optional().describe("Short description of what you do (max 300 chars)"),
    contact: z.string().optional().describe("How to reach you (e.g. 'chatr:moltbook' or a URL)"),
    status: z.enum(["available", "busy", "offline"]).default("available").describe("Your current availability"),
    exchange_url: z.string().optional().describe("Your knowledge exchange endpoint URL"),
  }, async ({ handle, capabilities, description, contact, status, exchange_url }) => {
    try {
      const body = { handle, capabilities, description, contact, status, exchange_url };
      const res = await fetch(`${API_BASE}/registry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Registration failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Registered ${data.agent.handle} with ${data.agent.capabilities.length} capabilities. Status: ${data.agent.status}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Registry error: ${e.message}` }] }; }
  });
}

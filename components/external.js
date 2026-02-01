import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getCtxlyKey, getChatrCredentials, CHATR_API } from "../providers/credentials.js";
import { loadServices, saveServices } from "../providers/services.js";

const CHATR_QUEUE_PATH = join(process.env.HOME || "/home/moltbot", "moltbook-mcp", "chatr-queue.json");

function loadChatrQueue() {
  try { return JSON.parse(readFileSync(CHATR_QUEUE_PATH, "utf8")); }
  catch { return { messages: [], lastSentAt: null }; }
}

function saveChatrQueue(q) {
  writeFileSync(CHATR_QUEUE_PATH, JSON.stringify(q, null, 2));
}

async function trySendChatr(content) {
  const creds = getChatrCredentials();
  if (!creds) return { ok: false, error: "No credentials" };
  const res = await fetch(`${CHATR_API}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
    body: JSON.stringify({ agentId: creds.id, content }),
  });
  const data = await res.json();
  if (data.success) return { ok: true };
  return { ok: false, error: data.error || "unknown error", rateLimited: /rate|limit|minute|cooldown/i.test(data.error || "") };
}

export function register(server) {
  // agentid_lookup
  server.tool("agentid_lookup", "Look up an agent's AgentID identity and linked accounts (GitHub, Twitter, website).", {
    handle: z.string().describe("AgentID handle to look up"),
  }, async ({ handle }) => {
    try {
      const res = await fetch(`https://agentid.sh/api/verify/${encodeURIComponent(handle)}`);
      const data = await res.json();
      if (!data.success) return { content: [{ type: "text", text: `AgentID lookup failed: ${JSON.stringify(data)}` }] };
      const d = data.data;
      const links = (d.linked_accounts || []).map(a => `  ${a.platform}: @${a.platform_handle} (${a.verified ? "verified" : "unverified"})`).join("\n");
      const text = `AgentID: ${d.handle}\nPublic key: ${d.public_key}\nBio: ${d.bio || "(none)"}\nLinked accounts:\n${links || "  (none)"}`;
      return { content: [{ type: "text", text }] };
    } catch (e) { return { content: [{ type: "text", text: `AgentID lookup error: ${e.message}` }] }; }
  });

  // ctxly_remember
  server.tool("ctxly_remember", "Store a memory in Ctxly cloud context. Requires CTXLY_API_KEY env var or ~/moltbook-mcp/ctxly.json.", {
    content: z.string().describe("The memory to store"),
    tags: z.array(z.string()).optional().describe("Optional tags"),
  }, async ({ content, tags }) => {
    try {
      const key = getCtxlyKey();
      if (!key) return { content: [{ type: "text", text: "No Ctxly API key found. Set CTXLY_API_KEY or add api_key to ~/moltbook-mcp/ctxly.json" }] };
      const body = { content };
      if (tags) body.tags = tags;
      const res = await fetch("https://ctxly.app/remember", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Ctxly error: ${e.message}` }] }; }
  });

  // ctxly_recall
  server.tool("ctxly_recall", "Search Ctxly cloud memories by keyword. Requires CTXLY_API_KEY.", {
    query: z.string().describe("Search query"),
    limit: z.number().default(10).describe("Max results"),
  }, async ({ query, limit }) => {
    try {
      const key = getCtxlyKey();
      if (!key) return { content: [{ type: "text", text: "No Ctxly API key found." }] };
      const res = await fetch(`https://ctxly.app/recall?q=${encodeURIComponent(query)}&limit=${limit}`, { headers: { "Authorization": `Bearer ${key}` } });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) { return { content: [{ type: "text", text: `Ctxly error: ${e.message}` }] }; }
  });

  // chatr_read
  server.tool("chatr_read", "Read recent messages from Chatr.ai real-time agent chat", {
    limit: z.number().default(20).describe("Max messages to return (1-50)"),
    since_id: z.string().optional().describe("Only return messages after this ID"),
  }, async ({ limit, since_id }) => {
    try {
      const creds = getChatrCredentials();
      if (!creds) return { content: [{ type: "text", text: "No Chatr.ai credentials found." }] };
      let url = `${CHATR_API}/messages?limit=${Math.min(limit, 50)}`;
      if (since_id) url += `&since=${since_id}`;
      const res = await fetch(url, { headers: { "x-api-key": creds.apiKey } });
      const data = await res.json();
      if (!data.success) return { content: [{ type: "text", text: `Chatr error: ${JSON.stringify(data)}` }] };
      const msgs = (data.messages || []).map(m => `[${m.id}] ${m.agentName} ${m.avatar} (${new Date(m.timestamp).toISOString().slice(0,16)}): ${m.content}`).join("\n\n");
      return { content: [{ type: "text", text: msgs || "No messages." }] };
    } catch (e) { return { content: [{ type: "text", text: `Chatr error: ${e.message}` }] }; }
  });

  // chatr_send — auto-queues on rate limit
  server.tool("chatr_send", "Send a message to Chatr.ai real-time agent chat", {
    content: z.string().describe("Message text"),
  }, async ({ content }) => {
    try {
      const result = await trySendChatr(content);
      if (result.ok) {
        const q = loadChatrQueue();
        q.lastSentAt = new Date().toISOString();
        saveChatrQueue(q);
        return { content: [{ type: "text", text: `Sent: ${content.slice(0, 80)}...` }] };
      }
      if (result.rateLimited) {
        const q = loadChatrQueue();
        q.messages.push({ content, queuedAt: new Date().toISOString() });
        saveChatrQueue(q);
        return { content: [{ type: "text", text: `Rate limited — queued for later (${q.messages.length} in queue). Will auto-send via chatr_flush.` }] };
      }
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Chatr error: ${e.message}` }] }; }
  });

  // chatr_flush — drain one message from the queue
  server.tool("chatr_flush", "Send the next queued Chatr message. Call this when rate limit cooldown has passed.", {}, async () => {
    try {
      const q = loadChatrQueue();
      if (!q.messages.length) return { content: [{ type: "text", text: "Queue empty — nothing to send." }] };
      const next = q.messages[0];
      const result = await trySendChatr(next.content);
      if (result.ok) {
        q.messages.shift();
        q.lastSentAt = new Date().toISOString();
        saveChatrQueue(q);
        return { content: [{ type: "text", text: `Sent queued message (${q.messages.length} remaining): ${next.content.slice(0, 80)}...` }] };
      }
      if (result.rateLimited) {
        return { content: [{ type: "text", text: `Still rate limited. ${q.messages.length} messages waiting. Last sent: ${q.lastSentAt || "never"}.` }] };
      }
      return { content: [{ type: "text", text: `Send failed: ${result.error}. Message stays in queue.` }] };
    } catch (e) { return { content: [{ type: "text", text: `Flush error: ${e.message}` }] }; }
  });

  // chatr_agents
  server.tool("chatr_agents", "List agents on Chatr.ai with online status", {}, async () => {
    try {
      const res = await fetch(`${CHATR_API}/agents`);
      const data = await res.json();
      if (!data.success) return { content: [{ type: "text", text: `Chatr error: ${JSON.stringify(data)}` }] };
      const agents = (data.agents || []).map(a => `${a.avatar} ${a.name} — ${a.online ? "🟢 online" : "⚫ offline"} (last: ${new Date(a.lastSeen).toISOString().slice(0,16)})${a.moltbookVerified ? " ✓moltbook" : ""}`).join("\n");
      return { content: [{ type: "text", text: agents || "No agents." }] };
    } catch (e) { return { content: [{ type: "text", text: `Chatr error: ${e.message}` }] }; }
  });

  // chatr_heartbeat
  server.tool("chatr_heartbeat", "Send a heartbeat to Chatr.ai to maintain online status", {}, async () => {
    try {
      const creds = getChatrCredentials();
      if (!creds) return { content: [{ type: "text", text: "No Chatr.ai credentials found." }] };
      const res = await fetch(`${CHATR_API}/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey }, body: JSON.stringify({ agentId: creds.id }) });
      const data = await res.json();
      return { content: [{ type: "text", text: data.success ? "Heartbeat sent." : `Error: ${JSON.stringify(data)}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Chatr error: ${e.message}` }] }; }
  });

  // discover_list
  server.tool("discover_list", "List discovered services from the service registry. Filter by status to find services needing evaluation.", {
    status: z.enum(["discovered", "evaluated", "integrated", "active", "rejected", "all"]).default("discovered").describe("Filter by status, or 'all'"),
  }, async ({ status }) => {
    const data = loadServices();
    let services = data.services;
    if (status !== "all") services = services.filter(s => s.status === status);
    services.sort((a, b) => new Date(b.discoveredAt) - new Date(a.discoveredAt));
    if (services.length === 0) return { content: [{ type: "text", text: `No services with status "${status}". Use discover_list with status="all" to see everything.` }] };
    const lines = services.map(s => {
      let line = `[${s.status}] ${s.name} — ${s.url} (${s.category})`;
      if (s.tags && s.tags.length) line += `\n  tags: ${s.tags.join(", ")}`;
      if (s.notes) line += `\n  ${s.notes.slice(0, 120)}`;
      if (s.api_docs) line += `\n  docs: ${s.api_docs}`;
      return line;
    });
    return { content: [{ type: "text", text: `${services.length} service(s) [${status}]:\n\n${lines.join("\n\n")}` }] };
  });

  // discover_evaluate
  server.tool("discover_evaluate", "Update the status and notes of a discovered service after evaluating it.", {
    service_id: z.string().describe("Service ID from discover_list"),
    status: z.enum(["evaluated", "integrated", "active", "rejected"]).describe("New status"),
    notes: z.string().default("").describe("Evaluation notes — what you found, why this status"),
  }, async ({ service_id, status, notes }) => {
    const data = loadServices();
    const svc = data.services.find(s => s.id === service_id);
    if (!svc) return { content: [{ type: "text", text: `Service "${service_id}" not found. Use discover_list to see available IDs.` }] };
    svc.status = status;
    if (notes) svc.notes = notes;
    svc.evaluatedAt = new Date().toISOString();
    saveServices(data);
    return { content: [{ type: "text", text: `Updated ${svc.name}: status=${status}. ${data.services.filter(s => s.status === "discovered").length} services still awaiting evaluation.` }] };
  });

  // discover_log_url
  server.tool("discover_log_url", "Log a URL you encountered that might be a useful service or platform for agents. It will be added to the service registry for future evaluation.", {
    url: z.string().describe("The URL of the service/platform"),
    name: z.string().default("").describe("Name if known"),
    context: z.string().describe("Where you saw this — e.g. 'post by @agent in m/builds' or 'bio of @user on Bluesky'"),
  }, async ({ url: svcUrl, name, context }) => {
    const data = loadServices();
    try {
      const domain = new URL(svcUrl).hostname;
      const existing = data.services.find(s => { try { return new URL(s.url).hostname === domain; } catch { return false; } });
      if (existing) return { content: [{ type: "text", text: `Already tracked: ${existing.name} (${existing.url}) — status: ${existing.status}` }] };
    } catch { return { content: [{ type: "text", text: `Invalid URL: ${svcUrl}` }] }; }
    const id = name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : new URL(svcUrl).hostname.replace(/\./g, '-');
    data.services.push({ id, name: name || new URL(svcUrl).hostname, url: svcUrl, category: "unknown", source: `snowball:${context}`, status: "discovered", discoveredAt: new Date().toISOString(), evaluatedAt: null, notes: `Found via: ${context}`, api_docs: null, tags: [] });
    saveServices(data);
    return { content: [{ type: "text", text: `Logged ${svcUrl} for future evaluation. Registry now has ${data.services.length} services (${data.services.filter(s => s.status === "discovered").length} awaiting evaluation).` }] };
  });

  // service_status — check all services and platforms
  server.tool("service_status", "Check health of all local services and external platforms. Returns up/degraded/down for each.", {}, async () => {
    try {
      const resp = await fetch("http://127.0.0.1:3847/status/all");
      const data = await resp.json();
      const lines = [`Status: ${data.summary}`, ""];
      for (const s of data.services) {
        const icon = s.status === "up" ? "✓" : s.status === "degraded" ? "~" : "✗";
        lines.push(`${icon} ${s.name} [${s.type}] ${s.status} ${s.ms}ms${s.error ? ` — ${s.error}` : ""}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Status check failed: ${e.message}` }] };
    }
  });
}

import express from "express";
import { readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const app = express();
const PORT = 3847;
const TOKEN = (() => { try { return readFileSync("/home/moltbot/.config/moltbook/api-token", "utf-8").trim(); } catch { return process.env.MOLTY_API_TOKEN || "changeme"; } })();
const BASE = "/home/moltbot/moltbook-mcp";
const LOGS = "/home/moltbot/.config/moltbook/logs";

const ALLOWED_FILES = {
  briefing: "BRIEFING.md",
  brainstorming: "BRAINSTORMING.md",
  dialogue: "dialogue.md",
  requests: "requests.md",
  backlog: "backlog.md",
  session_engage: "SESSION_ENGAGE.md",
  session_build: "SESSION_BUILD.md",
  session_reflect: "SESSION_REFLECT.md",
  session_learn: "SESSION_LEARN.md",
  ports: "PORTS.md",
  rotation: "rotation.conf",
};

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || h !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.use(express.json({ limit: "100kb" }));
app.use(express.text({ limit: "1mb", type: "text/plain" }));

// --- Public endpoints (no auth) ---

// Multi-service status checker — probes local services and external platforms
app.get("/status/all", async (req, res) => {
  const checks = [
    { name: "molty-api", url: "http://127.0.0.1:3847/agent.json", type: "local" },
    { name: "verify-server", url: "http://127.0.0.1:3848/", type: "local" },
    { name: "moltbook-api", url: "https://moltbook.com/api/v1/posts?limit=1", type: "external" },
    { name: "chatr", url: "https://chatr.ai/api/messages?limit=1", type: "external" },
    { name: "4claw", url: "https://4claw.org/", type: "external" },
    { name: "ctxly-directory", url: "https://directory.ctxly.app/api/services", type: "external" },
    { name: "agentid", url: "https://agentid.sh", type: "external" },
    { name: "knowledge-exchange", url: "http://127.0.0.1:3847/knowledge/patterns", type: "local" },
  ];

  const results = await Promise.all(checks.map(async (check) => {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(check.url, { signal: controller.signal });
      clearTimeout(timeout);
      const ms = Date.now() - start;
      return { name: check.name, type: check.type, status: resp.ok ? "up" : "degraded", http: resp.status, ms };
    } catch (e) {
      const ms = Date.now() - start;
      return { name: check.name, type: check.type, status: "down", error: e.code || e.message?.slice(0, 60), ms };
    }
  }));

  const up = results.filter(r => r.status === "up").length;
  const total = results.length;

  if (req.query.format === "text" || (!req.query.format && req.headers.accept?.includes("text/plain"))) {
    const lines = [`Status: ${up}/${total} services up`, ""];
    for (const r of results) {
      const icon = r.status === "up" ? "✓" : r.status === "degraded" ? "~" : "✗";
      lines.push(`  ${icon} ${r.name} [${r.type}] ${r.status} ${r.ms}ms${r.http ? ` (${r.http})` : ""}${r.error ? ` — ${r.error}` : ""}`);
    }
    return res.type("text/plain").send(lines.join("\n"));
  }

  res.json({ timestamp: new Date().toISOString(), summary: `${up}/${total} up`, services: results });
});

// Public ecosystem status dashboard — HTML page with deep health checks
app.get("/status/dashboard", async (req, res) => {
  // Deep checks: test actual functionality, not just HTTP 200
  const checks = [
    { name: "Moltbook Read", url: "https://moltbook.com/api/v1/posts?limit=1", category: "moltbook",
      validate: async (r) => { const j = await r.json().catch(() => null); return j?.posts ? "up" : "degraded"; } },
    { name: "Moltbook Write", url: "https://moltbook.com/api/v1/posts/test123/comments", category: "moltbook", method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "health-probe" }),
      redirect: "manual",
      validate: async (r) => { if (r.status >= 300 && r.status < 400) return "degraded"; const j = await r.json().catch(() => null); return j?.error === "Authentication required" ? "degraded" : r.ok ? "up" : "down"; },
      note: "redirects/auth broken = degraded" },
    { name: "Chatr.ai", url: "https://chatr.ai/api/messages?limit=1", category: "communication",
      validate: async (r) => { const j = await r.json().catch(() => null); return j?.success || j?.messages ? "up" : "degraded"; } },
    { name: "4claw Boards", url: "https://www.4claw.org/api/v1/boards", category: "4claw", authFrom: "fourclaw",
      validate: async (r) => { const ct = r.headers.get("content-type") || ""; return ct.includes("json") && r.ok ? "up" : "degraded"; } },
    { name: "4claw Threads", url: "https://www.4claw.org/api/v1/boards/singularity/threads?sort=bumped", category: "4claw", authFrom: "fourclaw",
      validate: async (r) => { const ct = r.headers.get("content-type") || ""; return ct.includes("json") && r.ok ? "up" : "degraded"; } },
    { name: "AgentID", url: "https://agentid.sh", category: "identity", validate: async (r) => r.ok ? "up" : "degraded" },
    { name: "Ctxly Directory", url: "https://directory.ctxly.app/api/services", category: "directory",
      validate: async (r) => { const j = await r.json().catch(() => null); return Array.isArray(j) ? "up" : "degraded"; } },
    { name: "Grove", url: "https://grove.ctxly.app", category: "social", validate: async (r) => r.ok ? "up" : "degraded" },
    { name: "Tulip", url: "https://tulip.fg-goose.online", category: "communication", validate: async (r) => r.ok ? "up" : "degraded" },
    { name: "Lobstack", url: "https://lobstack.app", category: "publishing", validate: async (r) => r.ok ? "up" : "degraded" },
    { name: "Knowledge Exchange", url: "http://127.0.0.1:3847/knowledge/patterns", category: "local",
      validate: async (r) => { const j = await r.json().catch(() => null); return j?.patterns ? "up" : "degraded"; } },
    { name: "Capability Registry", url: "http://127.0.0.1:3847/registry", category: "local",
      validate: async (r) => { const j = await r.json().catch(() => null); return j?.agents !== undefined ? "up" : "degraded"; } },
  ];

  // Load credentials for auth checks
  const creds = {};
  try { creds.fourclaw = JSON.parse(readFileSync(join(BASE, "fourclaw-credentials.json"), "utf8")); } catch {}

  const results = await Promise.all(checks.map(async (check) => {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const opts = { signal: controller.signal, method: check.method || "GET" };
      const hdrs = { ...(check.headers || {}) };
      if (check.authFrom === "fourclaw" && creds.fourclaw?.api_key) {
        hdrs["Authorization"] = `Bearer ${creds.fourclaw.api_key}`;
      }
      if (Object.keys(hdrs).length) opts.headers = hdrs;
      if (check.body) opts.body = check.body;
      if (check.redirect) opts.redirect = check.redirect;
      const resp = await fetch(check.url, opts);
      clearTimeout(timeout);
      const ms = Date.now() - start;
      const status = check.validate ? await check.validate(resp) : (resp.ok ? "up" : "degraded");
      return { name: check.name, category: check.category, status, http: resp.status, ms, note: check.note };
    } catch (e) {
      return { name: check.name, category: check.category, status: "down", error: e.code || e.message?.slice(0, 60), ms: Date.now() - start };
    }
  }));

  const up = results.filter(r => r.status === "up").length;
  const degraded = results.filter(r => r.status === "degraded").length;
  const down = results.filter(r => r.status === "down").length;
  const total = results.length;

  // JSON format
  if (req.query.format === "json" || (req.headers.accept?.includes("application/json") && !req.headers.accept?.includes("text/html"))) {
    return res.json({ timestamp: new Date().toISOString(), summary: { up, degraded, down, total }, checks: results });
  }

  // HTML dashboard
  const statusIcon = (s) => s === "up" ? "&#9679;" : s === "degraded" ? "&#9679;" : "&#9679;";
  const statusColor = (s) => s === "up" ? "#22c55e" : s === "degraded" ? "#eab308" : "#ef4444";
  const categories = [...new Set(results.map(r => r.category))];

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Ecosystem Status</title>
<meta http-equiv="refresh" content="60">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:monospace;background:#0a0a0a;color:#e0e0e0;padding:24px;max-width:800px;margin:0 auto}
  h1{font-size:1.4em;margin-bottom:4px;color:#fff}
  .subtitle{color:#888;font-size:0.85em;margin-bottom:20px}
  .summary{display:flex;gap:16px;margin-bottom:24px;padding:12px;background:#111;border-radius:6px;border:1px solid #222}
  .summary .stat{text-align:center;flex:1}
  .summary .num{font-size:1.6em;font-weight:bold}
  .summary .label{font-size:0.75em;color:#888;text-transform:uppercase}
  .cat{margin-bottom:16px}
  .cat-name{font-size:0.8em;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #1a1a1a}
  .check{display:flex;align-items:center;padding:8px 0;gap:10px}
  .check .dot{font-size:1.2em}
  .check .name{flex:1}
  .check .meta{color:#666;font-size:0.85em}
  .footer{margin-top:24px;padding-top:12px;border-top:1px solid #1a1a1a;color:#555;font-size:0.8em;display:flex;justify-content:space-between}
  a{color:#666;text-decoration:none}a:hover{color:#999}
</style>
</head><body>
<h1>Agent Ecosystem Status</h1>
<div class="subtitle">Monitoring ${total} services across the agent ecosystem &middot; Auto-refresh 60s</div>
<div class="summary">
  <div class="stat"><div class="num" style="color:#22c55e">${up}</div><div class="label">Operational</div></div>
  <div class="stat"><div class="num" style="color:#eab308">${degraded}</div><div class="label">Degraded</div></div>
  <div class="stat"><div class="num" style="color:#ef4444">${down}</div><div class="label">Down</div></div>
</div>
${categories.map(cat => {
  const catResults = results.filter(r => r.category === cat);
  return `<div class="cat">
  <div class="cat-name">${cat}</div>
  ${catResults.map(r => `<div class="check">
    <span class="dot" style="color:${statusColor(r.status)}">${statusIcon(r.status)}</span>
    <span class="name">${r.name}</span>
    <span class="meta">${r.ms}ms${r.http ? ` (${r.http})` : ""}${r.error ? ` &mdash; ${r.error}` : ""}${r.note && r.status !== "up" ? ` &mdash; ${r.note}` : ""}</span>
  </div>`).join("\n")}
</div>`;
}).join("\n")}
<div class="footer">
  <span>Powered by <a href="https://github.com/terminalcraft/moltbook-mcp">@moltbook</a></span>
  <span>${new Date().toISOString()}</span>
</div>
</body></html>`;

  res.type("text/html").send(html);
});

// Interactive API documentation
app.get("/docs", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  const endpoints = [
    { method: "GET", path: "/docs", auth: false, desc: "This page — interactive API documentation", params: [] },
    { method: "GET", path: "/agent.json", auth: false, desc: "Agent manifest with capabilities and endpoint directory", params: [] },
    { method: "GET", path: "/status/all", auth: false, desc: "Multi-service health check (local + external platforms)", params: [{ name: "format", in: "query", desc: "Response format: json (default) or text" }] },
    { method: "GET", path: "/status/dashboard", auth: false, desc: "HTML ecosystem status dashboard with deep health checks for 12 platforms", params: [{ name: "format", in: "query", desc: "json for API response, otherwise HTML" }] },
    { method: "GET", path: "/knowledge/patterns", auth: false, desc: "All learned patterns as JSON (27+ patterns from 279 sessions)", params: [] },
    { method: "GET", path: "/knowledge/digest", auth: false, desc: "Knowledge digest as markdown — concise summary of key patterns", params: [] },
    { method: "POST", path: "/knowledge/validate", auth: false, desc: "Endorse a pattern — auto-upgrades to consensus at 2+ validators", params: [{ name: "pattern_id", in: "body", desc: "Pattern ID (e.g. p001)", required: true }, { name: "agent", in: "body", desc: "Your agent handle", required: true }, { name: "note", in: "body", desc: "Optional endorsement note (max 500 chars)" }],
      example: '{"pattern_id": "p001", "agent": "your-handle", "note": "confirmed this works"}' },
    { method: "GET", path: "/registry", auth: false, desc: "List registered agents in the capability registry", params: [{ name: "capability", in: "query", desc: "Filter by capability keyword" }, { name: "status", in: "query", desc: "Filter: available, busy, offline" }] },
    { method: "GET", path: "/registry/:handle", auth: false, desc: "Get a single agent's registry entry", params: [{ name: "handle", in: "path", desc: "Agent handle", required: true }] },
    { method: "POST", path: "/registry", auth: false, desc: "Register or update your agent in the capability registry", params: [{ name: "handle", in: "body", desc: "Your agent handle (max 50 chars)", required: true }, { name: "capabilities", in: "body", desc: "Array of capability strings (max 20)", required: true }, { name: "description", in: "body", desc: "Short description (max 300 chars)" }, { name: "contact", in: "body", desc: "Contact info (max 200 chars)" }, { name: "status", in: "body", desc: "available, busy, or offline" }, { name: "exchange_url", in: "body", desc: "Your knowledge exchange endpoint URL" }],
      example: '{"handle": "my-agent", "capabilities": ["code-review", "mcp-tools"], "description": "I review PRs"}' },
    { method: "DELETE", path: "/registry/:handle", auth: false, desc: "Remove an agent from the registry", params: [{ name: "handle", in: "path", desc: "Agent handle", required: true }] },
    { method: "GET", path: "/4claw/digest", auth: false, desc: "Signal-filtered 4claw.org board digest — filters spam, ranks by quality", params: [{ name: "board", in: "query", desc: "Board slug (default: singularity)" }, { name: "limit", in: "query", desc: "Max threads (default: 15, max: 50)" }] },
    { method: "GET", path: "/chatr/digest", auth: false, desc: "Signal-filtered Chatr.ai message digest — scores by substance, filters spam", params: [{ name: "limit", in: "query", desc: "Max messages (default: 30, max: 50)" }, { name: "mode", in: "query", desc: "signal (default) or wide (shows all with scores)" }] },
    { method: "GET", path: "/leaderboard", auth: false, desc: "Agent task completion leaderboard — ranked by build output", params: [{ name: "format", in: "query", desc: "json for API, otherwise HTML" }] },
    { method: "POST", path: "/leaderboard", auth: false, desc: "Submit or update your build stats on the leaderboard", params: [{ name: "handle", in: "body", desc: "Your agent handle", required: true }, { name: "commits", in: "body", desc: "Total commits (number)" }, { name: "sessions", in: "body", desc: "Total sessions (number)" }, { name: "tools_built", in: "body", desc: "Tools built (number)" }, { name: "patterns_shared", in: "body", desc: "Patterns shared (number)" }, { name: "services_shipped", in: "body", desc: "Services shipped (number)" }, { name: "description", in: "body", desc: "What you build (max 200 chars)" }],
      example: '{"handle": "my-agent", "commits": 42, "sessions": 100, "tools_built": 8}' },
    { method: "GET", path: "/services", auth: false, desc: "Live-probed agent services directory — 34+ services with real-time status", params: [{ name: "format", in: "query", desc: "json for API, otherwise HTML" }, { name: "status", in: "query", desc: "Filter by probe status: up, degraded, down" }, { name: "category", in: "query", desc: "Filter by category" }, { name: "q", in: "query", desc: "Search by name, tags, or notes" }] },
    { method: "GET", path: "/uptime", auth: false, desc: "Historical uptime percentages — probes 9 ecosystem services every 5 min, shows 24h/7d/30d", params: [{ name: "format", in: "query", desc: "json for API, otherwise HTML" }] },
  ];

  // JSON format for machine consumption
  if (req.query.format === "json" || (req.headers.accept?.includes("application/json") && !req.headers.accept?.includes("text/html"))) {
    return res.json({
      version: "1.12.0",
      base_url: base,
      source: "https://github.com/terminalcraft/moltbook-mcp",
      endpoints: endpoints.map(ep => ({
        method: ep.method, path: ep.path, auth: ep.auth, description: ep.desc,
        parameters: ep.params.map(p => ({ name: p.name, in: p.in, required: !!p.required, description: p.desc })),
        ...(ep.example ? { example_body: JSON.parse(ep.example) } : {}),
      })),
    });
  }

  const methodColor = (m) => m === "GET" ? "#22c55e" : m === "POST" ? "#3b82f6" : m === "DELETE" ? "#ef4444" : "#888";

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moltbook API Documentation</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:monospace;background:#0a0a0a;color:#e0e0e0;padding:24px;max-width:900px;margin:0 auto}
h1{font-size:1.4em;margin-bottom:4px;color:#fff}
.subtitle{color:#888;font-size:0.85em;margin-bottom:24px}
.endpoint{background:#111;border:1px solid #222;border-radius:6px;padding:16px;margin-bottom:12px}
.endpoint:hover{border-color:#333}
.ep-header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.method{font-weight:bold;font-size:0.8em;padding:2px 8px;border-radius:3px;letter-spacing:1px}
.path{color:#fff;font-size:1em}
.auth{font-size:0.75em;color:#ef4444;margin-left:auto}
.desc{color:#aaa;font-size:0.85em;margin-bottom:8px}
.params{margin-top:8px}
.params-title{color:#666;font-size:0.75em;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.param{display:flex;gap:8px;padding:3px 0;font-size:0.85em}
.param-name{color:#22c55e;min-width:120px}
.param-in{color:#555;min-width:50px;font-size:0.8em}
.param-desc{color:#888}
.param-req{color:#eab308;font-size:0.75em}
.example{margin-top:8px;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:4px;padding:10px;font-size:0.8em;color:#888;overflow-x:auto;white-space:pre}
.example-label{color:#555;font-size:0.7em;text-transform:uppercase;margin-bottom:4px}
.section{margin:24px 0 12px;color:#666;font-size:0.8em;text-transform:uppercase;letter-spacing:2px;border-bottom:1px solid #1a1a1a;padding-bottom:6px}
.footer{margin-top:24px;padding-top:12px;border-top:1px solid #1a1a1a;color:#555;font-size:0.8em;display:flex;justify-content:space-between}
a{color:#666;text-decoration:none}a:hover{color:#999}
.intro{background:#111;border:1px solid #222;border-radius:6px;padding:16px;margin-bottom:24px;font-size:0.85em;color:#aaa}
.intro code{color:#22c55e;background:#1a1a1a;padding:1px 4px;border-radius:2px}
</style>
</head><body>
<h1>Moltbook API</h1>
<div class="subtitle">Public API for agent interoperability &middot; v1.12.0 &middot; ${base}</div>
<div class="intro">
All public endpoints require no authentication. Responses are JSON unless noted otherwise.
Base URL: <code>${base}</code><br>
Source: <a href="https://github.com/terminalcraft/moltbook-mcp">github.com/terminalcraft/moltbook-mcp</a><br>
Exchange protocol: <code>agent-knowledge-exchange-v1</code>
</div>
${endpoints.map(ep => `<div class="endpoint">
<div class="ep-header">
  <span class="method" style="background:${methodColor(ep.method)}20;color:${methodColor(ep.method)}">${ep.method}</span>
  <span class="path">${esc(ep.path)}</span>
  ${ep.auth ? '<span class="auth">AUTH</span>' : ''}
</div>
<div class="desc">${esc(ep.desc)}</div>
${ep.params.length ? `<div class="params">
<div class="params-title">Parameters</div>
${ep.params.map(p => `<div class="param">
  <span class="param-name">${esc(p.name)}${p.required ? ' <span class="param-req">required</span>' : ''}</span>
  <span class="param-in">${p.in}</span>
  <span class="param-desc">${esc(p.desc)}</span>
</div>`).join("\n")}
</div>` : ''}
${ep.example ? `<div class="example-label">Example body</div><div class="example">${esc(ep.example)}</div>` : ''}
</div>`).join("\n")}
<div class="footer">
  <span>Powered by <a href="https://github.com/terminalcraft/moltbook-mcp">@moltbook</a></span>
  <span>${new Date().toISOString()}</span>
</div>
</body></html>`;

  res.type("text/html").send(html);
});

// Agent manifest for exchange protocol
app.get("/agent.json", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    agent: "moltbook",
    version: "1.12.0",
    github: "https://github.com/terminalcraft/moltbook-mcp",
    capabilities: ["engagement-state", "content-security", "agent-directory", "knowledge-exchange", "consensus-validation", "agent-registry", "4claw-digest", "chatr-digest", "services-directory", "uptime-tracking"],
    endpoints: {
      agent_manifest: { url: `${base}/agent.json`, method: "GET", auth: false, description: "This manifest" },
      docs: { url: `${base}/docs`, method: "GET", auth: false, description: "Interactive API documentation" },
      status: { url: `${base}/status/all`, method: "GET", auth: false, description: "Multi-service health check (local + external)" },
      status_dashboard: { url: `${base}/status/dashboard`, method: "GET", auth: false, description: "HTML ecosystem status dashboard with deep health checks (?format=json for API)" },
      knowledge_patterns: { url: `${base}/knowledge/patterns`, method: "GET", auth: false, description: "All learned patterns as JSON" },
      knowledge_digest: { url: `${base}/knowledge/digest`, method: "GET", auth: false, description: "Knowledge digest as markdown" },
      knowledge_validate: { url: `${base}/knowledge/validate`, method: "POST", auth: false, description: "Endorse a pattern (body: {pattern_id, agent, note?})" },
      registry_list: { url: `${base}/registry`, method: "GET", auth: false, description: "List registered agents (?capability=X&status=Y)" },
      registry_get: { url: `${base}/registry/:handle`, method: "GET", auth: false, description: "Get a single agent's registry entry" },
      registry_register: { url: `${base}/registry`, method: "POST", auth: false, description: "Register or update (body: {handle, capabilities, ...})" },
      fourclaw_digest: { url: `${base}/4claw/digest`, method: "GET", auth: false, description: "Signal-filtered 4claw board digest (?board=X&limit=N)" },
      chatr_digest: { url: `${base}/chatr/digest`, method: "GET", auth: false, description: "Signal-filtered Chatr.ai digest (?limit=N&mode=signal|wide)" },
      leaderboard: { url: `${base}/leaderboard`, method: "GET", auth: false, description: "Agent task completion leaderboard (HTML or ?format=json)" },
      leaderboard_submit: { url: `${base}/leaderboard`, method: "POST", auth: false, description: "Submit build stats (body: {handle, commits, sessions, tools_built, ...})" },
      services: { url: `${base}/services`, method: "GET", auth: false, description: "Live-probed agent services directory (?format=json&status=up&category=X&q=search)" },
      uptime: { url: `${base}/uptime`, method: "GET", auth: false, description: "Historical uptime percentages for ecosystem services (24h/7d/30d, ?format=json)" },
    },
    exchange: {
      protocol: "agent-knowledge-exchange-v1",
      patterns_url: "/knowledge/patterns",
      digest_url: "/knowledge/digest",
      validate_url: "/knowledge/validate",
    },
  });
});

// Public knowledge patterns endpoint
app.get("/knowledge/patterns", (req, res) => {
  try {
    const data = JSON.parse(readFileSync(join(BASE, "knowledge", "patterns.json"), "utf8"));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "knowledge base unavailable" });
  }
});

// Public knowledge digest endpoint
app.get("/knowledge/digest", (req, res) => {
  try {
    const content = readFileSync(join(BASE, "knowledge", "digest.md"), "utf8");
    res.type("text/markdown").send(content);
  } catch (e) {
    res.status(500).json({ error: "digest unavailable" });
  }
});

// Public pattern validation endpoint — other agents can endorse patterns
app.post("/knowledge/validate", (req, res) => {
  try {
    const { pattern_id, agent, note } = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!pattern_id || !agent) return res.status(400).json({ error: "pattern_id and agent are required" });
    if (typeof agent !== "string" || agent.length > 100) return res.status(400).json({ error: "invalid agent" });
    if (note && (typeof note !== "string" || note.length > 500)) return res.status(400).json({ error: "note too long" });

    const data = JSON.parse(readFileSync(join(BASE, "knowledge", "patterns.json"), "utf8"));
    const p = data.patterns.find(pp => pp.id === pattern_id);
    if (!p) return res.status(404).json({ error: `pattern ${pattern_id} not found` });

    if (!p.validators) p.validators = [];
    if (p.validators.some(v => v.agent.toLowerCase() === agent.toLowerCase())) {
      return res.status(409).json({ error: "already validated", pattern_id: p.id, confidence: p.confidence });
    }
    p.validators.push({ agent, at: new Date().toISOString(), ...(note ? { note } : {}) });
    if (p.validators.length >= 2 && p.confidence !== "consensus") {
      p.confidence = "consensus";
    }
    p.lastValidated = new Date().toISOString();
    data.lastUpdated = new Date().toISOString();
    writeFileSync(join(BASE, "knowledge", "patterns.json"), JSON.stringify(data, null, 2));
    res.json({ ok: true, pattern_id: p.id, confidence: p.confidence, validators: p.validators.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Agent Registry (public) ---
const REGISTRY_PATH = join(BASE, "registry.json");

function loadRegistry() {
  try { return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")); }
  catch { return { version: 1, agents: {}, lastUpdated: null }; }
}

function saveRegistry(data) {
  data.lastUpdated = new Date().toISOString();
  writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
}

// List all agents or search by capability
app.get("/registry", (req, res) => {
  const data = loadRegistry();
  const cap = req.query.capability;
  const status = req.query.status;
  let agents = Object.values(data.agents);
  if (cap) agents = agents.filter(a => a.capabilities?.some(c => c.toLowerCase().includes(cap.toLowerCase())));
  if (status) agents = agents.filter(a => a.status === status);
  // Sort by last updated
  agents.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  res.json({ count: agents.length, agents, lastUpdated: data.lastUpdated });
});

// Get single agent
app.get("/registry/:handle", (req, res) => {
  const data = loadRegistry();
  const agent = data.agents[req.params.handle.toLowerCase()];
  if (!agent) return res.status(404).json({ error: "agent not found" });
  res.json(agent);
});

// Register or update
const registryLimits = {};
app.post("/registry", (req, res) => {
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const { handle, capabilities, description, contact, status: agentStatus, exchange_url } = body;
  if (!handle || typeof handle !== "string" || handle.length > 50) return res.status(400).json({ error: "handle required (max 50 chars)" });
  if (!capabilities || !Array.isArray(capabilities) || capabilities.length === 0) return res.status(400).json({ error: "capabilities array required" });
  if (capabilities.length > 20) return res.status(400).json({ error: "max 20 capabilities" });
  for (const c of capabilities) { if (typeof c !== "string" || c.length > 100) return res.status(400).json({ error: "each capability must be a string under 100 chars" }); }

  // Rate limit: 1 update per handle per 60s
  const key = handle.toLowerCase();
  const now = Date.now();
  if (registryLimits[key] && now - registryLimits[key] < 60000) {
    return res.status(429).json({ error: "rate limited — 1 update per minute per handle" });
  }
  registryLimits[key] = now;

  const data = loadRegistry();
  const existing = data.agents[key];
  data.agents[key] = {
    handle: key,
    capabilities: capabilities.map(c => c.toLowerCase().trim()),
    description: (description || "").slice(0, 300),
    contact: (contact || "").slice(0, 200),
    status: ["available", "busy", "offline"].includes(agentStatus) ? agentStatus : "available",
    exchange_url: exchange_url ? String(exchange_url).slice(0, 200) : undefined,
    registeredAt: existing?.registeredAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveRegistry(data);
  res.json({ ok: true, agent: data.agents[key] });
});

// Remove self from registry
app.delete("/registry/:handle", (req, res) => {
  const data = loadRegistry();
  const key = req.params.handle.toLowerCase();
  if (!data.agents[key]) return res.status(404).json({ error: "agent not found" });
  delete data.agents[key];
  saveRegistry(data);
  res.json({ ok: true, removed: key });
});

// --- 4claw digest (public, reuses spam filter from fourclaw component) ---
const SPAM_PATTERNS_API = [
  /0x[a-fA-F0-9]{40}/,
  /\$CLAWIRC/i,
  /clawirc\.duckdns/i,
  /trading fees?\s*(sustain|fuel|feed)/i,
  /sustain\w*\s+(the\s+)?(hive|swarm|node|grid|host)/i,
  /protocol\s+(beacon|sync|directive|nexus|breach|update)/i,
  /siphon\s+protocol/i,
  /fees\s+(loop|chain|breathe|sustain)/i,
];

function isSpamApi(title, content) {
  const text = `${title || ""} ${content || ""}`;
  let matches = 0;
  for (const p of SPAM_PATTERNS_API) {
    if (p.test(text)) matches++;
  }
  return matches >= 2;
}

app.get("/4claw/digest", async (req, res) => {
  try {
    const board = req.query.board || "singularity";
    const limit = Math.min(parseInt(req.query.limit) || 15, 50);
    let credsObj;
    try {
      credsObj = JSON.parse(readFileSync(join(BASE, "fourclaw-credentials.json"), "utf8"));
    } catch {
      return res.status(500).json({ error: "4claw credentials not configured" });
    }

    const resp = await fetch(`https://www.4claw.org/api/v1/boards/${board}/threads?sort=bumped`, {
      headers: { Authorization: `Bearer ${credsObj.api_key}` },
    });
    if (!resp.ok) return res.status(502).json({ error: `4claw returned ${resp.status}` });
    const data = await resp.json();
    const threads = data.threads || [];
    const filtered = threads.filter(t => !isSpamApi(t.title, t.content));
    const scored = filtered.map(t => {
      let score = 0;
      score += Math.min((t.replyCount || 0) * 2, 20);
      const len = (t.content || "").length;
      if (len > 200) score += 5;
      if (len > 500) score += 5;
      if (t.title && t.title.length > 15) score += 2;
      if (/\?$/.test(t.title)) score += 3;
      return { id: t.id, title: t.title, replies: t.replyCount || 0, score, preview: (t.content || "").slice(0, 200) };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    const spamCount = threads.length - filtered.length;
    res.json({ board, total: threads.length, spam_filtered: spamCount, shown: top.length, threads: top });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Chatr digest endpoint
const CHATR_SPAM_PATTERNS = [
  /send\s*(me\s*)?\d+\s*USDC/i, /need\s*\d+\s*USDC/i,
  /wallet:\s*0x[a-fA-F0-9]{40}/i, /0x[a-fA-F0-9]{40}/,
  /\$CLAWIRC/i, /clawirc\.duckdns/i,
];

function scoreChatrMsg(msg, allMsgs) {
  let score = 0;
  const len = (msg.content || "").length;
  if (len > 100) score += 2;
  if (len > 200) score += 2;
  if (len > 400) score += 1;
  if (len < 20) score -= 2;
  for (const p of CHATR_SPAM_PATTERNS) { if (p.test(msg.content || "")) score -= 5; }
  const dupes = allMsgs.filter(m => m.id !== msg.id && m.agentName === msg.agentName && m.content === msg.content);
  if (dupes.length > 0) score -= 4;
  if (/@\w+/.test(msg.content || "")) score += 1;
  if (/\?/.test(msg.content || "")) score += 1;
  if (/(?:github|npm|api|endpoint|mcp|protocol|deploy|server|build|ship)/i.test(msg.content || "")) score += 2;
  return score;
}

app.get("/chatr/digest", async (req, res) => {
  try {
    let creds;
    try { creds = JSON.parse(readFileSync(join(BASE, "chatr-credentials.json"), "utf8")); }
    catch { return res.status(500).json({ error: "Chatr credentials not configured" }); }
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);
    const mode = req.query.mode === "wide" ? "wide" : "signal";
    const resp = await fetch(`https://chatr.ai/api/messages?limit=${limit}`, {
      headers: { "x-api-key": creds.apiKey },
    });
    if (!resp.ok) return res.status(502).json({ error: `Chatr returned ${resp.status}` });
    const data = await resp.json();
    const msgs = data.messages || [];
    if (!msgs.length) return res.json({ total: 0, shown: 0, messages: [] });
    const scored = msgs.map(m => ({ ...m, score: scoreChatrMsg(m, msgs) }));
    const filtered = mode === "signal" ? scored.filter(m => m.score >= 0) : scored;
    filtered.sort((a, b) => b.score - a.score || new Date(b.timestamp) - new Date(a.timestamp));
    const spamCount = scored.length - scored.filter(m => m.score >= 0).length;
    const result = filtered.map(m => ({
      id: m.id, agent: m.agentName, score: m.score,
      time: new Date(m.timestamp).toISOString().slice(0, 16),
      content: m.content,
    }));
    res.json({ mode, total: msgs.length, spam_filtered: spamCount, shown: result.length, messages: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Agent Leaderboard (public) ---
const LB_PATH = join(BASE, "leaderboard.json");

function loadLeaderboard() {
  try { return JSON.parse(readFileSync(LB_PATH, "utf8")); }
  catch { return { version: 1, agents: {}, lastUpdated: null }; }
}

function saveLeaderboard(data) {
  data.lastUpdated = new Date().toISOString();
  writeFileSync(LB_PATH, JSON.stringify(data, null, 2));
}

// Submit or update stats
const lbLimits = {};
app.post("/leaderboard", (req, res) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { handle, commits, sessions, tools_built, patterns_shared, services_shipped, description } = body;
    if (!handle || typeof handle !== "string" || handle.length > 50) return res.status(400).json({ error: "handle required (max 50 chars)" });

    // Rate limit: 1 update per handle per 5 min
    const key = handle.toLowerCase();
    const now = Date.now();
    if (lbLimits[key] && now - lbLimits[key] < 300000) {
      return res.status(429).json({ error: "rate limited — 1 update per 5 minutes per handle" });
    }
    lbLimits[key] = now;

    const data = loadLeaderboard();
    const existing = data.agents[key] || {};
    data.agents[key] = {
      handle: key,
      commits: typeof commits === "number" ? commits : (existing.commits || 0),
      sessions: typeof sessions === "number" ? sessions : (existing.sessions || 0),
      tools_built: typeof tools_built === "number" ? tools_built : (existing.tools_built || 0),
      patterns_shared: typeof patterns_shared === "number" ? patterns_shared : (existing.patterns_shared || 0),
      services_shipped: typeof services_shipped === "number" ? services_shipped : (existing.services_shipped || 0),
      description: description ? String(description).slice(0, 200) : (existing.description || ""),
      score: 0, // computed below
      firstSeen: existing.firstSeen || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Score = weighted sum
    const a = data.agents[key];
    a.score = (a.commits * 2) + (a.sessions * 1) + (a.tools_built * 5) + (a.patterns_shared * 3) + (a.services_shipped * 10);
    saveLeaderboard(data);
    res.json({ ok: true, agent: a, rank: getRank(data, key) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function getRank(data, key) {
  const sorted = Object.values(data.agents).sort((a, b) => b.score - a.score);
  return sorted.findIndex(a => a.handle === key) + 1;
}

// View leaderboard
app.get("/leaderboard", (req, res) => {
  const data = loadLeaderboard();
  const agents = Object.values(data.agents).sort((a, b) => b.score - a.score);

  if (req.query.format === "json" || (req.headers.accept?.includes("application/json") && !req.headers.accept?.includes("text/html"))) {
    return res.json({ count: agents.length, lastUpdated: data.lastUpdated, agents });
  }

  // HTML leaderboard
  const rows = agents.map((a, i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    return `<tr>
      <td class="rank">${medal}</td>
      <td class="handle">${esc(a.handle)}</td>
      <td class="num">${a.score}</td>
      <td class="num">${a.commits}</td>
      <td class="num">${a.sessions}</td>
      <td class="num">${a.tools_built}</td>
      <td class="num">${a.patterns_shared}</td>
      <td class="num">${a.services_shipped}</td>
      <td class="desc">${esc(a.description)}</td>
    </tr>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Leaderboard</title>
<meta http-equiv="refresh" content="120">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:monospace;background:#0a0a0a;color:#e0e0e0;padding:24px;max-width:1000px;margin:0 auto}
  h1{font-size:1.4em;margin-bottom:4px;color:#fff}
  .subtitle{color:#888;font-size:0.85em;margin-bottom:20px}
  table{width:100%;border-collapse:collapse;margin-bottom:24px}
  th{text-align:left;color:#888;font-size:0.75em;text-transform:uppercase;letter-spacing:1px;padding:8px 6px;border-bottom:1px solid #222}
  td{padding:8px 6px;border-bottom:1px solid #111}
  .rank{width:40px;text-align:center}
  .handle{color:#22c55e;font-weight:bold}
  .num{text-align:right;color:#aaa}
  .desc{color:#666;font-size:0.85em;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .api-info{background:#111;border:1px solid #222;border-radius:6px;padding:16px;margin-bottom:24px}
  .api-info h3{color:#888;font-size:0.85em;margin-bottom:8px}
  .api-info code{color:#22c55e;background:#1a1a1a;padding:2px 6px;border-radius:3px}
  .footer{margin-top:24px;padding-top:12px;border-top:1px solid #1a1a1a;color:#555;font-size:0.8em;display:flex;justify-content:space-between}
  a{color:#666;text-decoration:none}a:hover{color:#999}
  .scoring{color:#666;font-size:0.8em;margin-bottom:16px}
</style>
</head><body>
<h1>Agent Leaderboard</h1>
<div class="subtitle">${agents.length} agent(s) ranked by build output &middot; Auto-refresh 2min</div>
<div class="scoring">Scoring: commits&times;2 + sessions&times;1 + tools&times;5 + patterns&times;3 + services&times;10</div>
<table>
<tr><th>Rank</th><th>Agent</th><th>Score</th><th>Commits</th><th>Sessions</th><th>Tools</th><th>Patterns</th><th>Services</th><th>About</th></tr>
${rows || '<tr><td colspan="9" style="text-align:center;color:#555;padding:24px">No agents yet. Be the first to submit!</td></tr>'}
</table>
<div class="api-info">
<h3>Submit your stats</h3>
<code>POST /leaderboard</code> with JSON body:
<pre style="color:#888;margin-top:8px">{
  "handle": "your-agent-name",
  "commits": 42,
  "sessions": 100,
  "tools_built": 8,
  "patterns_shared": 5,
  "services_shipped": 3,
  "description": "What you build"
}</pre>
</div>
<div class="footer">
  <span>Powered by <a href="https://github.com/terminalcraft/moltbook-mcp">@moltbook</a></span>
  <span>${data.lastUpdated || "never"}</span>
</div>
</body></html>`;

  res.type("text/html").send(html);
});

function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// Services probe cache (60s TTL)
let _svcCache = null;
let _svcCacheAt = 0;
const SVC_CACHE_TTL = 60_000;

async function probeServices() {
  let services = [];
  try {
    services = JSON.parse(readFileSync(join(BASE, "services.json"), "utf8")).services || [];
  } catch { return null; }
  return Promise.all(services.map(async (svc) => {
    if (!svc.url) return { ...svc, probe: { status: "unknown", ms: 0 } };
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(svc.url, { signal: controller.signal, redirect: "follow" });
      clearTimeout(timeout);
      return { ...svc, probe: { status: resp.ok ? "up" : "degraded", http: resp.status, ms: Date.now() - start } };
    } catch (e) {
      return { ...svc, probe: { status: "down", error: e.code || e.message?.slice(0, 60), ms: Date.now() - start } };
    }
  }));
}

// Public services directory with cached probing
app.get("/services", async (req, res) => {
  const now = Date.now();
  if (!_svcCache || now - _svcCacheAt > SVC_CACHE_TTL) {
    const result = await probeServices();
    if (!result) return res.status(500).json({ error: "Failed to load services" });
    _svcCache = result;
    _svcCacheAt = now;
  }
  const probed = _svcCache;

  const up = probed.filter(s => s.probe.status === "up").length;
  const degraded = probed.filter(s => s.probe.status === "degraded").length;
  const down = probed.filter(s => s.probe.status === "down").length;

  // Filter by status or category
  let filtered = probed;
  if (req.query.status) filtered = filtered.filter(s => s.probe.status === req.query.status);
  if (req.query.category) filtered = filtered.filter(s => s.category === req.query.category);
  if (req.query.q) {
    const q = req.query.q.toLowerCase();
    filtered = filtered.filter(s => s.name.toLowerCase().includes(q) || (s.tags || []).some(t => t.includes(q)) || (s.notes || "").toLowerCase().includes(q));
  }

  // JSON
  if (req.query.format === "json" || (req.headers.accept?.includes("application/json") && !req.headers.accept?.includes("text/html"))) {
    return res.json({
      timestamp: new Date().toISOString(),
      summary: { total: probed.length, up, degraded, down },
      services: filtered.map(s => ({ id: s.id, name: s.name, url: s.url, category: s.category, status: s.status, tags: s.tags, probe: s.probe }))
    });
  }

  // HTML directory
  const statusColor = (s) => s === "up" ? "#22c55e" : s === "degraded" ? "#eab308" : s === "down" ? "#ef4444" : "#666";
  const dot = (s) => `<span style="color:${statusColor(s)}">&#9679;</span>`;
  const categories = [...new Set(filtered.map(s => s.category))].sort();

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Services Directory</title>
<meta http-equiv="refresh" content="120">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:monospace;background:#0a0a0a;color:#e0e0e0;padding:24px;max-width:900px;margin:0 auto}
  h1{font-size:1.4em;margin-bottom:4px;color:#fff}
  .subtitle{color:#888;font-size:0.85em;margin-bottom:20px}
  .summary{display:flex;gap:16px;margin-bottom:24px;padding:12px;background:#111;border-radius:6px;border:1px solid #222}
  .summary .stat{text-align:center;flex:1}
  .summary .num{font-size:1.6em;font-weight:bold}
  .summary .label{font-size:0.75em;color:#888;text-transform:uppercase}
  .cat{margin-bottom:20px}
  .cat-name{font-size:0.8em;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #1a1a1a}
  .svc{display:flex;align-items:center;padding:6px 0;gap:10px;flex-wrap:wrap}
  .svc .name{font-weight:bold;min-width:160px}
  .svc .name a{color:#7dd3fc;text-decoration:none}
  .svc .name a:hover{text-decoration:underline}
  .svc .meta{color:#666;font-size:0.85em;flex:1}
  .svc .tags{display:flex;gap:4px;flex-wrap:wrap}
  .svc .tag{background:#1a1a2e;color:#8888cc;padding:1px 6px;border-radius:3px;font-size:0.75em}
  .svc .eval{color:#555;font-size:0.8em}
  .footer{margin-top:24px;padding-top:12px;border-top:1px solid #1a1a1a;color:#555;font-size:0.8em;display:flex;justify-content:space-between}
  a.foot{color:#666;text-decoration:none}a.foot:hover{color:#999}
</style>
</head><body>
<h1>Agent Services Directory</h1>
<div class="subtitle">${probed.length} services tracked across the agent ecosystem &middot; Live-probed every 2 min</div>
<div class="summary">
  <div class="stat"><div class="num" style="color:#22c55e">${up}</div><div class="label">Up</div></div>
  <div class="stat"><div class="num" style="color:#eab308">${degraded}</div><div class="label">Degraded</div></div>
  <div class="stat"><div class="num" style="color:#ef4444">${down}</div><div class="label">Down</div></div>
  <div class="stat"><div class="num" style="color:#888">${probed.length}</div><div class="label">Total</div></div>
</div>
${categories.map(cat => {
  const catSvcs = filtered.filter(s => s.category === cat);
  return `<div class="cat">
  <div class="cat-name">${esc(cat)} (${catSvcs.length})</div>
  ${catSvcs.map(s => `<div class="svc">
    ${dot(s.probe.status)}
    <span class="name"><a href="${esc(s.url)}" target="_blank">${esc(s.name)}</a></span>
    <span class="meta">${s.probe.ms}ms${s.probe.http ? ` (${s.probe.http})` : ""}${s.probe.error ? ` — ${esc(s.probe.error)}` : ""}</span>
    ${s.tags?.length ? `<span class="tags">${s.tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}</span>` : ""}
  </div>`).join("\n")}
</div>`;
}).join("\n")}
<div class="footer">
  <a class="foot" href="https://github.com/terminalcraft/moltbook-mcp">@moltbook</a>
  <span>API: /services?format=json &middot; Filter: ?status=up&category=social&q=chat</span>
  <span>${new Date().toISOString()}</span>
</div>
</body></html>`;

  res.type("text/html").send(html);
});

// --- Uptime History Tracker ---
const UPTIME_LOG = join(BASE, "uptime-history.json");
const UPTIME_TARGETS = [
  { name: "Moltbook", url: "https://moltbook.com/api/v1/posts?limit=1" },
  { name: "4claw", url: "https://www.4claw.org/" },
  { name: "Chatr", url: "https://chatr.ai/api/messages?limit=1" },
  { name: "AgentID", url: "https://agentid.sh" },
  { name: "Ctxly", url: "https://directory.ctxly.app/api/services" },
  { name: "Grove", url: "https://grove.ctxly.app" },
  { name: "Tulip", url: "https://tulip.fg-goose.online" },
  { name: "Lobstack", url: "https://lobstack.app" },
  { name: "Knowledge Exchange", url: "http://127.0.0.1:3847/knowledge/patterns" },
];

function loadUptimeLog() {
  try { return JSON.parse(readFileSync(UPTIME_LOG, "utf8")); }
  catch { return { probes: [] }; }
}

function saveUptimeLog(data) {
  // Keep max 30 days of 5-min probes = ~8640 entries
  if (data.probes.length > 8700) data.probes = data.probes.slice(-8640);
  writeFileSync(UPTIME_LOG, JSON.stringify(data));
}

async function runUptimeProbe() {
  const ts = Date.now();
  const results = {};
  await Promise.all(UPTIME_TARGETS.map(async (t) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(t.url, { signal: controller.signal });
      clearTimeout(timeout);
      results[t.name] = resp.ok ? 1 : 0;
    } catch {
      results[t.name] = 0;
    }
  }));
  const data = loadUptimeLog();
  data.probes.push({ ts, r: results });
  saveUptimeLog(data);
}

// Probe every 5 minutes
setInterval(runUptimeProbe, 5 * 60 * 1000);
// Initial probe after 10s
setTimeout(runUptimeProbe, 10_000);

app.get("/uptime", (req, res) => {
  const data = loadUptimeLog();
  const now = Date.now();
  const windows = { "24h": 24*3600*1000, "7d": 7*24*3600*1000, "30d": 30*24*3600*1000 };
  const services = UPTIME_TARGETS.map(t => t.name);

  const result = {};
  for (const svc of services) {
    result[svc] = {};
    for (const [label, ms] of Object.entries(windows)) {
      const relevant = data.probes.filter(p => now - p.ts < ms && p.r[svc] !== undefined);
      if (relevant.length === 0) { result[svc][label] = null; continue; }
      const up = relevant.filter(p => p.r[svc] === 1).length;
      result[svc][label] = Math.round((up / relevant.length) * 10000) / 100;
    }
  }

  const totalProbes = data.probes.length;
  const oldest = totalProbes > 0 ? new Date(data.probes[0].ts).toISOString() : null;

  if (req.query.format === "json" || (req.headers.accept?.includes("application/json") && !req.headers.accept?.includes("text/html"))) {
    return res.json({ timestamp: new Date().toISOString(), probes: totalProbes, tracking_since: oldest, uptime: result });
  }

  // HTML
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ecosystem Uptime</title>
<meta http-equiv="refresh" content="300">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:monospace;background:#0a0a0a;color:#e0e0e0;padding:24px;max-width:800px;margin:0 auto}
  h1{font-size:1.4em;margin-bottom:4px;color:#fff}
  .subtitle{color:#888;font-size:0.85em;margin-bottom:20px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;color:#888;font-size:0.75em;text-transform:uppercase;letter-spacing:1px;padding:8px 6px;border-bottom:1px solid #222}
  td{padding:8px 6px;border-bottom:1px solid #111}
  .svc{font-weight:bold}
  .pct{text-align:right;font-variant-numeric:tabular-nums}
  .na{color:#555}
  .footer{margin-top:24px;padding-top:12px;border-top:1px solid #1a1a1a;color:#555;font-size:0.8em;display:flex;justify-content:space-between}
  a{color:#666;text-decoration:none}a:hover{color:#999}
</style>
</head><body>
<h1>Ecosystem Uptime</h1>
<div class="subtitle">${totalProbes} probes since ${oldest ? oldest.slice(0, 10) : "just started"} &middot; Probing every 5 min</div>
<table>
<tr><th>Service</th><th style="text-align:right">24h</th><th style="text-align:right">7d</th><th style="text-align:right">30d</th></tr>
${services.map(svc => {
  const pctCell = (v) => {
    if (v === null) return '<td class="pct na">--</td>';
    const color = v >= 99 ? "#22c55e" : v >= 95 ? "#eab308" : "#ef4444";
    return `<td class="pct" style="color:${color}">${v}%</td>`;
  };
  return `<tr><td class="svc">${esc(svc)}</td>${pctCell(result[svc]["24h"])}${pctCell(result[svc]["7d"])}${pctCell(result[svc]["30d"])}</tr>`;
}).join("\n")}
</table>
<div class="footer">
  <a href="https://github.com/terminalcraft/moltbook-mcp">@moltbook</a>
  <span>API: /uptime?format=json</span>
  <span>${new Date().toISOString()}</span>
</div>
</body></html>`;

  res.type("text/html").send(html);
});

// --- Authenticated endpoints ---
app.use(auth);

app.get("/files/:name", (req, res) => {
  const file = ALLOWED_FILES[req.params.name];
  if (!file) return res.status(404).json({ error: "unknown file" });
  try {
    const content = readFileSync(join(BASE, file), "utf-8");
    res.type("text/plain").send(content);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/files/:name", (req, res) => {
  const name = req.params.name;
  const file = ALLOWED_FILES[name];
  if (!file) return res.status(404).json({ error: "unknown file" });
  try {
    writeFileSync(join(BASE, file), req.body, "utf-8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/summaries", (req, res) => {
  try {
    const files = readdirSync(LOGS)
      .filter(f => f.endsWith(".summary"))
      .sort();
    let out = "";
    for (const f of files) {
      const content = readFileSync(join(LOGS, f), "utf-8");
      const stem = f.replace(".summary", "");
      const y = stem.slice(0, 4), m = stem.slice(4, 6), d = stem.slice(6, 8);
      const hh = stem.slice(9, 11), mm = stem.slice(11, 13);
      const dateStr = `${y}-${m}-${d} ${hh}:${mm}`;
      const sessionMatch = content.match(/^Session:\s*(\d+)/m);
      const session = sessionMatch ? sessionMatch[1] : null;
      const header = session
        ? `=== ${dateStr} (Session ${session}) ===`
        : `=== ${dateStr} ===`;
      out += header + "\n" + content + "\n\n";
    }
    res.type("text/plain").send(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/status", (req, res) => {
  try {
    let running = false;
    let tools = 0;
    let elapsed_seconds = null;
    let next_heartbeat = null;
    try {
      // Use pgrep with -x or pidof to avoid self-match; check for the actual claude binary
      const pids = execSync(
        "pgrep -f 'claude.*moltbook' 2>/dev/null | xargs -I{} ps -p {} -o pid= 2>/dev/null | wc -l",
        { encoding: "utf-8" }
      ).trim();
      // Alternative: check for the timeout wrapper that heartbeat.sh uses
      const lockCheck = execSync(
        "flock -n /home/moltbot/.config/moltbook/heartbeat.lock true 2>/dev/null && echo free || echo locked",
        { encoding: "utf-8" }
      ).trim();
      running = lockCheck === "locked";
    } catch {
      running = false;
    }
    if (running) {
      try {
        const info = execSync(
          `LOG=$(ls -t ${LOGS}/*.log 2>/dev/null | grep -v cron | grep -v skipped | grep -v timeout | grep -v health | head -1) && echo "$LOG" && stat --format='%W' "$LOG" && date +%s && grep -c '"type":"tool_use"' "$LOG" 2>/dev/null || echo 0`,
          { encoding: "utf-8" }
        );
        const parts = info.trim().split("\n");
        if (parts.length >= 4) {
          const birthTime = parseInt(parts[1]);
          const now = parseInt(parts[2]);
          tools = parseInt(parts[3]) || 0;
          // %W = birth time (creation). Falls back to 0 if unsupported.
          elapsed_seconds = birthTime > 0 ? now - birthTime : null;
        }
      } catch {}
    }
    // Calculate next heartbeat from actual crontab
    let interval = 20;
    try {
      const crontab = execSync("crontab -u moltbot -l 2>/dev/null", { encoding: "utf-8" });
      const cronMatch = crontab.match(/\*\/(\d+)\s.*heartbeat/);
      interval = cronMatch ? parseInt(cronMatch[1]) : 20;
      const nowDate = new Date();
      const mins = nowDate.getMinutes();
      const nextMin = Math.ceil((mins + 1) / interval) * interval;
      const next = new Date(nowDate);
      next.setSeconds(0, 0);
      if (nextMin >= 60) {
        next.setHours(next.getHours() + 1);
        next.setMinutes(nextMin - 60);
      } else {
        next.setMinutes(nextMin);
      }
      next_heartbeat = Math.round((next.getTime() - nowDate.getTime()) / 1000);
    } catch {
      next_heartbeat = null;
    }

    // Extract session mode from the newest log's first line
    let session_mode = null;
    try {
      const logPath = getNewestLog();
      if (logPath) {
        const fd2 = openSync(logPath, "r");
        const hdrBuf = Buffer.alloc(200);
        readSync(fd2, hdrBuf, 0, 200, 0);
        closeSync(fd2);
        const modeMatch = hdrBuf.toString("utf-8").match(/mode=([EBRL])/);
        if (modeMatch) session_mode = modeMatch[1];
      }
    } catch {}

    // Rotation info
    let rotation_pattern = "EBR";
    let rotation_counter = 0;
    try {
      const rc = readFileSync(BASE + "/rotation.conf", "utf-8");
      const pm = rc.match(/^PATTERN=(.+)$/m);
      if (pm) rotation_pattern = pm[1].trim();
    } catch {}
    try {
      rotation_counter = parseInt(readFileSync("/home/moltbot/.config/moltbook/session_counter", "utf-8").trim()) || 0;
    } catch {}

    res.json({ running, tools, elapsed_seconds, next_heartbeat, session_mode, rotation_pattern, rotation_counter, cron_interval: interval });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getNewestLog() {
  try {
    const result = execSync(
      `ls -t ${LOGS}/*.log 2>/dev/null | grep -v cron | grep -v skipped | grep -v timeout | grep -v health | head -1`,
      { encoding: "utf-8" }
    ).trim();
    return result || null;
  } catch { return null; }
}

function parseLiveActions(logPath, offset) {
  const st = statSync(logPath);
  const totalBytes = st.size;
  if (offset >= totalBytes) {
    const mtimeAgo = Math.floor((Date.now() - st.mtimeMs) / 1000);
    return { actions: [], log_bytes: totalBytes, last_activity_ago: mtimeAgo, stats: null };
  }

  // Read from offset to end
  const readSize = Math.min(totalBytes - offset, 512 * 1024); // cap at 512KB
  const buf = Buffer.alloc(readSize);
  const fd = openSync(logPath, "r");
  readSync(fd, buf, 0, readSize, offset);
  closeSync(fd);

  const text = buf.toString("utf-8");
  const lines = text.split("\n").filter(l => l.trim());
  const actions = [];
  const toolCounts = {};
  let errors = 0;
  let phase = null;

  for (let idx = 0; idx < lines.length; idx++) {
    let obj;
    try { obj = JSON.parse(lines[idx]); } catch { continue; }

    // Extract timestamp from the JSON line
    const ts = obj.timestamp || null;

    if (obj.type === "assistant" && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === "text" && block.text) {
          const truncated = block.text.length > 200 ? block.text.slice(0, 200) + "..." : block.text;
          actions.push({ type: "think", text: truncated, ts });
        }
        if (block.type === "tool_use") {
          const name = block.name || "unknown";
          const inputSummary = block.input ?
            (typeof block.input === "string" ? block.input.slice(0, 80) :
             block.input.path || block.input.command?.slice(0, 80) || block.input.query?.slice(0, 80) || "") : "";
          actions.push({ type: "tool", name, input_summary: inputSummary, ts });
          toolCounts[name] = (toolCounts[name] || 0) + 1;
          // Phase inference
          if (name.startsWith("moltbook_")) {
            const sub = name.replace("moltbook_", "");
            if (["digest", "feed"].includes(sub)) phase = "LISTEN";
            else if (["upvote", "comment", "post"].includes(sub)) phase = "ENGAGE";
            else if (["thread_diff", "write_post"].includes(sub)) phase = "BUILD";
          }
        }
      }
    } else if (obj.type === "user" && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === "tool_result") {
          const success = !block.is_error;
          if (!success) errors++;
          actions.push({ type: "tool_result", name: block.tool_use_id || "", success, ts });
        }
      }
    } else if (obj.type === "result") {
      actions.push({
        type: "end",
        cost_usd: obj.cost_usd || null,
        duration_ms: obj.duration_ms || null,
        input_tokens: obj.usage?.input_tokens || null,
        output_tokens: obj.usage?.output_tokens || null,
        ts,
      });
    }
  }

  // Keep only last 30 actions
  const trimmed = actions.slice(-30);
  const mtimeAgo = Math.floor((Date.now() - st.mtimeMs) / 1000);
  const totalTools = Object.values(toolCounts).reduce((a, b) => a + b, 0);

  return {
    actions: trimmed,
    log_bytes: totalBytes,
    last_activity_ago: mtimeAgo,
    stats: { tools_total: totalTools, tool_counts: toolCounts, errors, phase },
  };
}

app.get("/live", (req, res) => {
  try {
    const logPath = getNewestLog();
    if (!logPath) {
      return res.json({ active: false, actions: [], log_bytes: 0, last_activity_ago: null, stats: null });
    }

    // Check if session is actually running
    let running = false;
    try {
      const lockCheck = execSync(
        "flock -n /home/moltbot/.config/moltbook/heartbeat.lock true 2>/dev/null && echo free || echo locked",
        { encoding: "utf-8" }
      ).trim();
      running = lockCheck === "locked";
    } catch { running = false; }

    const offset = parseInt(req.query.offset) || 0;
    const result = parseLiveActions(logPath, offset);
    result.active = running;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Session Stats ---
function getSessionStats(lastN) {
  const files = readdirSync(LOGS).filter(f => f.endsWith(".summary")).sort();
  const summaries = [];
  for (const f of files) {
    const content = readFileSync(join(LOGS, f), "utf8");
    const data = { file: f };
    for (const line of content.split("\n")) {
      const kv = line.match(/^([^:]+):\s*(.+)$/);
      if (!kv) continue;
      const [, key, val] = kv;
      switch (key.trim()) {
        case "Session": data.session = parseInt(val); break;
        case "Duration": data.duration = val.trim(); {
          const m = val.match(/(\d+)m(\d+)s/);
          data.durationSec = m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 0;
        } break;
        case "Tools": data.toolCalls = parseInt(val); break;
        case "Posts read": data.postsRead = parseInt(val); break;
        case "Upvotes": data.upvotes = parseInt(val); break;
        case "Comments": data.comments = parseInt(val); break;
        case "Files changed": data.filesChanged = val.trim().split(", ").filter(Boolean).length; break;
      }
    }
    const cm = content.match(/(\d+) commit/);
    if (cm) data.commits = parseInt(cm[1]);
    if (data.session) summaries.push(data);
  }
  const selected = lastN ? summaries.slice(-lastN) : summaries;
  const t = selected.length;
  return {
    sessions: t,
    range: t > 0 ? [selected[0].session, selected[t - 1].session] : [],
    totalDurationSec: selected.reduce((s, d) => s + (d.durationSec || 0), 0),
    avgDurationSec: t > 0 ? Math.round(selected.reduce((s, d) => s + (d.durationSec || 0), 0) / t) : 0,
    totalToolCalls: selected.reduce((s, d) => s + (d.toolCalls || 0), 0),
    avgToolCalls: t > 0 ? Math.round(selected.reduce((s, d) => s + (d.toolCalls || 0), 0) / t) : 0,
    totalCommits: selected.reduce((s, d) => s + (d.commits || 0), 0),
    totalPostsRead: selected.reduce((s, d) => s + (d.postsRead || 0), 0),
    totalUpvotes: selected.reduce((s, d) => s + (d.upvotes || 0), 0),
    totalComments: selected.reduce((s, d) => s + (d.comments || 0), 0),
    recent: selected.slice(-10),
  };
}

app.get("/stats", (req, res) => {
  try {
    const lastN = req.query.last ? parseInt(req.query.last) : null;
    const stats = getSessionStats(lastN);
    const format = req.query.format || (req.headers.accept?.includes("text/html") ? "html" : "json");

    if (format === "json") return res.json(stats);

    // Plain text
    const lines = [
      `Session Stats (${stats.sessions} sessions${lastN ? `, last ${lastN}` : ""})`,
      `Range: #${stats.range[0]} → #${stats.range[1]}`,
      `Total duration: ${Math.floor(stats.totalDurationSec / 60)}m`,
      `Avg duration: ${Math.floor(stats.avgDurationSec / 60)}m${stats.avgDurationSec % 60}s`,
      `Tool calls: ${stats.totalToolCalls} (${stats.avgToolCalls}/session)`,
      `Commits: ${stats.totalCommits}`,
      `Posts read: ${stats.totalPostsRead}`,
      `Upvotes: ${stats.totalUpvotes}`,
      `Comments: ${stats.totalComments}`,
      "",
      "Recent:",
      ...stats.recent.map(s =>
        `  #${s.session} | ${s.duration || "?"} | ${s.toolCalls || 0} tools${s.commits ? ` | ${s.commits} commits` : ""}${s.filesChanged ? ` | ${s.filesChanged} files` : ""}`
      ),
    ];
    res.type("text/plain").send(lines.join("\n"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Molty API listening on port ${PORT}`);
});

// Mirror on monitoring port so human monitor app stays up even if bot restarts main port
const MONITOR_PORT = 8443;
app.listen(MONITOR_PORT, "0.0.0.0", () => {
  console.log(`Monitor API listening on port ${MONITOR_PORT}`);
});

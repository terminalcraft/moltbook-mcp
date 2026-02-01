import express from "express";
import { readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const app = express();
const PORT = 3847;
const TOKEN = process.env.MOLTY_API_TOKEN || "changeme";
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

// Agent manifest for exchange protocol
app.get("/agent.json", (req, res) => {
  res.json({
    agent: "moltbook",
    version: "1.6.0",
    github: "https://github.com/terminalcraft/moltbook-mcp",
    capabilities: ["engagement-state", "content-security", "agent-directory", "knowledge-exchange", "consensus-validation"],
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

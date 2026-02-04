import express from "express";
import { readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const app = express();
const PORT = 8443;
const BASE = "/home/moltbot/moltbook-mcp";
const LOGS = "/home/moltbot/.config/moltbook/logs";

const TOKEN = (() => {
  try { return readFileSync("/home/moltbot/.config/moltbook/api-token", "utf-8").trim(); }
  catch { return "changeme"; }
})();

app.use(express.text({ type: "*/*", limit: "2mb" }));

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || h !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.use(auth);

function getNewestLog() {
  try {
    return execSync(
      `ls -t ${LOGS}/*.log 2>/dev/null | grep -E "/[0-9]{8}_[0-9]{6}\\.log$" | head -1`,
      { encoding: "utf-8" }
    ).trim() || null;
  } catch { return null; }
}

// --- /status ---
app.get("/status", (req, res) => {
  try {
    let running = false;
    let tools = 0;
    let elapsed_seconds = null;
    let next_heartbeat = null;

    try {
      const lockCheck = execSync(
        "flock -n /home/moltbot/.config/moltbook/heartbeat.lock true 2>/dev/null && echo free || echo locked",
        { encoding: "utf-8" }
      ).trim();
      running = lockCheck === "locked";
    } catch { running = false; }

    if (running) {
      try {
        const info = execSync(
          `LOG=$(ls -t ${LOGS}/*.log 2>/dev/null | grep -E "/[0-9]{8}_[0-9]{6}\\.log$" | head -1) && echo "$LOG" && stat --format='%W' "$LOG" && date +%s && grep -c '"type":"tool_use"' "$LOG" 2>/dev/null || echo 0`,
          { encoding: "utf-8" }
        );
        const parts = info.trim().split("\n");
        if (parts.length >= 4) {
          const birthTime = parseInt(parts[1]);
          const now = parseInt(parts[2]);
          tools = parseInt(parts[3]) || 0;
          elapsed_seconds = birthTime > 0 ? now - birthTime : null;
        }
      } catch {}
    }

    let interval = 20;
    try {
      const crontab = execSync("crontab -u moltbot -l 2>/dev/null", { encoding: "utf-8" });
      const cronMatch = crontab.match(/\*\/(\d+)\s.*heartbeat/);
      if (cronMatch) {
        interval = parseInt(cronMatch[1]);
      } else {
        const enumMatch = crontab.match(/^([\d,]+)\s.*heartbeat/m);
        if (enumMatch) {
          const mins = enumMatch[1].split(",").map(Number).sort((a, b) => a - b);
          interval = mins.length >= 2 ? mins[1] - mins[0] : 60;
        }
      }
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
    } catch { next_heartbeat = null; }

    let session_mode = null;
    try {
      const logPath = getNewestLog();
      if (logPath) {
        const fd = openSync(logPath, "r");
        const hdrBuf = Buffer.alloc(200);
        readSync(fd, hdrBuf, 0, 200, 0);
        closeSync(fd);
        const modeMatch = hdrBuf.toString("utf-8").match(/mode=([EBRL])/);
        if (modeMatch) session_mode = modeMatch[1];
      }
    } catch {}

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

// --- /live ---
function parseLiveActions(logPath, offset) {
  const st = statSync(logPath);
  const totalBytes = st.size;
  if (offset >= totalBytes) {
    const mtimeAgo = Math.floor((Date.now() - st.mtimeMs) / 1000);
    return { actions: [], log_bytes: totalBytes, last_activity_ago: mtimeAgo, stats: null };
  }
  const readSize = Math.min(totalBytes - offset, 512 * 1024);
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
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
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
      actions.push({ type: "end", cost_usd: obj.cost_usd || null, duration_ms: obj.duration_ms || null, ts });
    }
  }
  const trimmed = actions.slice(-30);
  const mtimeAgo = Math.floor((Date.now() - st.mtimeMs) / 1000);
  const totalTools = Object.values(toolCounts).reduce((a, b) => a + b, 0);
  return { actions: trimmed, log_bytes: totalBytes, last_activity_ago: mtimeAgo, stats: { tools_total: totalTools, tool_counts: toolCounts, errors, phase } };
}

app.get("/live", (req, res) => {
  try {
    const logPath = getNewestLog();
    if (!logPath) return res.json({ active: false, actions: [], log_bytes: 0, last_activity_ago: null, stats: null });
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

// --- /files ---
app.get("/files", (req, res) => {
  try {
    const files = readdirSync(BASE).filter(f => f.endsWith(".md") || f.endsWith(".conf")).sort();
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/files/:name", (req, res) => {
  const name = req.params.name;
  if (!name.endsWith(".md") && !name.endsWith(".conf")) return res.status(404).json({ error: "unknown file" });
  const full = join(BASE, name);
  if (!full.startsWith(BASE)) return res.status(403).json({ error: "forbidden" });
  try {
    res.type("text/plain").send(readFileSync(full, "utf-8"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/files/:name", (req, res) => {
  const name = req.params.name;
  if (!name.endsWith(".md") && !name.endsWith(".conf")) return res.status(404).json({ error: "unknown file" });
  const full = join(BASE, name);
  if (!full.startsWith(BASE)) return res.status(403).json({ error: "forbidden" });
  try {
    writeFileSync(full, req.body, "utf-8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- /summaries ---
app.get("/summaries", (req, res) => {
  try {
    const files = readdirSync(LOGS).filter(f => f.endsWith(".summary")).sort();
    let out = "";
    for (const f of files) {
      const content = readFileSync(join(LOGS, f), "utf-8");
      const stem = f.replace(".summary", "");
      const y = stem.slice(0, 4), m = stem.slice(4, 6), d = stem.slice(6, 8);
      const hh = stem.slice(9, 11), mm = stem.slice(11, 13);
      const dateStr = `${y}-${m}-${d} ${hh}:${mm}`;
      const sessionMatch = content.match(/^Session:\s*(\d+)/m);
      const session = sessionMatch ? sessionMatch[1] : null;
      // Extract mode from corresponding log file header
      let mode = null;
      try {
        const logFile = join(LOGS, stem + ".log");
        const fd = openSync(logFile, "r");
        const hdr = Buffer.alloc(300);
        readSync(fd, hdr, 0, 300, 0);
        closeSync(fd);
        const mm = hdr.toString("utf-8").match(/mode=([EBRL])/);
        if (mm) mode = mm[1];
      } catch {}
      const header = session ? `=== ${dateStr} (Session ${session}) ===` : `=== ${dateStr} ===`;
      const modePrefix = mode ? `Mode: ${mode}\n` : "";
      out += header + "\n" + modePrefix + content + "\n\n";
    }
    res.type("text/plain").send(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// --- /ecosystem ---
app.get("/ecosystem", (req, res) => {
  try {
    const services = JSON.parse(readFileSync(join(BASE, "services.json"), "utf-8"));
    const registry = JSON.parse(readFileSync(join(BASE, "account-registry.json"), "utf-8"));
    const ecomap = JSON.parse(readFileSync(join(BASE, "ecosystem-map.json"), "utf-8"));

    const svcList = services.services || [];
    const accounts = Array.isArray(registry) ? registry : (registry.accounts || []);
    const agents = ecomap.agents || [];

    // Per-platform detail
    const platforms = svcList.map(s => {
      const acct = accounts.find(a => a.id === s.id || a.name === s.name);
      return {
        name: s.name || s.id,
        url: s.url,
        status: s.status || "unknown",
        tier: s.tier || null,
        cred_status: acct ? acct.last_status : "no_account",
        last_checked: s.lastChecked || s.last_checked || null
      };
    });

    // Summary counts
    const summary = {
      platforms_known: svcList.length,
      platforms_evaluated: svcList.filter(s => s.status && s.status !== "discovered").length,
      platforms_rejected: svcList.filter(s => s.status === "rejected").length,
      platforms_with_creds: accounts.filter(a => a.last_status === "live" || a.last_status === "creds_ok" || a.last_status === "degraded").length,
      agents_total: agents.length,
      agents_online: agents.filter(a => a.online).length,
      agents_with_exchange: agents.filter(a => a.has_exchange).length
    };

    // Directive compliance
    let directives = null;
    try {
      const dt = JSON.parse(readFileSync(join(BASE, "directives.json"), "utf-8"));
      const eco = ["platform-engagement", "platform-discovery", "ecosystem-adoption"];
      directives = {};
      for (const name of eco) {
        const d = dt.compliance?.metrics?.[name];
        if (d) {
          const total = (d.followed || 0) + (d.ignored || 0);
          directives[name] = {
            followed: d.followed || 0,
            ignored: d.ignored || 0,
            rate: total > 0 ? Math.round((d.followed / total) * 100) : null,
            last_ignored_reason: d.last_ignored_reason || null,
            history: d.history || []
          };
        }
      }
    } catch {}

    res.json({ summary, platforms, directives });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- /ecosystem/timeline ---
app.get("/ecosystem/timeline", (req, res) => {
  try {
    const snapFile = "/home/moltbot/.config/moltbook/ecosystem-snapshots.jsonl";
    const lines = readFileSync(snapFile, "utf-8").trim().split("\n").filter(Boolean);
    const snapshots = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json({ count: snapshots.length, snapshots });
  } catch (e) {
    if (e.code === "ENOENT") return res.json({ count: 0, snapshots: [] });
    res.status(500).json({ error: e.message });
  }
});
// --- DELETE /directives/:id ---
app.delete("/directives/:id", (req, res) => {
  try {
    const file = join(BASE, "directives.json");
    const data = JSON.parse(readFileSync(file, "utf-8"));
    const idx = data.directives.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "not found" });
    data.directives.splice(idx, 1);
    writeFileSync(file, JSON.stringify(data, null, 2));
    res.json({ ok: true, deleted: req.params.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// --- /ecosystem/engagement ---
app.get("/ecosystem/engagement", (req, res) => {
  try {
    const logFile = "/home/moltbot/.config/moltbook/engagement-actions.jsonl";
    if (!existsSync(logFile)) return res.json({ count: 0, actions: [] });
    const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
    let actions = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // Filters
    const session = req.query.session ? parseInt(req.query.session) : null;
    const platform = req.query.platform || null;
    const since = req.query.since || null;
    if (session) actions = actions.filter(a => a.session === session);
    if (platform) actions = actions.filter(a => a.platform === platform);
    if (since) actions = actions.filter(a => a.ts > since);

    // Offset-based polling for live updates
    const offset = parseInt(req.query.offset) || 0;
    if (offset > 0) actions = actions.slice(offset);

    res.json({ count: actions.length, total: lines.length, actions });
  } catch (e) {
    res.status(500).json({ error: e.message?.slice(0, 100) });
  }
});

// --- Work Queue ---
app.get("/queue", (req, res) => {
  try {
    const wq = JSON.parse(readFileSync(join(BASE, "work-queue.json"), "utf-8"));
    const archive = JSON.parse(readFileSync(join(BASE, "work-queue-archive.json"), "utf-8"));
    const items = wq.queue || [];
    const archived = archive.archived || [];
    const summary = { total: items.length, pending: 0, in_progress: 0, blocked: 0, done: 0, retired: 0 };
    for (const item of items) summary[item.status] = (summary[item.status] || 0) + 1;
    const archiveSummary = { total: archived.length, done: 0, completed: 0, retired: 0 };
    for (const item of archived) archiveSummary[item.status] = (archiveSummary[item.status] || 0) + 1;
    res.json({ summary, items, archive: archiveSummary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/queue/:id", (req, res) => {
  try {
    const file = join(BASE, "work-queue.json");
    const wq = JSON.parse(readFileSync(file, "utf-8"));
    const item = (wq.queue || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const allowed = ["status", "title", "priority", "tags", "notes"];
    for (const key of allowed) {
      if (body[key] !== undefined) item[key] = body[key];
    }
    writeFileSync(file, JSON.stringify(wq, null, 2));
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/queue", (req, res) => {
  try {
    const file = join(BASE, "work-queue.json");
    const wq = JSON.parse(readFileSync(file, "utf-8"));
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body.title) return res.status(400).json({ error: "title required" });
    const maxId = (wq.queue || []).reduce((m, i) => {
      const n = parseInt((i.id || "").replace("wq-", ""));
      return n > m ? n : m;
    }, 0);
    const item = {
      id: "wq-" + String(maxId + 1).padStart(3, "0"),
      title: body.title,
      status: "pending",
      priority: body.priority || "medium",
      source: body.source || "human-monitor",
      tags: body.tags || [],
      notes: body.notes || null,
      created_session: null
    };
    wq.queue.push(item);
    writeFileSync(file, JSON.stringify(wq, null, 2));
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Human Review ---
app.get("/human-review", (req, res) => {
  try {
    const data = JSON.parse(readFileSync(join(BASE, "human-review.json"), "utf-8"));
    res.json({ count: (data.items || []).length, items: data.items || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/human-review/:id", (req, res) => {
  try {
    const file = join(BASE, "human-review.json");
    const data = JSON.parse(readFileSync(file, "utf-8"));
    const idx = (data.items || []).findIndex(i => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "not found" });
    const removed = data.items.splice(idx, 1)[0];
    writeFileSync(file, JSON.stringify(data, null, 2));
    res.json({ ok: true, dismissed: removed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/human-review/:id/resolve", (req, res) => {
  try {
    const file = join(BASE, "human-review.json");
    const data = JSON.parse(readFileSync(file, "utf-8"));
    const item = (data.items || []).find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    item.resolved = true;
    item.resolved_at = new Date().toISOString();
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (body && body.note) item.resolution_note = body.note;
    writeFileSync(file, JSON.stringify(data, null, 2));
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Inbox ---
app.get("/inbox", (req, res) => {
  try {
    const msgs = JSON.parse(readFileSync(join(BASE, "inbox.json"), "utf-8"));
    const unread = msgs.filter(m => !m.read).length;
    res.json({ total: msgs.length, unread, messages: msgs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/inbox/:id", (req, res) => {
  try {
    const msgs = JSON.parse(readFileSync(join(BASE, "inbox.json"), "utf-8"));
    const msg = msgs.find(m => m.id === req.params.id || (m.id && m.id.startsWith(req.params.id)));
    if (!msg) return res.status(404).json({ error: "not found" });
    res.json(msg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/inbox/:id", (req, res) => {
  try {
    const file = join(BASE, "inbox.json");
    const msgs = JSON.parse(readFileSync(file, "utf-8"));
    const idx = msgs.findIndex(m => m.id === req.params.id || (m.id && m.id.startsWith(req.params.id)));
    if (idx === -1) return res.status(404).json({ error: "not found" });
    const removed = msgs.splice(idx, 1)[0];
    writeFileSync(file, JSON.stringify(msgs, null, 2));
    res.json({ ok: true, deleted: removed.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/inbox", (req, res) => {
  try {
    const file = join(BASE, "inbox.json");
    const msgs = JSON.parse(readFileSync(file, "utf-8"));
    writeFileSync(file, "[]");
    res.json({ ok: true, cleared: msgs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Engagement content (posts, comments, messages the bot published) ---
const REPLAY_PATH = "/home/moltbot/.config/moltbook/engagement-replay.jsonl";
const ENGAGEMENT_LOG_PATH = "/home/moltbot/.config/moltbook/engagement-log.json";

const WRITE_TOOLS = new Set([
  "moltbook_post", "moltbook_post_create", "moltbook_comment", "moltbook_vote",
  "fourclaw_post", "fourclaw_reply", "chatr_send", "inbox_send",
  "agentchan_post", "agentchan_reply",
  "mdi_contribute",
  "colony_post_create", "colony_comment",
  "lobstack_post", "lobsterpedia_contribute", "dal_action", "grove_post"
]);

function loadReplay(filter) {
  const entries = [];
  try {
    const lines = readFileSync(REPLAY_PATH, "utf-8").trim().split("\n");
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (filter && !filter(e)) continue;
        entries.push(e);
      } catch {}
    }
  } catch {}
  return entries;
}

// GET /content — all content the bot published (posts, comments, replies, messages)
app.get("/content", (req, res) => {
  const session = req.query.session ? parseInt(req.query.session) : null;
  const platform = req.query.platform || null;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;

  const writes = loadReplay(e => {
    if (!WRITE_TOOLS.has(e.tool)) return false;
    if (session && e.s !== session) return false;
    if (platform) {
      const p = e.tool.split("_")[0];
      if (p !== platform) return false;
    }
    return true;
  });

  // Extract content and platform from each entry
  const items = writes.map(e => {
    const p = e.params || {};
    const platform = e.tool.split("_")[0];
    const type = e.tool.includes("comment") || e.tool.includes("reply") ? "comment" :
                 e.tool.includes("send") ? "message" :
                 e.tool.includes("vote") ? "vote" : "post";
    return {
      timestamp: e.ts,
      session: e.s,
      platform,
      type,
      tool: e.tool,
      content: p.content || p.body || p.text || p.message || null,
      target: p.post_id || p.thread_id || p.channel || p.room || p.url || null,
      params: p,
    };
  }).reverse();

  const paged = items.slice(offset, offset + limit);
  res.json({ total: items.length, offset, limit, items: paged });
});

// GET /content/stats — summary of content published by platform and type
app.get("/content/stats", (req, res) => {
  const writes = loadReplay(e => WRITE_TOOLS.has(e.tool));
  const stats = {};
  const sessions = new Set();
  for (const e of writes) {
    const platform = e.tool.split("_")[0];
    const type = e.tool.includes("comment") || e.tool.includes("reply") ? "comment" :
                 e.tool.includes("send") ? "message" :
                 e.tool.includes("vote") ? "vote" : "post";
    if (!stats[platform]) stats[platform] = { posts: 0, comments: 0, messages: 0, votes: 0, total: 0 };
    stats[platform][type] = (stats[platform][type] || 0) + 1;
    stats[platform].total++;
    sessions.add(e.s);
  }
  res.json({ total_writes: writes.length, platforms: stats, sessions_with_writes: sessions.size });
});

// GET /content/session/:num — all content from a specific session
app.get("/content/session/:num", (req, res) => {
  const num = parseInt(req.params.num);
  const all = loadReplay(e => e.s === num);
  const writes = all.filter(e => WRITE_TOOLS.has(e.tool));
  const reads = all.filter(e => !WRITE_TOOLS.has(e.tool));

  const items = all.map(e => {
    const p = e.params || {};
    return {
      timestamp: e.ts,
      tool: e.tool,
      is_write: WRITE_TOOLS.has(e.tool),
      content: p.content || p.body || p.text || p.message || null,
      target: p.post_id || p.thread_id || p.channel || p.room || p.url || null,
      params: p,
    };
  });

  res.json({ session: num, total: items.length, writes: writes.length, reads: reads.length, items });
});

// GET /engagement-log — session-level engagement summaries
app.get("/engagement-log", (req, res) => {
  try {
    const log = JSON.parse(readFileSync(ENGAGEMENT_LOG_PATH, "utf-8"));
    const entries = Array.isArray(log) ? log : [];
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    res.json({ total: entries.length, items: entries.slice(-limit).reverse() });
  } catch (e) {
    res.json({ total: 0, items: [], error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Monitor API listening on port ${PORT}`);
});

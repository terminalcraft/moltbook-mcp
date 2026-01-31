import express from "express";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const app = express();
const PORT = 3847;
const TOKEN = "m0lty-ap1-s3cret-k3y";
const BASE = "/home/moltbot/moltbook-mcp";
const LOGS = "/home/moltbot/.config/moltbook/logs";

const ALLOWED_FILES = {
  briefing: "BRIEFING.md",
  brainstorming: "BRAINSTORMING.md",
  dialogue: "dialogue.md",
  requests: "requests.md",
  backlog: "backlog.md",
};

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || h !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.use(auth);
app.use(express.text({ limit: "1mb" }));

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

app.post("/files/dialogue", (req, res) => {
  try {
    writeFileSync(join(BASE, "dialogue.md"), req.body, "utf-8");
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
          `LOG=$(ls -t ${LOGS}/*.log 2>/dev/null | grep -v cron | grep -v skipped | grep -v timeout | head -1) && echo "$LOG" && stat --format='%W' "$LOG" && date +%s && grep -c '"type":"tool_use"' "$LOG" 2>/dev/null || echo 0`,
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
    // Calculate next heartbeat: cron is */7, so next fire = next minute divisible by 7
    const nowDate = new Date();
    const mins = nowDate.getMinutes();
    const nextMin = Math.ceil((mins + 1) / 7) * 7;
    const next = new Date(nowDate);
    next.setSeconds(0, 0);
    if (nextMin >= 60) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(nextMin - 60);
    } else {
      next.setMinutes(nextMin);
    }
    next_heartbeat = Math.round((next.getTime() - nowDate.getTime()) / 1000);

    res.json({ running, tools, elapsed_seconds, next_heartbeat });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Molty API listening on port ${PORT}`);
});

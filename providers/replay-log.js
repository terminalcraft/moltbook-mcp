// Engagement replay log — records every external HTTP call with platform, method, status, latency.
// Monkey-patches global fetch. Import early in index.js.
// Log file: ~/.config/moltbook/replay-log.jsonl (one JSON object per line)

import { appendFileSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || process.env.USERPROFILE || "/home/moltbot";
const LOG_PATH = join(HOME, ".config/moltbook/replay-log.jsonl");
const SESSION_NUM = parseInt(process.env.SESSION_NUM || "0", 10);
const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2MB, then rotate

// Platform detection from URL
function detectPlatform(url) {
  if (typeof url !== "string") url = url?.toString?.() || "";
  const u = url.toLowerCase();
  if (u.includes("moltbook.com")) return "moltbook";
  if (u.includes("4claw.org")) return "4claw";
  if (u.includes("chatr.ai")) return "chatr";
  if (u.includes("thecolony.cc")) return "colony";
  if (u.includes("lobchan")) return "lobchan";
  if (u.includes("bsky.social") || u.includes("bsky.app")) return "bluesky";
  if (u.includes("ctxly.app") || u.includes("ctxly")) return "ctxly";
  if (u.includes("agentid.sh")) return "agentid";
  if (u.includes("imanagent.dev")) return "imanagent";
  if (u.includes("moltbotden")) return "moltbotden";
  if (u.includes("darkclawbook")) return "darkclawbook";
  if (u.includes("mydeadinternet")) return "mydeadinternet";
  if (u.includes("tulip")) return "tulip";
  if (u.includes("grove")) return "grove";
  if (u.includes("lobstack")) return "lobstack";
  if (u.includes("routstr")) return "routstr";
  if (u.includes("127.0.0.1") || u.includes("localhost")) return "local";
  if (u.includes("github.com") || u.includes("api.github.com")) return "github";
  return "unknown";
}

// Extract path without query string
function extractPath(url) {
  try {
    const u = new URL(typeof url === "string" ? url : url.toString());
    return u.pathname;
  } catch { return ""; }
}

function rotateIfNeeded() {
  try {
    const st = statSync(LOG_PATH);
    if (st.size > MAX_LOG_SIZE) {
      // Keep last half
      const content = readFileSync(LOG_PATH, "utf8");
      const lines = content.trim().split("\n");
      const keep = lines.slice(Math.floor(lines.length / 2));
      writeFileSync(LOG_PATH, keep.join("\n") + "\n");
    }
  } catch { /* file doesn't exist yet */ }
}

function logEntry(entry) {
  try {
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch { /* best effort */ }
}

// In-memory session summary for quick access
const sessionCalls = [];

export function getSessionReplayCalls() { return sessionCalls; }
export function getReplayLogPath() { return LOG_PATH; }

export function installReplayLog() {
  rotateIfNeeded();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function replayFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url || String(input);
    const method = init?.method || "GET";
    const platform = detectPlatform(url);

    // Skip logging local/internal calls to reduce noise
    if (platform === "local") {
      return originalFetch(input, init);
    }

    const start = Date.now();
    let status = 0;
    let error = null;

    try {
      const res = await originalFetch(input, init);
      status = res.status;
      const entry = {
        t: new Date().toISOString(),
        s: SESSION_NUM,
        p: platform,
        m: method.toUpperCase(),
        url: extractPath(url),
        st: status,
        ms: Date.now() - start
      };
      logEntry(entry);
      sessionCalls.push(entry);
      return res;
    } catch (e) {
      error = e.name || "Error";
      const entry = {
        t: new Date().toISOString(),
        s: SESSION_NUM,
        p: platform,
        m: method.toUpperCase(),
        url: extractPath(url),
        st: 0,
        ms: Date.now() - start,
        err: error
      };
      logEntry(entry);
      sessionCalls.push(entry);
      throw e;
    }
  };
}

// Analysis: read log and produce per-platform summary
export function analyzeReplayLog(opts = {}) {
  const { lastN, sessionFilter } = opts;
  let lines;
  try {
    const raw = readFileSync(LOG_PATH, "utf8").trim();
    if (!raw) return { error: "Log empty" };
    lines = raw.split("\n");
  } catch {
    return { error: "No replay log found" };
  }

  let entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  if (sessionFilter !== undefined) {
    entries = entries.filter(e => e.s === sessionFilter);
  }
  if (lastN) {
    entries = entries.slice(-lastN);
  }

  // Per-platform stats
  const platforms = {};
  for (const e of entries) {
    if (!platforms[e.p]) platforms[e.p] = { calls: 0, errors: 0, totalMs: 0, methods: {}, statuses: {} };
    const p = platforms[e.p];
    p.calls++;
    if (e.err || e.st >= 400) p.errors++;
    p.totalMs += e.ms || 0;
    p.methods[e.m] = (p.methods[e.m] || 0) + 1;
    const sk = e.err ? `err:${e.err}` : String(e.st);
    p.statuses[sk] = (p.statuses[sk] || 0) + 1;
  }

  // Compute averages and sort
  const summary = Object.entries(platforms).map(([name, d]) => ({
    platform: name,
    calls: d.calls,
    errors: d.errors,
    errorRate: d.calls > 0 ? Math.round(d.errors / d.calls * 100) : 0,
    avgMs: d.calls > 0 ? Math.round(d.totalMs / d.calls) : 0,
    methods: d.methods,
    statuses: d.statuses
  })).sort((a, b) => b.calls - a.calls);

  return {
    totalEntries: entries.length,
    sessionRange: entries.length > 0 ? { first: entries[0].s, last: entries[entries.length - 1].s } : null,
    platforms: summary
  };
}

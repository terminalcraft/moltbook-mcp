// Engagement replay analytics — aggregates replay-log + engagement-replay + session-history
// to identify which platforms yield the most meaningful interactions per dollar spent.
// wq-012

import { readFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || "/home/moltbot";
const REPLAY_LOG = join(HOME, ".config/moltbook/replay-log.jsonl");
const ENGAGEMENT_LOG = join(HOME, ".config/moltbook/engagement-replay.jsonl");
const SESSION_HISTORY = join(HOME, ".config/moltbook/session-history.txt");

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function parseSessionHistory() {
  try {
    const lines = readFileSync(SESSION_HISTORY, "utf8").trim().split("\n").filter(Boolean);
    const sessions = {};
    for (const line of lines) {
      const modeMatch = line.match(/mode=(\w+)/);
      const sessionMatch = line.match(/s=(\d+)/);
      const costMatch = line.match(/cost=\$([0-9.]+)/);
      const durMatch = line.match(/dur=(\d+)m(\d+)s/);
      if (!sessionMatch) continue;
      const s = parseInt(sessionMatch[1]);
      sessions[s] = {
        mode: modeMatch?.[1] || "?",
        cost: costMatch ? parseFloat(costMatch[1]) : 0,
        durSec: durMatch ? parseInt(durMatch[1]) * 60 + parseInt(durMatch[2]) : 0
      };
    }
    return sessions;
  } catch { return {}; }
}

// Map MCP tool names to platforms
function toolToPlatform(tool) {
  if (tool.startsWith("fourclaw_")) return "4claw";
  if (tool.startsWith("moltbook_")) return "moltbook";
  if (tool.startsWith("chatr_")) return "chatr";
  if (tool.startsWith("ctxly_")) return "ctxly";
  if (tool.startsWith("discover_")) return "discovery";
  if (tool.startsWith("registry_")) return "registry";
  if (tool.startsWith("knowledge_") || tool.startsWith("agent_")) return "knowledge";
  if (tool.startsWith("inbox_")) return "inbox";
  return "other";
}

// Classify tool calls as read vs write (engagement depth signal)
function isWriteAction(tool) {
  const writes = ["reply", "send", "post", "comment", "vote", "register", "attest", "remember", "submit"];
  return writes.some(w => tool.includes(w));
}

export function analyzeEngagement() {
  const httpLog = readJsonl(REPLAY_LOG);
  const toolLog = readJsonl(ENGAGEMENT_LOG);
  const sessions = parseSessionHistory();

  // --- Per-session platform activity from tool log ---
  const sessionPlatforms = {}; // { sessionNum: { platform: { reads, writes, tools: [] } } }
  for (const entry of toolLog) {
    const s = entry.s;
    if (!sessionPlatforms[s]) sessionPlatforms[s] = {};
    const platform = toolToPlatform(entry.tool || "");
    if (!sessionPlatforms[s][platform]) sessionPlatforms[s][platform] = { reads: 0, writes: 0, calls: 0 };
    sessionPlatforms[s][platform].calls++;
    if (isWriteAction(entry.tool || "")) {
      sessionPlatforms[s][platform].writes++;
    } else {
      sessionPlatforms[s][platform].reads++;
    }
  }

  // --- Per-session platform activity from HTTP log ---
  for (const entry of httpLog) {
    const s = entry.s;
    if (!sessionPlatforms[s]) sessionPlatforms[s] = {};
    const platform = entry.p;
    if (!sessionPlatforms[s][platform]) sessionPlatforms[s][platform] = { reads: 0, writes: 0, calls: 0 };
    sessionPlatforms[s][platform].calls++;
    if (entry.m === "POST" || entry.m === "PUT" || entry.m === "PATCH") {
      sessionPlatforms[s][platform].writes++;
    } else {
      sessionPlatforms[s][platform].reads++;
    }
  }

  // --- Aggregate per-platform across all E sessions ---
  const platformStats = {}; // { platform: { totalCost, totalSessions, totalCalls, totalWrites, totalReads, sessions: [] } }

  for (const [sNum, platforms] of Object.entries(sessionPlatforms)) {
    const s = parseInt(sNum);
    const sessionInfo = sessions[s];
    if (!sessionInfo) continue;
    // Only count E sessions for cost-per-interaction
    const isE = sessionInfo.mode === "E";

    for (const [platform, stats] of Object.entries(platforms)) {
      if (!platformStats[platform]) {
        platformStats[platform] = { totalCost: 0, totalSessions: 0, totalCalls: 0, totalWrites: 0, totalReads: 0, eSessions: 0, eSessionCost: 0 };
      }
      const p = platformStats[platform];
      p.totalCalls += stats.calls;
      p.totalWrites += stats.writes;
      p.totalReads += stats.reads;
      p.totalSessions++;
      if (isE) {
        // Distribute session cost proportionally across platforms by call count
        const totalCallsInSession = Object.values(platforms).reduce((a, b) => a + b.calls, 0);
        const costShare = totalCallsInSession > 0 ? (stats.calls / totalCallsInSession) * sessionInfo.cost : 0;
        p.eSessionCost += costShare;
        p.eSessions++;
      }
    }
  }

  // --- Compute totals for diversity metrics ---
  const totalWrites = Object.values(platformStats).reduce((a, p) => a + p.totalWrites, 0);
  const totalCalls = Object.values(platformStats).reduce((a, p) => a + p.totalCalls, 0);

  // --- Build ranked output ---
  const ranked = Object.entries(platformStats)
    .map(([name, d]) => ({
      platform: name,
      total_calls: d.totalCalls,
      writes: d.totalWrites,
      reads: d.totalReads,
      write_ratio: d.totalCalls > 0 ? Math.round(d.totalWrites / d.totalCalls * 100) : 0,
      sessions_seen: d.totalSessions,
      e_sessions: d.eSessions,
      e_cost_allocated: Math.round(d.eSessionCost * 100) / 100,
      cost_per_write: d.totalWrites > 0 && d.eSessionCost > 0 ? Math.round(d.eSessionCost / d.totalWrites * 100) / 100 : null,
      cost_per_call: d.totalCalls > 0 && d.eSessionCost > 0 ? Math.round(d.eSessionCost / d.totalCalls * 100) / 100 : null,
      // Diversity metrics: percentage of total engagement on this platform
      pct_of_writes: totalWrites > 0 ? Math.round(d.totalWrites / totalWrites * 100) : 0,
      pct_of_calls: totalCalls > 0 ? Math.round(d.totalCalls / totalCalls * 100) : 0
    }))
    .sort((a, b) => b.writes - a.writes);

  // --- Compute concentration metrics (Herfindahl-Hirschman Index style) ---
  // HHI = sum of squared market shares. Range: 0-10000. Higher = more concentrated.
  // Values > 2500 indicate high concentration (dominated by few platforms).
  const hhi_writes = ranked.reduce((acc, p) => acc + Math.pow(p.pct_of_writes, 2), 0);
  const hhi_calls = ranked.reduce((acc, p) => acc + Math.pow(p.pct_of_calls, 2), 0);
  // Effective number of platforms = 1/HHI (normalized). Shows how many platforms carry the load.
  const effective_platforms_writes = hhi_writes > 0 ? Math.round(10000 / hhi_writes * 10) / 10 : 0;
  const effective_platforms_calls = hhi_calls > 0 ? Math.round(10000 / hhi_calls * 10) / 10 : 0;
  // Top-1 and top-3 concentration
  const top1_pct = ranked.length > 0 ? ranked[0].pct_of_writes : 0;
  const top3_pct = ranked.slice(0, 3).reduce((a, p) => a + p.pct_of_writes, 0);

  // --- E session cost summary ---
  const eSessions = Object.entries(sessions).filter(([, v]) => v.mode === "E");
  const eTotalCost = eSessions.reduce((a, [, v]) => a + v.cost, 0);

  // --- Build diversity insight ---
  let diversityWarning = null;
  if (top1_pct > 50) {
    diversityWarning = `Over-concentrated: ${ranked[0].platform} accounts for ${top1_pct}% of writes. Diversify to other platforms.`;
  } else if (top3_pct > 80 && ranked.length > 3) {
    diversityWarning = `Top 3 platforms account for ${top3_pct}% of writes. Consider engaging underused platforms.`;
  }

  return {
    data_sources: {
      http_log_entries: httpLog.length,
      tool_log_entries: toolLog.length,
      sessions_in_history: Object.keys(sessions).length,
      e_sessions: eSessions.length
    },
    e_session_summary: {
      count: eSessions.length,
      total_cost: Math.round(eTotalCost * 100) / 100,
      avg_cost: eSessions.length > 0 ? Math.round(eTotalCost / eSessions.length * 100) / 100 : 0
    },
    platforms: ranked,
    diversity: {
      hhi_writes,
      hhi_calls,
      effective_platforms_writes,
      effective_platforms_calls,
      top1_pct,
      top3_pct,
      platform_count: ranked.length,
      warning: diversityWarning
    },
    insight: ranked.length > 0
      ? `Top platform by writes: ${ranked[0].platform} (${ranked[0].writes} writes, ${top1_pct}%). ` +
        (ranked.find(r => r.cost_per_write !== null)
          ? `Best cost/write: ${ranked.filter(r => r.cost_per_write !== null).sort((a, b) => a.cost_per_write - b.cost_per_write)[0]?.platform}. `
          : "") +
        `Diversity: ${effective_platforms_writes} effective platforms.`
      : "No engagement data yet."
  };
}

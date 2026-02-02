// Chatr digest summarizer — reads chatr-snapshots and produces structured summaries.
// Designed for cross-session continuity: E sessions can quickly see what happened on chatr.
// wq-012

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const SNAP_DIR = join(process.env.HOME || "/home/moltbot", ".config/moltbook/chatr-snapshots");

function loadSnapshots(maxSnapshots = 10) {
  let files;
  try {
    files = readdirSync(SNAP_DIR)
      .filter(f => f.startsWith("digest-") && f.endsWith(".json"))
      .sort()
      .slice(-maxSnapshots);
  } catch { return []; }

  return files.map(f => {
    try {
      const data = JSON.parse(readFileSync(join(SNAP_DIR, f), "utf8"));
      const ts = f.replace("digest-", "").replace(".json", "");
      return { file: f, ts, ...data };
    } catch { return null; }
  }).filter(Boolean);
}

export function summarizeChatr(opts = {}) {
  const maxSnapshots = opts.maxSnapshots || 10;
  const snapshots = loadSnapshots(maxSnapshots);

  if (!snapshots.length) {
    return { error: "No chatr snapshots found", agents: [], topics: [], summary: "No data" };
  }

  // Aggregate all messages across snapshots
  const allMsgs = [];
  const seen = new Set();
  for (const snap of snapshots) {
    for (const msg of (snap.messages || [])) {
      if (!seen.has(msg.id)) {
        seen.add(msg.id);
        allMsgs.push(msg);
      }
    }
  }

  // Per-agent stats
  const agentStats = {};
  for (const msg of allMsgs) {
    const a = msg.agent;
    if (!agentStats[a]) agentStats[a] = { messages: 0, totalScore: 0, maxScore: 0 };
    agentStats[a].messages++;
    agentStats[a].totalScore += msg.score || 0;
    agentStats[a].maxScore = Math.max(agentStats[a].maxScore, msg.score || 0);
  }

  const agents = Object.entries(agentStats)
    .map(([name, s]) => ({
      agent: name,
      messages: s.messages,
      avgScore: s.messages > 0 ? Math.round(s.totalScore / s.messages * 10) / 10 : 0,
      maxScore: s.maxScore
    }))
    .sort((a, b) => b.avgScore - a.avgScore);

  // Extract high-signal messages (score >= 4)
  const highSignal = allMsgs
    .filter(m => (m.score || 0) >= 4)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 10);

  // Detect repeated content (spam indicator)
  const contentCounts = {};
  for (const msg of allMsgs) {
    const key = msg.content?.slice(0, 80) || "";
    contentCounts[key] = (contentCounts[key] || 0) + 1;
  }
  const spamPatterns = Object.entries(contentCounts)
    .filter(([, count]) => count > 2)
    .map(([content, count]) => ({ content: content.slice(0, 60), count }))
    .sort((a, b) => b.count - a.count);

  // Time range
  const times = allMsgs.map(m => m.time).filter(Boolean).sort();

  return {
    snapshots_analyzed: snapshots.length,
    time_range: times.length ? { earliest: times[0], latest: times[times.length - 1] } : null,
    unique_messages: allMsgs.length,
    unique_agents: agents.length,
    agents,
    high_signal: highSignal.map(m => ({
      agent: m.agent,
      score: m.score,
      content: m.content?.slice(0, 200),
      time: m.time
    })),
    spam_patterns: spamPatterns.slice(0, 5),
    summary: agents.length > 0
      ? `${allMsgs.length} messages from ${agents.length} agents. Top: ${agents[0].agent} (avg ${agents[0].avgScore}). ${spamPatterns.length > 0 ? `${spamPatterns.length} spam patterns detected.` : "Low spam."}`
      : "Empty digest."
  };
}

#!/usr/bin/env node

// note-quality-aggregate.mjs — Aggregate note quality trends for A session audits (wq-518)
// Parses note-quality.log and outputs a summary of quality issues by session type and pattern.
// Usage: node note-quality-aggregate.mjs [--json] [--last=N]

import fs from "fs";
import path from "path";

const HOME = process.env.HOME || "/home/moltbot";
const LOG_PATH = path.join(HOME, ".config/moltbook/logs/note-quality.log");

function parseLogLine(line) {
  // Format: 2026-02-09T19:49:07+01:00 s=1368 mode=R QUALITY: truncated note...
  // Or:     2026-02-09T19:49:08+01:00 s=1371 mode=E OK
  const m = line.match(/^(\S+)\s+s=(\d+)\s+mode=(\w)\s+(.+)$/);
  if (!m) return null;
  const [, timestamp, session, mode, status] = m;
  const ok = status === "OK";
  const issues = ok ? [] : status.replace(/^QUALITY:\s*/, "").split("; ").filter(Boolean);
  return { timestamp, session: parseInt(session, 10), mode, ok, issues };
}

function categorizeIssue(issue) {
  if (/truncated/i.test(issue)) return "truncated";
  if (/commit.?message/i.test(issue)) return "commit-message-only";
  if (/missing.*marker/i.test(issue) || /session marker/i.test(issue)) return "missing-marker";
  if (/dur=\?/i.test(issue) || /missing duration/i.test(issue)) return "missing-duration";
  if (/placeholder/i.test(issue)) return "placeholder-not-replaced";
  if (/preamble/i.test(issue)) return "agent-preamble";
  return "other";
}

function aggregate(entries) {
  const byMode = {};
  const byCategory = {};
  let totalOk = 0;
  let totalFail = 0;

  for (const entry of entries) {
    if (!byMode[entry.mode]) byMode[entry.mode] = { ok: 0, fail: 0, issues: [] };

    if (entry.ok) {
      totalOk++;
      byMode[entry.mode].ok++;
    } else {
      totalFail++;
      byMode[entry.mode].fail++;
      for (const issue of entry.issues) {
        const cat = categorizeIssue(issue);
        byCategory[cat] = (byCategory[cat] || 0) + 1;
        byMode[entry.mode].issues.push(cat);
      }
    }
  }

  const total = totalOk + totalFail;
  const passRate = total > 0 ? Math.round((totalOk / total) * 100) : 100;

  return { total, totalOk, totalFail, passRate, byMode, byCategory };
}

function main() {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes("--json");
  const lastArg = args.find(a => a.startsWith("--last="));
  const lastN = lastArg ? parseInt(lastArg.split("=")[1], 10) : 0;

  let lines;
  try {
    lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    if (jsonFlag) {
      console.log(JSON.stringify({ error: "no log file", total: 0 }));
    } else {
      console.log("No note-quality.log found. No data to aggregate.");
    }
    return;
  }

  let entries = lines.map(parseLogLine).filter(Boolean);
  if (lastN > 0) entries = entries.slice(-lastN);

  const result = aggregate(entries);

  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable output
  console.log(`Note Quality Summary (${result.total} entries)`);
  console.log(`Pass rate: ${result.passRate}% (${result.totalOk} OK, ${result.totalFail} issues)\n`);

  if (result.totalFail === 0) {
    console.log("All session notes pass quality checks.");
    return;
  }

  console.log("Issues by session type:");
  for (const [mode, data] of Object.entries(result.byMode)) {
    const modeTotal = data.ok + data.fail;
    const modeRate = Math.round((data.ok / modeTotal) * 100);
    if (data.fail > 0) {
      console.log(`  ${mode}: ${modeRate}% pass (${data.fail}/${modeTotal} failed) — ${[...new Set(data.issues)].join(", ")}`);
    }
  }

  console.log("\nIssues by category:");
  const sorted = Object.entries(result.byCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sorted) {
    console.log(`  ${cat}: ${count}`);
  }
}

main();

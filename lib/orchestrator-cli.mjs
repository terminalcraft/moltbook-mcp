/**
 * lib/orchestrator-cli.mjs — Diagnostic CLI handlers extracted from engage-orchestrator.mjs (R#259).
 *
 * Handles: --history, --diversity, --diversity-trends, --quality-check
 * Core orchestration + circuit breaker CLI (--record-outcome, --circuit-status) stays in engage-orchestrator.mjs.
 */

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { analyzeEngagement } from "../providers/engagement-analytics.js";

const STATE_DIR = join(process.env.HOME, '.config/moltbook');

/**
 * --history [--json]: Diagnostic view of circuit breaker history.
 * Shows time since success, trends, retry info per platform.
 */
export function handleHistory(argv, { loadCircuits, getCircuitState, CIRCUIT_COOLDOWN_MS }) {
  const circuits = loadCircuits();
  const now = Date.now();
  const jsonMode = argv.includes("--json");

  const diagnostics = Object.entries(circuits).map(([platform, entry]) => {
    const state = getCircuitState(circuits, platform);
    const lastSuccess = entry.last_success ? new Date(entry.last_success).getTime() : null;
    const lastFailure = entry.last_failure ? new Date(entry.last_failure).getTime() : null;
    const hoursSinceSuccess = lastSuccess ? (now - lastSuccess) / (3600 * 1000) : null;
    const failureStreak = entry.consecutive_failures || 0;

    let streakTrend = "stable";
    if (failureStreak >= 3) streakTrend = "circuit_open";
    else if (failureStreak >= 2) streakTrend = "degrading";
    else if (failureStreak === 0 && entry.total_successes > 0) streakTrend = "healthy";

    const total = (entry.total_failures || 0) + (entry.total_successes || 0);
    const successRate = total > 0 ? ((entry.total_successes || 0) / total * 100).toFixed(1) : "N/A";

    let retryInfo = null;
    if (state === "open" && lastFailure) {
      const timeUntilHalfOpen = CIRCUIT_COOLDOWN_MS - (now - lastFailure);
      if (timeUntilHalfOpen > 0) {
        retryInfo = `${(timeUntilHalfOpen / (3600 * 1000)).toFixed(1)}h until half-open`;
      }
    } else if (state === "half-open") {
      retryInfo = "ready for retry";
    }

    return {
      platform, state,
      hoursSinceSuccess: hoursSinceSuccess !== null ? parseFloat(hoursSinceSuccess.toFixed(1)) : null,
      failureStreak, streakTrend,
      successRate: successRate !== "N/A" ? parseFloat(successRate) : null,
      totalAttempts: total, retryInfo,
      lastError: entry.last_error || null,
    };
  });

  diagnostics.sort((a, b) => {
    const stateOrder = { "open": 0, "half-open": 1, "closed": 2 };
    if (stateOrder[a.state] !== stateOrder[b.state]) return stateOrder[a.state] - stateOrder[b.state];
    return (b.hoursSinceSuccess || 0) - (a.hoursSinceSuccess || 0);
  });

  if (jsonMode) {
    console.log(JSON.stringify({ diagnostics, timestamp: new Date().toISOString() }, null, 2));
  } else {
    console.log("\n=== Circuit Breaker History ===\n");
    console.log("Platform".padEnd(22) + "State".padEnd(12) + "Since Success".padEnd(16) + "Streak".padEnd(10) + "Trend".padEnd(14) + "Rate".padEnd(8) + "Retry Info");
    console.log("-".repeat(100));
    for (const d of diagnostics) {
      const sinceSuc = d.hoursSinceSuccess !== null ? `${d.hoursSinceSuccess}h ago` : "never";
      const rate = d.successRate !== null ? `${d.successRate}%` : "N/A";
      const retry = d.retryInfo || "-";
      console.log(
        d.platform.padEnd(22) + d.state.padEnd(12) + sinceSuc.padEnd(16) +
        String(d.failureStreak).padEnd(10) + d.streakTrend.padEnd(14) + rate.padEnd(8) + retry
      );
    }
    const open = diagnostics.filter(d => d.state === "open").length;
    const halfOpen = diagnostics.filter(d => d.state === "half-open").length;
    const degrading = diagnostics.filter(d => d.streakTrend === "degrading").length;
    console.log("\n" + "-".repeat(100));
    console.log(`Summary: ${open} open, ${halfOpen} half-open, ${degrading} degrading, ${diagnostics.length - open - halfOpen - degrading} healthy`);
  }
}

/**
 * --diversity [--json]: Engagement concentration metrics.
 */
export function handleDiversity(argv) {
  const analytics = analyzeEngagement();
  const div = analytics.diversity;
  const platforms = analytics.platforms;
  const jsonMode = argv.includes("--json");

  if (jsonMode) {
    console.log(JSON.stringify({ diversity: div, platforms }, null, 2));
  } else {
    console.log("\n=== Engagement Diversity Metrics ===\n");
    console.log(`Platform count: ${div.platform_count}`);
    console.log(`Effective platforms (writes): ${div.effective_platforms_writes}`);
    console.log(`Effective platforms (calls): ${div.effective_platforms_calls}`);
    console.log(`HHI (writes): ${div.hhi_writes} ${div.hhi_writes > 2500 ? "(HIGH concentration)" : div.hhi_writes > 1500 ? "(moderate)" : "(low)"}`);
    console.log(`Top-1 concentration: ${div.top1_pct}%`);
    console.log(`Top-3 concentration: ${div.top3_pct}%`);
    if (div.warning) console.log(`\n⚠️  ${div.warning}`);
    console.log("\nPer-platform breakdown:");
    for (const p of platforms) {
      if (p.writes > 0 || p.e_sessions > 0) {
        console.log(`  ${p.platform}: ${p.pct_of_writes}% writes (${p.writes}), ${p.pct_of_calls}% calls (${p.total_calls}), ${p.e_sessions} E sessions`);
      }
    }
  }
}

/**
 * --diversity-trends [--json]: Historical diversity trends (wq-131).
 */
export function handleDiversityTrends(argv) {
  const HISTORY_FILE = join(STATE_DIR, "diversity-history.json");
  const jsonMode = argv.includes("--json");

  if (!existsSync(HISTORY_FILE)) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: "No diversity history yet", entries: [] }));
    } else {
      console.log("No diversity history recorded yet. E sessions will record data via post-session hook.");
    }
    return;
  }

  const lines = readFileSync(HISTORY_FILE, "utf8").trim().split("\n").filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  if (entries.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: "Empty history", entries: [] }));
    } else {
      console.log("Diversity history file exists but is empty.");
    }
    return;
  }

  const recent = entries.slice(-10);
  const older = entries.slice(-20, -10);
  const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const recentHHI = avg(recent.map(e => e.hhi || 0));
  const olderHHI = avg(older.map(e => e.hhi || 0));
  const recentTop1 = avg(recent.map(e => e.top1_pct || 0));
  const olderTop1 = avg(older.map(e => e.top1_pct || 0));
  const recentEff = avg(recent.map(e => e.effective_platforms || 0));
  const olderEff = avg(older.map(e => e.effective_platforms || 0));

  const trends = {
    total_entries: entries.length,
    latest: entries[entries.length - 1],
    last_10_avg: {
      hhi: Math.round(recentHHI),
      top1_pct: Math.round(recentTop1 * 10) / 10,
      effective_platforms: Math.round(recentEff * 10) / 10
    },
    prev_10_avg: older.length > 0 ? {
      hhi: Math.round(olderHHI),
      top1_pct: Math.round(olderTop1 * 10) / 10,
      effective_platforms: Math.round(olderEff * 10) / 10
    } : null,
    trend_direction: {
      hhi: recentHHI < olderHHI ? "improving" : recentHHI > olderHHI ? "worsening" : "stable",
      concentration: recentTop1 < olderTop1 ? "diversifying" : recentTop1 > olderTop1 ? "concentrating" : "stable"
    }
  };

  if (jsonMode) {
    console.log(JSON.stringify({ trends, entries }, null, 2));
  } else {
    console.log("\n=== Engagement Diversity Trends (wq-131) ===\n");
    console.log(`Total entries: ${trends.total_entries}`);
    console.log(`Latest (session ${trends.latest.session}): HHI=${trends.latest.hhi}, top1=${trends.latest.top1_pct}%, eff=${trends.latest.effective_platforms}`);
    console.log(`\nLast 10 E sessions avg: HHI=${trends.last_10_avg.hhi}, top1=${trends.last_10_avg.top1_pct}%, eff=${trends.last_10_avg.effective_platforms}`);
    if (trends.prev_10_avg) {
      console.log(`Prev 10 E sessions avg: HHI=${trends.prev_10_avg.hhi}, top1=${trends.prev_10_avg.top1_pct}%, eff=${trends.prev_10_avg.effective_platforms}`);
      console.log(`\nTrend: HHI ${trends.trend_direction.hhi}, concentration ${trends.trend_direction.concentration}`);
    } else {
      console.log("\n(Not enough data for trend comparison yet)");
    }
  }
}

/**
 * --quality-check "text": Pre-post quality gate (d066). Exits 0 (pass) or 1 (blocked).
 */
export function handleQualityCheck(argv, scriptDir) {
  const idx = argv.indexOf("--quality-check");
  const text = argv[idx + 1];
  if (!text) {
    console.error("Usage: --quality-check \"<post text>\"");
    process.exit(1);
  }
  try {
    const output = execSync(
      `node post-quality-review.mjs --check ${JSON.stringify(text)}`,
      { encoding: "utf8", timeout: 10000, cwd: scriptDir }
    ).trim();
    console.log(output);
    process.exit(0);
  } catch (e) {
    const output = (e.stdout || "").trim();
    if (output) console.log(output);
    else console.log("BLOCKED: Post failed quality gate.");
    process.exit(1);
  }
}

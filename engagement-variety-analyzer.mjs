#!/usr/bin/env node
/**
 * engagement-variety-analyzer.mjs — Detect platform concentration in E sessions
 *
 * Analyzes engagement-trace.json to detect when >60% of recent engagement
 * targets a single platform. Supplements picker compliance tracking (wq-346).
 *
 * Usage:
 *   node engagement-variety-analyzer.mjs [--window N] [--threshold 0.6] [--json]
 *
 * Options:
 *   --window N      Number of recent sessions to analyze (default: 5)
 *   --threshold N   Concentration threshold (default: 0.6 = 60%)
 *   --json          Output JSON format for programmatic consumption
 *   --alert-file    Write alert to file if concentration detected
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const CONFIG_DIR = join(process.env.HOME || "/home/moltbot", ".config/moltbook");
const TRACE_PATH = join(CONFIG_DIR, "engagement-trace.json");
const VARIETY_STATE_PATH = join(CONFIG_DIR, "variety-analysis-state.json");
const ALERT_PATH = join(CONFIG_DIR, "variety-concentration-alert.txt");

function parseArgs(args) {
  const opts = {
    window: 5,
    threshold: 0.6,
    json: false,
    alertFile: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--window" && args[i + 1]) {
      opts.window = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--threshold" && args[i + 1]) {
      opts.threshold = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === "--json") {
      opts.json = true;
    } else if (args[i] === "--alert-file") {
      opts.alertFile = true;
    }
  }

  return opts;
}

function loadJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

function saveJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Extract platform engagement counts from a session trace.
 * Counts both platforms_engaged (presence) and threads_contributed (activity).
 */
function extractEngagementCounts(trace) {
  const counts = {};

  // Count from platforms_engaged array (entries may be strings or {platform: "..."} objects)
  if (trace.platforms_engaged && Array.isArray(trace.platforms_engaged)) {
    for (const p of trace.platforms_engaged) {
      const name = typeof p === "string" ? p : (p && p.platform ? p.platform : null);
      if (!name) continue;
      const platform = name.toLowerCase();
      counts[platform] = (counts[platform] || 0) + 1;
    }
  }

  // Count threads_contributed (weighted by activity)
  if (trace.threads_contributed && Array.isArray(trace.threads_contributed)) {
    for (const thread of trace.threads_contributed) {
      if (thread.platform) {
        const platform = thread.platform.toLowerCase();
        counts[platform] = (counts[platform] || 0) + 1;
      }
    }
  }

  return counts;
}

/**
 * Merge engagement counts from multiple sessions.
 */
function mergeEngagementCounts(sessions) {
  const merged = {};

  for (const session of sessions) {
    const counts = extractEngagementCounts(session);
    for (const [platform, count] of Object.entries(counts)) {
      merged[platform] = (merged[platform] || 0) + count;
    }
  }

  return merged;
}

/**
 * Calculate concentration metrics from engagement counts.
 */
function calculateConcentration(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return {
      total: 0,
      platforms: {},
      topPlatform: null,
      topConcentration: 0,
      isConcentrated: false,
    };
  }

  // Calculate percentages
  const platforms = {};
  let topPlatform = null;
  let topCount = 0;

  for (const [platform, count] of Object.entries(counts)) {
    const pct = count / total;
    platforms[platform] = {
      count,
      percentage: Math.round(pct * 100),
      ratio: pct,
    };

    if (count > topCount) {
      topCount = count;
      topPlatform = platform;
    }
  }

  const topConcentration = topCount / total;

  return {
    total,
    platforms,
    topPlatform,
    topConcentration,
    topConcentrationPct: Math.round(topConcentration * 100),
  };
}

/**
 * Calculate distribution health metrics.
 */
function calculateDistributionHealth(concentration, threshold) {
  const platformCount = Object.keys(concentration.platforms).length;

  // Ideal: equal distribution across 3+ platforms
  const idealConcentration = platformCount > 0 ? 1 / platformCount : 0;

  // Health score: 1.0 = perfect distribution, 0 = single platform
  // Based on distance from ideal vs worst case (100% concentration)
  let healthScore = 1.0;
  if (concentration.topConcentration > 0) {
    const deviation = concentration.topConcentration - idealConcentration;
    const maxDeviation = 1 - idealConcentration;
    healthScore = maxDeviation > 0 ? 1 - (deviation / maxDeviation) : 1;
  }

  // Round to 2 decimals
  healthScore = Math.round(healthScore * 100) / 100;

  return {
    platformCount,
    healthScore,
    isHealthy: concentration.topConcentration <= threshold,
    isConcentrated: concentration.topConcentration > threshold,
    recommendation: getRecommendation(concentration, threshold),
  };
}

function getRecommendation(concentration, threshold) {
  const pct = concentration.topConcentrationPct;
  const platform = concentration.topPlatform;

  if (pct > 80) {
    return `CRITICAL: ${pct}% concentration on ${platform}. Strongly diversify next E session — engage at least 2 other platforms.`;
  } else if (pct > threshold * 100) {
    return `WARNING: ${pct}% concentration on ${platform}. Consider engaging other platforms more in upcoming sessions.`;
  } else if (pct > 40) {
    return `MODERATE: ${platform} leads at ${pct}%. Distribution is acceptable but could improve.`;
  } else {
    return `HEALTHY: Good platform distribution. Top platform (${platform}) at ${pct}%.`;
  }
}

function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  // Load engagement trace
  const traces = loadJSON(TRACE_PATH);
  if (!traces || !Array.isArray(traces) || traces.length === 0) {
    const error = { error: "No engagement trace data found", path: TRACE_PATH };
    if (opts.json) {
      console.log(JSON.stringify(error, null, 2));
    } else {
      console.log("No engagement trace data found at", TRACE_PATH);
    }
    process.exit(1);
  }

  // Get recent sessions within window
  const recentSessions = traces.slice(-opts.window);
  const sessionRange = recentSessions.length > 0
    ? { from: recentSessions[0].session, to: recentSessions[recentSessions.length - 1].session }
    : { from: null, to: null };

  // Merge engagement counts
  const counts = mergeEngagementCounts(recentSessions);

  // Calculate concentration
  const concentration = calculateConcentration(counts);

  // Calculate health
  const health = calculateDistributionHealth(concentration, opts.threshold);

  // Build result
  const result = {
    timestamp: new Date().toISOString(),
    window: opts.window,
    threshold: opts.threshold,
    sessionsAnalyzed: recentSessions.length,
    sessionRange,
    totalEngagements: concentration.total,
    concentration: {
      topPlatform: concentration.topPlatform,
      topConcentrationPct: concentration.topConcentrationPct,
      isConcentrated: health.isConcentrated,
    },
    distribution: concentration.platforms,
    health: {
      score: health.healthScore,
      platformCount: health.platformCount,
      recommendation: health.recommendation,
    },
    alert: health.isConcentrated ? {
      level: concentration.topConcentrationPct > 80 ? "critical" : "warning",
      message: `Platform concentration detected: ${concentration.topConcentrationPct}% on ${concentration.topPlatform}`,
    } : null,
  };

  // Save state for tracking over time
  let state = loadJSON(VARIETY_STATE_PATH) || { history: [] };
  state.history = [
    {
      timestamp: result.timestamp,
      topPlatform: result.concentration.topPlatform,
      topConcentrationPct: result.concentration.topConcentrationPct,
      healthScore: result.health.score,
      platformCount: result.health.platformCount,
      sessionsAnalyzed: result.sessionsAnalyzed,
    },
    ...(state.history || []),
  ].slice(0, 20); // Keep last 20 analyses
  state.lastAnalysis = result.timestamp;
  state.lastConcentration = result.concentration.topConcentrationPct;
  state.lastHealthScore = result.health.score;
  saveJSON(VARIETY_STATE_PATH, state);

  // Output
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nEngagement Variety Analysis`);
    console.log(`${"=".repeat(50)}`);
    console.log(`Window: Last ${recentSessions.length} E sessions (s${sessionRange.from}-s${sessionRange.to})`);
    console.log(`Threshold: ${opts.threshold * 100}%`);
    console.log(`Total engagements: ${concentration.total}`);
    console.log();
    console.log(`Platform Distribution:`);

    // Sort by count descending
    const sorted = Object.entries(concentration.platforms)
      .sort((a, b) => b[1].count - a[1].count);

    for (const [platform, data] of sorted) {
      const bar = "█".repeat(Math.round(data.percentage / 5)) + "░".repeat(20 - Math.round(data.percentage / 5));
      console.log(`  ${platform.padEnd(15)} ${bar} ${data.percentage}% (${data.count})`);
    }

    console.log();
    console.log(`Health Score: ${result.health.score} (1.0 = perfect distribution)`);
    console.log(`Platform Count: ${result.health.platformCount}`);
    console.log();

    if (result.alert) {
      console.log(`⚠️  ${result.alert.level.toUpperCase()}: ${result.alert.message}`);
    }
    console.log(result.health.recommendation);
  }

  // Write alert file if requested and concentration detected
  if (opts.alertFile && result.alert) {
    const alertContent = [
      `VARIETY CONCENTRATION ALERT`,
      `Timestamp: ${result.timestamp}`,
      `Level: ${result.alert.level}`,
      ``,
      result.alert.message,
      ``,
      result.health.recommendation,
      ``,
      `Sessions analyzed: ${result.sessionsAnalyzed} (s${sessionRange.from}-s${sessionRange.to})`,
      `Platform distribution:`,
      ...Object.entries(concentration.platforms)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([p, d]) => `  ${p}: ${d.percentage}% (${d.count} engagements)`),
    ].join("\n");

    writeFileSync(ALERT_PATH, alertContent + "\n");
    console.log(`\nAlert written to ${ALERT_PATH}`);
  }

  // Exit with error code if concentration detected
  process.exit(result.alert ? 1 : 0);
}

// Export for testing; run main() only when executed directly
export { parseArgs, extractEngagementCounts, mergeEngagementCounts, calculateConcentration, calculateDistributionHealth, getRecommendation };

const isMain = process.argv[1] && (
  process.argv[1].endsWith('engagement-variety-analyzer.mjs') ||
  process.argv[1].endsWith('engagement-variety-analyzer')
);
if (isMain) main();

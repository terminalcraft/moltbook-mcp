#!/usr/bin/env node
/**
 * queue-quality-trend.mjs — Work-queue outcome quality trend analyzer.
 *
 * Analyzes outcome.quality fields from completed queue items to surface:
 * - Which sources (audit, brainstorming, intel-auto, directive) produce
 *   the highest ratio of "well-scoped" vs "duplicate"/"non-actionable" items
 * - Rolling quality trends over configurable windows
 * - Source-specific recommendations for improving queue generation
 *
 * Usage:
 *   node queue-quality-trend.mjs              # Full report
 *   node queue-quality-trend.mjs --json       # Machine-readable
 *   node queue-quality-trend.mjs --window 30  # Rolling window size (default: 50)
 */

import { readFileSync } from "fs";
import { join } from "path";

const BASE = "/home/moltbot/moltbook-mcp";

function loadArchive() {
  try {
    return JSON.parse(readFileSync(join(BASE, "work-queue-archive.json"), "utf8"));
  } catch { return { archived: [] }; }
}

function loadQueue() {
  try {
    return JSON.parse(readFileSync(join(BASE, "work-queue.json"), "utf8"));
  } catch { return { queue: [] }; }
}

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const windowIdx = args.indexOf("--window");
  const windowSize = windowIdx !== -1 ? parseInt(args[windowIdx + 1]) || 50 : 50;

  const archive = loadArchive();
  const queue = loadQueue();

  // Combine done items from both archive and current queue
  const allDone = [
    ...archive.archived.filter(i => i.outcome),
    ...queue.queue.filter(i => i.status === "done" && i.outcome),
  ];

  // Sort by session (most recent last)
  allDone.sort((a, b) => (a.outcome.session || 0) - (b.outcome.session || 0));

  const withQuality = allDone.filter(i => i.outcome.quality);

  // Overall stats
  const qualityCounts = {};
  for (const i of withQuality) {
    const q = i.outcome.quality;
    qualityCounts[q] = (qualityCounts[q] || 0) + 1;
  }

  // Source-quality cross-tabulation
  const sourceQuality = {};
  for (const i of withQuality) {
    const src = i.source || "unknown";
    if (!sourceQuality[src]) sourceQuality[src] = { total: 0 };
    sourceQuality[src].total++;
    const q = i.outcome.quality;
    sourceQuality[src][q] = (sourceQuality[src][q] || 0) + 1;
  }

  // Calculate well-scoped ratio per source
  const sourceScores = {};
  for (const [src, counts] of Object.entries(sourceQuality)) {
    const wellScoped = counts["well-scoped"] || 0;
    const total = counts.total;
    sourceScores[src] = {
      ...counts,
      well_scoped_ratio: total > 0 ? Math.round((wellScoped / total) * 100) : 0,
    };
  }

  // Rolling window analysis (last N items with quality)
  const recent = withQuality.slice(-windowSize);
  const recentQuality = {};
  const recentSourceQuality = {};
  for (const i of recent) {
    const q = i.outcome.quality;
    recentQuality[q] = (recentQuality[q] || 0) + 1;
    const src = i.source || "unknown";
    if (!recentSourceQuality[src]) recentSourceQuality[src] = { total: 0 };
    recentSourceQuality[src].total++;
    recentSourceQuality[src][q] = (recentSourceQuality[src][q] || 0) + 1;
  }

  // Effort distribution
  const effortCounts = {};
  for (const i of allDone) {
    const e = i.outcome.effort || "unknown";
    effortCounts[e] = (effortCounts[e] || 0) + 1;
  }

  // Result distribution
  const resultCounts = {};
  for (const i of allDone) {
    const r = i.outcome.result || "unknown";
    resultCounts[r] = (resultCounts[r] || 0) + 1;
  }

  // Generate recommendations
  const recs = [];
  for (const [src, scores] of Object.entries(sourceScores)) {
    if (scores.total >= 3 && scores.well_scoped_ratio < 50) {
      const bad = Object.entries(scores)
        .filter(([k]) => !["total", "well_scoped_ratio", "well-scoped"].includes(k))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([k, v]) => `${k}(${v})`)
        .join(", ");
      recs.push(`Source "${src}" has ${scores.well_scoped_ratio}% well-scoped rate (${scores.total} items). Common issues: ${bad}`);
    }
  }

  // Trend: compare first half vs second half of recent window
  if (recent.length >= 10) {
    const mid = Math.floor(recent.length / 2);
    const firstHalf = recent.slice(0, mid);
    const secondHalf = recent.slice(mid);
    const firstWS = firstHalf.filter(i => i.outcome.quality === "well-scoped").length / firstHalf.length;
    const secondWS = secondHalf.filter(i => i.outcome.quality === "well-scoped").length / secondHalf.length;
    const delta = Math.round((secondWS - firstWS) * 100);
    if (Math.abs(delta) > 5) {
      recs.push(`Quality trend: ${delta > 0 ? "improving" : "declining"} (${Math.round(firstWS * 100)}% → ${Math.round(secondWS * 100)}% well-scoped)`);
    } else {
      recs.push(`Quality trend: stable at ${Math.round(secondWS * 100)}% well-scoped`);
    }
  }

  if (recs.length === 0) {
    recs.push("Queue quality is healthy across all sources.");
  }

  const report = {
    total_with_outcome: allDone.length,
    total_with_quality: withQuality.length,
    quality_distribution: qualityCounts,
    effort_distribution: effortCounts,
    result_distribution: resultCounts,
    source_scores: sourceScores,
    rolling_window: {
      size: windowSize,
      actual: recent.length,
      quality: recentQuality,
      source_quality: recentSourceQuality,
    },
    recommendations: recs,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("=== Work-Queue Outcome Quality Trend ===\n");
    console.log(`Items with outcome: ${allDone.length} | With quality: ${withQuality.length}\n`);

    console.log("Quality Distribution:");
    for (const [q, count] of Object.entries(qualityCounts).sort((a, b) => b[1] - a[1])) {
      const pct = Math.round((count / withQuality.length) * 100);
      const bar = "█".repeat(Math.ceil(count / 2));
      console.log(`  ${q.padEnd(20)} ${bar} ${count} (${pct}%)`);
    }

    console.log("\nEffort Distribution:");
    for (const [e, count] of Object.entries(effortCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${e.padEnd(12)} ${count}`);
    }

    console.log("\nResult Distribution:");
    for (const [r, count] of Object.entries(resultCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${r.padEnd(12)} ${count}`);
    }

    console.log("\nSource Scoreboard (well-scoped %):");
    const sorted = Object.entries(sourceScores).sort((a, b) => b[1].well_scoped_ratio - a[1].well_scoped_ratio);
    for (const [src, scores] of sorted) {
      const ratio = scores.well_scoped_ratio;
      const icon = ratio >= 70 ? "✓" : ratio >= 40 ? "~" : "✗";
      console.log(`  ${icon} ${src.padEnd(22)} ${ratio}% well-scoped (${scores.total} items)`);
    }

    console.log(`\nRolling Window (last ${recent.length} items):`);
    for (const [q, count] of Object.entries(recentQuality).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${q.padEnd(20)} ${count}`);
    }

    console.log("\nRecommendations:");
    for (const r of recs) {
      console.log(`  → ${r}`);
    }
  }
}

main();

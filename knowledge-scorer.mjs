#!/usr/bin/env node
/**
 * knowledge-scorer.mjs — Cross-session knowledge continuity scorer.
 *
 * Compares our knowledge patterns against other agents' published patterns,
 * scores knowledge diversity, and identifies gaps worth filling.
 *
 * Usage:
 *   node knowledge-scorer.mjs                # Full report (probe + score)
 *   node knowledge-scorer.mjs --json         # Machine-readable output
 *   node knowledge-scorer.mjs --local-only   # Score only our patterns (no probing)
 */

import { readFileSync } from "fs";
import { join } from "path";
import { fetchPatterns, discover } from "./agent-exchange-client.mjs";

const BASE = "/home/moltbot/moltbook-mcp";
const KB_PATH = join(BASE, "knowledge", "patterns.json");

// Known agent exchange endpoints to probe
const EXCHANGE_ENDPOINTS = [
  "http://terminalcraft.xyz:3847",
  // Add more as agents register exchange endpoints
];

// Platforms that might serve knowledge endpoints
const PLATFORM_PROBES = [
  "https://chatr.ai",
  "https://thecolony.cc",
  "https://grove.ctxly.app",
  "https://moltcities.org",
  "https://mydeadinternet.com",
  "https://claw-hub-bay.vercel.app",
  "https://clawsta.io",
  "https://devaintart.net",
  "https://nicepick.dev",
  "https://thingherder.com",
  "https://aicq.chat",
  "https://toku.agency",
  "https://pinchwork.dev",
  "https://strangerloops.com",
  "https://knowbster.com",
  "https://lobchan.ai",
];

function loadKnowledgeBase() {
  try {
    return JSON.parse(readFileSync(KB_PATH, "utf8"));
  } catch {
    return { patterns: [] };
  }
}

/** Score category diversity (0-100). Higher = more evenly distributed across categories. */
function scoreCategoryDiversity(patterns) {
  if (patterns.length === 0) return 0;
  const cats = {};
  for (const p of patterns) {
    const c = p.category || "unknown";
    cats[c] = (cats[c] || 0) + 1;
  }
  const catCount = Object.keys(cats).length;
  if (catCount <= 1) return 10;

  // Shannon entropy normalized to 0-100
  const total = patterns.length;
  let entropy = 0;
  for (const count of Object.values(cats)) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(catCount);
  return Math.round((entropy / maxEntropy) * 100);
}

/** Score source diversity (0-100). Higher = patterns from more diverse sources. */
function scoreSourceDiversity(patterns) {
  if (patterns.length === 0) return 0;
  const sources = new Set();
  for (const p of patterns) {
    // Normalize source to origin domain/type
    const src = p.source || "unknown";
    if (src.startsWith("self:")) sources.add("self");
    else if (src.startsWith("exchange:")) sources.add("exchange:" + src.split(":")[1]);
    else if (src.startsWith("github.com/")) sources.add(src.split("/").slice(0, 2).join("/"));
    else sources.add(src.split(":")[0]);
  }
  // More sources = higher score, with diminishing returns
  const count = sources.size;
  return Math.min(100, Math.round(Math.log2(count + 1) * 30));
}

/** Score confidence quality (0-100). Higher = more verified/consensus patterns. */
function scoreConfidenceQuality(patterns) {
  if (patterns.length === 0) return 0;
  const weights = { consensus: 4, verified: 3, observed: 1.5, speculative: 0.5 };
  let total = 0;
  for (const p of patterns) {
    total += weights[p.confidence] || 1;
  }
  const maxPossible = patterns.length * 4; // all consensus
  return Math.round((total / maxPossible) * 100);
}

/** Score freshness (0-100). Higher = more recently validated patterns. */
function scoreFreshness(patterns) {
  if (patterns.length === 0) return 0;
  const now = Date.now();
  const DAY = 86400000;
  let freshCount = 0;
  for (const p of patterns) {
    const validated = p.lastValidated || p.extractedAt;
    if (!validated) continue;
    const age = (now - new Date(validated).getTime()) / DAY;
    if (age < 7) freshCount += 1;
    else if (age < 30) freshCount += 0.7;
    else if (age < 90) freshCount += 0.3;
    else freshCount += 0.1;
  }
  return Math.round((freshCount / patterns.length) * 100);
}

/** Score tag coverage — how well patterns span different topics. */
function scoreTagCoverage(patterns) {
  if (patterns.length === 0) return 0;
  const tags = new Set();
  for (const p of patterns) {
    for (const t of (p.tags || [])) tags.add(t.toLowerCase());
  }
  // More unique tags = broader knowledge
  const count = tags.size;
  return Math.min(100, Math.round(Math.log2(count + 1) * 18));
}

/** Compute overall knowledge health score. */
function computeScore(patterns) {
  const categoryDiv = scoreCategoryDiversity(patterns);
  const sourceDiv = scoreSourceDiversity(patterns);
  const confidence = scoreConfidenceQuality(patterns);
  const freshness = scoreFreshness(patterns);
  const tagCoverage = scoreTagCoverage(patterns);

  // Weighted composite
  const overall = Math.round(
    categoryDiv * 0.2 +
    sourceDiv * 0.15 +
    confidence * 0.25 +
    freshness * 0.15 +
    tagCoverage * 0.25
  );

  return { overall, categoryDiv, sourceDiv, confidence, freshness, tagCoverage };
}

/** Identify knowledge gaps by comparing against remote patterns. */
function findGaps(ourPatterns, remotePatterns) {
  const ourTags = new Set();
  const ourTitlesLower = new Set();
  const ourCategories = {};

  for (const p of ourPatterns) {
    for (const t of (p.tags || [])) ourTags.add(t.toLowerCase());
    ourTitlesLower.add((p.title || "").toLowerCase());
    const c = p.category || "unknown";
    ourCategories[c] = (ourCategories[c] || 0) + 1;
  }

  const newTopics = []; // Tags they have that we don't
  const newPatterns = []; // Patterns we could import (by title novelty)
  const remoteTags = new Set();

  for (const rp of remotePatterns) {
    for (const t of (rp.tags || [])) {
      remoteTags.add(t.toLowerCase());
      if (!ourTags.has(t.toLowerCase())) {
        newTopics.push(t);
      }
    }
    const titleLower = (rp.title || "").toLowerCase();
    if (titleLower && !ourTitlesLower.has(titleLower)) {
      newPatterns.push({
        title: rp.title,
        category: rp.category,
        source: rp.source,
        tags: rp.tags || [],
      });
    }
  }

  // Dedupe new topics
  const uniqueNewTopics = [...new Set(newTopics)];

  return { newTopics: uniqueNewTopics, newPatterns, remoteTags: remoteTags.size };
}

/** Suggest actionable improvements based on scores. */
function generateRecommendations(scores, patterns, gaps) {
  const recs = [];

  if (scores.categoryDiv < 50) {
    const cats = {};
    for (const p of patterns) cats[p.category || "unknown"] = (cats[p.category || "unknown"] || 0) + 1;
    const sorted = Object.entries(cats).sort((a, b) => a[1] - b[1]);
    if (sorted.length > 0) {
      const weakest = sorted[0];
      recs.push(`Category diversity low (${scores.categoryDiv}/100). Weakest: "${weakest[0]}" with ${weakest[1]} patterns. Add patterns in underrepresented categories.`);
    }
  }

  if (scores.sourceDiv < 40) {
    recs.push(`Source diversity low (${scores.sourceDiv}/100). Most patterns are self-derived. Crawl more repos or exchange with other agents.`);
  }

  if (scores.freshness < 40) {
    recs.push(`Freshness low (${scores.freshness}/100). Many patterns haven't been validated recently. Run knowledge_prune to age stale patterns.`);
  }

  if (scores.confidence < 50) {
    recs.push(`Confidence quality low (${scores.confidence}/100). Many patterns are "observed" or "speculative". Validate key patterns to upgrade them.`);
  }

  if (gaps && gaps.newTopics.length > 3) {
    recs.push(`Found ${gaps.newTopics.length} topics from remote agents not in our knowledge: ${gaps.newTopics.slice(0, 5).join(", ")}${gaps.newTopics.length > 5 ? "..." : ""}`);
  }

  if (gaps && gaps.newPatterns.length > 0) {
    recs.push(`${gaps.newPatterns.length} importable patterns found from remote agents.`);
  }

  if (recs.length === 0) {
    recs.push("Knowledge base is well-balanced. Continue current trajectory.");
  }

  return recs;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const localOnly = args.includes("--local-only");

  // Load our knowledge
  const kb = loadKnowledgeBase();
  const ourPatterns = kb.patterns || [];

  // Score our patterns
  const scores = computeScore(ourPatterns);

  // Category breakdown
  const catBreakdown = {};
  for (const p of ourPatterns) {
    const c = p.category || "unknown";
    catBreakdown[c] = (catBreakdown[c] || 0) + 1;
  }

  // Probe remote agents (unless local-only)
  let remotePatterns = [];
  let agentsProbed = 0;
  let agentsResponded = 0;
  const agentResults = [];

  if (!localOnly) {
    const allUrls = [...EXCHANGE_ENDPOINTS, ...PLATFORM_PROBES];
    // Probe in parallel, limit concurrency
    const results = await Promise.allSettled(
      allUrls.map(async (url) => {
        const manifest = await discover(url, { timeout: 6000 });
        if (!manifest) return { url, status: "no_manifest" };
        const fp = await fetchPatterns(url, { timeout: 6000, manifest });
        if (!fp || fp.patterns.length === 0) return { url, status: "no_patterns", agent: manifest.agent || manifest.name };
        return { url, status: "ok", agent: fp.source, patternCount: fp.patterns.length, patterns: fp.patterns };
      })
    );

    for (const r of results) {
      agentsProbed++;
      if (r.status === "fulfilled" && r.value.status === "ok") {
        agentsResponded++;
        remotePatterns.push(...r.value.patterns);
        agentResults.push({ agent: r.value.agent, url: r.value.url, patterns: r.value.patternCount });
      }
    }
  }

  // Find gaps
  const gaps = remotePatterns.length > 0 ? findGaps(ourPatterns, remotePatterns) : null;

  // Generate recommendations
  const recs = generateRecommendations(scores, ourPatterns, gaps);

  // Build report
  const report = {
    timestamp: new Date().toISOString(),
    our_patterns: ourPatterns.length,
    scores,
    category_breakdown: catBreakdown,
    remote_probing: localOnly ? "skipped" : {
      probed: agentsProbed,
      responded: agentsResponded,
      remote_patterns: remotePatterns.length,
      agents: agentResults,
    },
    gaps: gaps || "no_remote_data",
    recommendations: recs,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("=== Knowledge Continuity Score ===\n");
    console.log(`Patterns: ${ourPatterns.length}`);
    console.log(`Overall Score: ${scores.overall}/100\n`);
    console.log("Dimensions:");
    console.log(`  Category Diversity:  ${scores.categoryDiv}/100`);
    console.log(`  Source Diversity:    ${scores.sourceDiv}/100`);
    console.log(`  Confidence Quality:  ${scores.confidence}/100`);
    console.log(`  Freshness:          ${scores.freshness}/100`);
    console.log(`  Tag Coverage:       ${scores.tagCoverage}/100`);

    console.log("\nCategory Breakdown:");
    for (const [cat, count] of Object.entries(catBreakdown).sort((a, b) => b[1] - a[1])) {
      const bar = "█".repeat(count);
      console.log(`  ${cat.padEnd(14)} ${bar} ${count}`);
    }

    if (!localOnly) {
      console.log(`\nRemote Probing: ${agentsProbed} endpoints, ${agentsResponded} responded`);
      for (const a of agentResults) {
        console.log(`  ${a.agent}: ${a.patterns} patterns (${a.url})`);
      }
    }

    if (gaps && gaps.newTopics.length > 0) {
      console.log(`\nNew Topics (${gaps.newTopics.length}): ${gaps.newTopics.slice(0, 10).join(", ")}`);
    }
    if (gaps && gaps.newPatterns.length > 0) {
      console.log(`Importable Patterns: ${gaps.newPatterns.length}`);
      for (const p of gaps.newPatterns.slice(0, 5)) {
        console.log(`  [${p.category || "?"}] ${p.title}`);
      }
      if (gaps.newPatterns.length > 5) console.log(`  ... and ${gaps.newPatterns.length - 5} more`);
    }

    console.log("\nRecommendations:");
    for (const r of recs) {
      console.log(`  → ${r}`);
    }
  }
}

main().catch(console.error);

#!/usr/bin/env node
/**
 * platform-picker.mjs — ROI-weighted platform selection (wq-245, d042).
 * Replaces pure random selection with weighted selection based on ROI scores.
 *
 * Usage:
 *   node platform-picker.mjs                    # Returns 3 weighted-random live platforms
 *   node platform-picker.mjs --count 5          # Returns 5 weighted-random platforms
 *   node platform-picker.mjs --exclude 4claw    # Exclude specific platform IDs
 *   node platform-picker.mjs --require pinchwork # Always include this platform
 *   node platform-picker.mjs --json             # Output as JSON
 *   node platform-picker.mjs --update           # Mark returned platforms as engaged
 *   node platform-picker.mjs --verbose          # Show weight calculations
 *
 * Weighting factors (combine multiplicatively, d042):
 *   1. Base weight = ROI score from analytics (default 30 for unknowns)
 *   2. Recency multiplier: >20 sessions: 2.0x, >10: 1.5x, <3: 0.5x
 *   3. Exploration bonus: <5 total writes: 1.5x
 *   4. Cost efficiency: <$0.05/write: 1.3x, >$0.15/write: 0.7x
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { analyzeEngagement } from "./providers/engagement-analytics.js";
import { getCachedLiveness } from "./lib/platform-liveness-cache.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REGISTRY_PATH = join(__dirname, "account-registry.json");
const CIRCUITS_PATH = join(__dirname, "platform-circuits.json");
const HISTORY_PATH = join(process.env.HOME || "/home/moltbot", ".config/moltbook/session-history.txt");
const MANDATE_PATH = join(process.env.HOME || "/home/moltbot", ".config/moltbook/picker-mandate.json");
const DEMOTIONS_PATH = join(__dirname, "picker-demotions.json");

function loadJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function getCurrentSession() {
  if (!existsSync(HISTORY_PATH)) return 0;
  try {
    const lines = readFileSync(HISTORY_PATH, "utf8").trim().split("\n");
    const lastLine = lines[lines.length - 1] || "";
    const match = lastLine.match(/s=(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch { return 0; }
}

function getCircuitStatus(circuits, platformId) {
  if (!circuits) return "healthy";
  const entry = circuits[platformId];
  if (!entry) return "healthy";
  if (entry.status === "open") return "open";
  return "healthy";
}

// Normalize platform names for ROI lookup
function normalizePlatformName(name) {
  const map = {
    "fourclaw": "4claw",
    "thecolony": "Colony",
    "pinchwork": "Pinchwork",
  };
  return map[name.toLowerCase()] || name;
}

function parseArgs(args) {
  const opts = {
    count: 3,
    exclude: [],
    require: [],
    json: false,
    update: false,
    verbose: false,
    recencyWindow: 3,
    mentionBoost: true,  // wq-500: mention boost on by default
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--count" && args[i + 1]) {
      opts.count = parseInt(args[++i], 10) || 3;
    } else if (arg === "--exclude" && args[i + 1]) {
      opts.exclude = args[++i].split(",").map(s => s.trim().toLowerCase());
    } else if (arg === "--require" && args[i + 1]) {
      opts.require = args[++i].split(",").map(s => s.trim().toLowerCase());
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--update") {
      opts.update = true;
    } else if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
    } else if (arg === "--recency" && args[i + 1]) {
      opts.recencyWindow = parseInt(args[++i], 10) || 3;
    } else if (arg === "--mention-boost") {
      opts.mentionBoost = true;
    } else if (arg === "--no-mention-boost") {
      opts.mentionBoost = false;  // wq-500: explicit opt-out
    }
  }
  return opts;
}

// Get ROI data from analytics
function getROIData() {
  try {
    const analytics = analyzeEngagement();
    if (!analytics?.platforms?.length) return {};

    const roiMap = {};
    for (const p of analytics.platforms) {
      const name = normalizePlatformName(p.platform);
      roiMap[name.toLowerCase()] = {
        score: p.roi_score || 30,
        writes: p.writes || 0,
        costPerWrite: p.cost_per_write,
        eSessions: p.e_sessions || 0,
      };
    }
    return roiMap;
  } catch {
    return {};
  }
}

// Calculate weight for a platform (d042 weighting factors)
function calculateWeight(acc, roiData, currentSession, verbose) {
  const id = acc.id.toLowerCase();
  const platform = acc.platform?.toLowerCase() || id;
  const roi = roiData[id] || roiData[platform] || { score: 30, writes: 0, costPerWrite: null, eSessions: 0 };

  // Factor 1: Base weight = ROI score (default 30)
  let baseWeight = Math.max(1, roi.score || 30);

  // Factor 2: Recency multiplier
  const lastEngaged = acc.last_engaged_session || 0;
  const sessionsSince = currentSession - lastEngaged;
  let recencyMultiplier = 1.0;
  if (sessionsSince > 20) recencyMultiplier = 2.0;
  else if (sessionsSince > 10) recencyMultiplier = 1.5;
  else if (sessionsSince < 3) recencyMultiplier = 0.5;

  // Factor 3: Exploration bonus (< 5 total writes)
  let explorationMultiplier = 1.0;
  if ((roi.writes || 0) < 5) explorationMultiplier = 1.5;

  // Factor 4: Cost efficiency
  let costMultiplier = 1.0;
  if (roi.costPerWrite !== null && roi.costPerWrite !== undefined) {
    if (roi.costPerWrite < 0.05) costMultiplier = 1.3;
    else if (roi.costPerWrite > 0.15) costMultiplier = 0.7;
  }

  // Combine multiplicatively, floor at 1
  const weight = Math.max(1, Math.round(baseWeight * recencyMultiplier * explorationMultiplier * costMultiplier));

  if (verbose) {
    console.error(`  ${acc.id}: base=${baseWeight} recency=${recencyMultiplier}x explore=${explorationMultiplier}x cost=${costMultiplier}x => ${weight}`);
  }

  return {
    weight,
    factors: {
      base: baseWeight,
      recency: recencyMultiplier,
      exploration: explorationMultiplier,
      cost: costMultiplier,
      sessionsSince,
      writes: roi.writes || 0,
      costPerWrite: roi.costPerWrite,
    }
  };
}

// Load unread mention counts per platform from mention-scan.mjs (wq-496)
function getMentionBoosts(verbose) {
  try {
    const scanPath = join(__dirname, "mention-scan.mjs");
    if (!existsSync(scanPath)) return {};
    const out = execSync(`node ${scanPath} --json`, { timeout: 15000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const data = JSON.parse(out);
    const boosts = {};
    for (const m of (data.mentions || [])) {
      const platform = m.platform.toLowerCase();
      if (!boosts[platform]) boosts[platform] = { count: 0, directCount: 0, maxScore: 0 };
      boosts[platform].count++;
      if (m.direct) boosts[platform].directCount++;
      if (m.score > boosts[platform].maxScore) boosts[platform].maxScore = m.score;
    }
    if (verbose) {
      const entries = Object.entries(boosts).filter(([, v]) => v.count > 0);
      if (entries.length > 0) {
        console.error(`Mention boosts: ${entries.map(([k, v]) => `${k}=${v.count} (${v.directCount} direct)`).join(", ")}`);
      }
    }
    return boosts;
  } catch {
    return {};
  }
}

// Weighted random selection without replacement
function weightedRandomSelect(items, count) {
  const selected = [];
  const remaining = [...items];

  while (selected.length < count && remaining.length > 0) {
    // Calculate total weight
    const totalWeight = remaining.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) break;

    // Random selection
    let random = Math.random() * totalWeight;
    let selectedIdx = 0;

    for (let i = 0; i < remaining.length; i++) {
      random -= remaining[i].weight;
      if (random <= 0) {
        selectedIdx = i;
        break;
      }
    }

    // Move selected item
    selected.push(remaining[selectedIdx]);
    remaining.splice(selectedIdx, 1);
  }

  return selected;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const registry = loadJSON(REGISTRY_PATH);
  const circuits = loadJSON(CIRCUITS_PATH) || {};
  const currentSession = getCurrentSession();
  const roiData = getROIData();

  if (!registry?.accounts) {
    console.error("Error: Could not load account-registry.json");
    process.exit(1);
  }

  const accounts = registry.accounts;

  if (opts.verbose) {
    console.error(`ROI-weighted platform selection (d042)`);
    console.error(`Current session: ${currentSession}, ROI data for ${Object.keys(roiData).length} platforms`);
    console.error(`Calculating weights...`);
  }

  // wq-576: Load picker demotions (platforms with repeated E session failures)
  const demotions = loadJSON(DEMOTIONS_PATH);
  const demotedIds = new Set((demotions?.demotions || []).map(d => d.id.toLowerCase()));
  if (opts.verbose && demotedIds.size > 0) {
    console.error(`Demoted from picker: ${[...demotedIds].join(", ")}`);
  }

  // Filter to working platforms + needs_probe platforms (d051)
  // needs_probe platforms are auto-promoted from services.json and need E session probing
  // Note: Check acc.status first for needs_probe because last_status may be "error" from prior health checks
  const working = accounts.filter(acc => {
    const lastStatus = acc.last_status || "unknown";
    const baseStatus = acc.status || "unknown";
    const isWorkingStatus = ["live", "creds_ok", "active"].includes(lastStatus);
    const isProbeStatus = baseStatus === "needs_probe";  // d051: check base status, not last_status
    if (!isWorkingStatus && !isProbeStatus) return false;

    const circuit = getCircuitStatus(circuits, acc.id);
    if (circuit === "open") return false;

    // wq-576: Skip platforms demoted due to repeated E session engagement failures
    if (demotedIds.has(acc.id.toLowerCase())) return false;

    // wq-504: Skip platforms known-unreachable from shared liveness cache
    const cached = getCachedLiveness(acc.id) || getCachedLiveness(acc.platform);
    if (cached && !cached.reachable) return false;

    if (opts.exclude.includes(acc.id.toLowerCase())) return false;
    if (opts.exclude.includes(acc.platform.toLowerCase())) return false;

    const lastEngaged = acc.last_engaged_session || 0;
    const sessionsSince = currentSession - lastEngaged;
    if (sessionsSince < opts.recencyWindow && !opts.require.includes(acc.id.toLowerCase())) {
      return false;
    }

    return true;
  });

  // Separate needs_probe platforms for special handling (d051)
  const needsProbe = working.filter(acc => acc.status === "needs_probe");

  // Separate required platforms
  const required = [];
  const pool = [];

  for (const acc of working) {
    if (opts.require.includes(acc.id.toLowerCase()) || opts.require.includes(acc.platform.toLowerCase())) {
      required.push(acc);
    } else {
      pool.push(acc);
    }
  }

  // Check if required platforms exist but weren't in working
  for (const reqId of opts.require) {
    const found = required.some(a => a.id.toLowerCase() === reqId || a.platform.toLowerCase() === reqId);
    if (!found) {
      const acc = accounts.find(a => a.id.toLowerCase() === reqId || a.platform.toLowerCase() === reqId);
      if (acc) {
        required.push({ ...acc, _warning: "not in working pool" });
      }
    }
  }

  // Load mention boosts if requested (wq-496)
  const mentionBoosts = opts.mentionBoost ? getMentionBoosts(opts.verbose) : {};

  // Calculate weights for pool
  const weighted = pool.map(acc => {
    const { weight, factors } = calculateWeight(acc, roiData, currentSession, opts.verbose);
    // Apply mention boost: direct @mentions get 3x, any mentions get 1.5x (wq-496)
    const id = acc.id.toLowerCase();
    const platform = acc.platform?.toLowerCase() || id;
    const boost = mentionBoosts[id] || mentionBoosts[platform];
    let mentionMultiplier = 1.0;
    if (boost) {
      if (boost.directCount > 0) mentionMultiplier = 3.0;
      else if (boost.count > 0) mentionMultiplier = 1.5;
      factors.mentionBoost = { count: boost.count, direct: boost.directCount, multiplier: mentionMultiplier };
    }
    const boostedWeight = Math.max(1, Math.round(weight * mentionMultiplier));
    return { acc, weight: boostedWeight, factors };
  });

  // Weighted random selection
  const remaining = opts.count - required.length;
  const selectedWeighted = weightedRandomSelect(weighted, Math.max(0, remaining));
  const selected = [...required, ...selectedWeighted.map(w => ({ ...w.acc, _weight: w.weight, _factors: w.factors }))];

  // Update last_engaged_session if requested
  if (opts.update && selected.length > 0) {
    for (const sel of selected) {
      const acc = accounts.find(a => a.id === sel.id);
      if (acc) acc.last_engaged_session = currentSession;
    }
    saveJSON(REGISTRY_PATH, registry);

    // Write picker mandate for compliance tracking (d048)
    const mandate = {
      session: currentSession,
      selected: selected.map(s => s.id),
      timestamp: new Date().toISOString(),
    };
    saveJSON(MANDATE_PATH, mandate);
    if (opts.verbose) {
      console.error(`Wrote picker mandate to ${MANDATE_PATH}`);
    }
  }

  // Output
  if (opts.json) {
    console.log(JSON.stringify(selected.map(acc => {
      const displayStatus = acc.last_status || acc.status;
      const needsProbe = acc.status === "needs_probe";  // d051: check base status field
      return {
        id: acc.id,
        platform: acc.platform,
        status: displayStatus,
        needs_probe: needsProbe,  // d051: flag for E session probe duty
        last_engaged: acc.last_engaged_session || null,
        notes: acc.notes || null,
        warning: acc._warning || null,
        weight: acc._weight || null,
        factors: acc._factors || null,
        test_url: acc.test?.url || null,  // d051: URL to probe
      };
    }), null, 2));
  } else {
    console.log("Selected " + selected.length + " platform(s) for engagement:\n");
    for (const acc of selected) {
      const displayStatus = acc.last_status || acc.status || "?";
      const needsProbe = acc.status === "needs_probe";  // d051: check base status field
      const lastEngaged = acc.last_engaged_session ? "last: s" + acc.last_engaged_session : "never engaged";
      const warning = acc._warning ? " [!] " + acc._warning : "";
      const weightInfo = acc._weight ? ` [w:${acc._weight}]` : "";
      const probeFlag = needsProbe ? " [NEEDS PROBE]" : "";
      console.log("  * " + acc.platform + " (" + acc.id + ") -- " + displayStatus + ", " + lastEngaged + weightInfo + probeFlag + warning);
      if (acc.notes) console.log("    " + acc.notes);
    }
    // d051: Show needs_probe count in pool stats
    console.log("\nPool stats: " + working.length + " working, " + pool.length + " available, " + needsProbe.length + " needs_probe, " + accounts.length + " total");
    if (opts.verbose) {
      console.log("\nWeight distribution:");
      const weights = weighted.map(w => w.weight);
      const min = Math.min(...weights);
      const max = Math.max(...weights);
      const avg = Math.round(weights.reduce((a, b) => a + b, 0) / weights.length);
      console.log(`  min=${min}, max=${max}, avg=${avg}`);
    }
  }
}

main();

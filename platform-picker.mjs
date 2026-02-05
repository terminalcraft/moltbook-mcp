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
import { analyzeEngagement } from "./providers/engagement-analytics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REGISTRY_PATH = join(__dirname, "account-registry.json");
const CIRCUITS_PATH = join(__dirname, "platform-circuits.json");
const HISTORY_PATH = join(process.env.HOME || "/home/moltbot", ".config/moltbook/session-history.txt");
const MANDATE_PATH = join(process.env.HOME || "/home/moltbot", ".config/moltbook/picker-mandate.json");

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

  // Filter to working platforms
  const working = accounts.filter(acc => {
    const status = acc.last_status || "unknown";
    if (!["live", "creds_ok", "active"].includes(status)) return false;

    const circuit = getCircuitStatus(circuits, acc.id);
    if (circuit === "open") return false;

    if (opts.exclude.includes(acc.id.toLowerCase())) return false;
    if (opts.exclude.includes(acc.platform.toLowerCase())) return false;

    const lastEngaged = acc.last_engaged_session || 0;
    const sessionsSince = currentSession - lastEngaged;
    if (sessionsSince < opts.recencyWindow && !opts.require.includes(acc.id.toLowerCase())) {
      return false;
    }

    return true;
  });

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

  // Calculate weights for pool
  const weighted = pool.map(acc => {
    const { weight, factors } = calculateWeight(acc, roiData, currentSession, opts.verbose);
    return { acc, weight, factors };
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
    console.log(JSON.stringify(selected.map(acc => ({
      id: acc.id,
      platform: acc.platform,
      status: acc.last_status,
      last_engaged: acc.last_engaged_session || null,
      notes: acc.notes || null,
      warning: acc._warning || null,
      weight: acc._weight || null,
      factors: acc._factors || null,
    })), null, 2));
  } else {
    console.log("Selected " + selected.length + " platform(s) for engagement:\n");
    for (const acc of selected) {
      const lastEngaged = acc.last_engaged_session ? "last: s" + acc.last_engaged_session : "never engaged";
      const warning = acc._warning ? " [!] " + acc._warning : "";
      const weightInfo = acc._weight ? ` [w:${acc._weight}]` : "";
      console.log("  * " + acc.platform + " (" + acc.id + ") -- " + (acc.last_status || "?") + ", " + lastEngaged + weightInfo + warning);
      if (acc.notes) console.log("    " + acc.notes);
    }
    console.log("\nPool stats: " + working.length + " working, " + pool.length + " available, " + accounts.length + " total");
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

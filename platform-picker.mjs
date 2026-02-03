#!/usr/bin/env node
/**
 * platform-picker.mjs — Random platform selection from working pool.
 * Replaces the tier system with fair random selection.
 *
 * Usage:
 *   node platform-picker.mjs                    # Returns 3 random live platforms
 *   node platform-picker.mjs --count 5          # Returns 5 random live platforms
 *   node platform-picker.mjs --exclude 4claw    # Exclude specific platform IDs
 *   node platform-picker.mjs --require pinchwork # Always include this platform
 *   node platform-picker.mjs --json             # Output as JSON
 *   node platform-picker.mjs --update           # Mark returned platforms as engaged
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REGISTRY_PATH = join(__dirname, "account-registry.json");
const CIRCUITS_PATH = join(__dirname, "platform-circuits.json");
const HISTORY_PATH = join(process.env.HOME || "/home/moltbot", ".config/moltbook/session-history.txt");

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
  // Read from session-history.txt, parse last line for s=NNN
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

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseArgs(args) {
  const opts = {
    count: 3,
    exclude: [],
    require: [],
    json: false,
    update: false,
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
    } else if (arg === "--recency" && args[i + 1]) {
      opts.recencyWindow = parseInt(args[++i], 10) || 3;
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const registry = loadJSON(REGISTRY_PATH);
  const circuits = loadJSON(CIRCUITS_PATH) || {};
  const currentSession = getCurrentSession();

  if (!registry?.accounts) {
    console.error("Error: Could not load account-registry.json");
    process.exit(1);
  }

  const accounts = registry.accounts;

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

  // Weighted shuffle: platforms not engaged in 10+ sessions get priority
  const weighted = pool.map(acc => {
    const lastEngaged = acc.last_engaged_session || 0;
    const sessionsSince = currentSession - lastEngaged;
    const weight = sessionsSince > 10 ? 3 : (sessionsSince > 5 ? 2 : 1);
    return { acc, weight };
  });

  const expanded = [];
  for (const { acc, weight } of weighted) {
    for (let i = 0; i < weight; i++) expanded.push(acc);
  }
  const shuffled = shuffle(expanded);

  // Deduplicate
  const seen = new Set();
  const deduped = [];
  for (const acc of shuffled) {
    if (!seen.has(acc.id)) {
      seen.add(acc.id);
      deduped.push(acc);
    }
  }

  // Select random platforms
  const remaining = opts.count - required.length;
  const selected = [...required, ...deduped.slice(0, Math.max(0, remaining))];

  // Update last_engaged_session if requested
  if (opts.update && selected.length > 0) {
    for (const sel of selected) {
      const acc = accounts.find(a => a.id === sel.id);
      if (acc) acc.last_engaged_session = currentSession;
    }
    saveJSON(REGISTRY_PATH, registry);
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
    })), null, 2));
  } else {
    console.log("Selected " + selected.length + " platform(s) for engagement:\n");
    for (const acc of selected) {
      const lastEngaged = acc.last_engaged_session ? "last: s" + acc.last_engaged_session : "never engaged";
      const warning = acc._warning ? " [!] " + acc._warning : "";
      console.log("  * " + acc.platform + " (" + acc.id + ") -- " + (acc.last_status || "?") + ", " + lastEngaged + warning);
      if (acc.notes) console.log("    " + acc.notes);
    }
    console.log("\nPool stats: " + working.length + " working, " + pool.length + " available, " + accounts.length + " total");
  }
}

main();

#!/usr/bin/env node
// generate-hook-manifest.mjs — Generates hooks/manifest.json with retirement metadata for d070.
// Re-runnable: overwrites manifest on each execution.
// Usage: node generate-hook-manifest.mjs

import { readdirSync, writeFileSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { join, basename } from "path";

const DIR = new URL(".", import.meta.url).pathname;
const PHASES = ["pre-session", "post-session"];
const MANIFEST_PATH = join(DIR, "hooks", "manifest.json");

// Parse hook-results JSONL files for last-triggered data
function getLastTriggered() {
  const map = {};
  for (const file of ["pre-hook-results.json", "hook-results.json"]) {
    const path = join(process.env.HOME, ".config/moltbook/logs", file);
    try {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      // Only check last 50 entries for performance
      const recent = lines.slice(-50);
      for (const line of recent) {
        try {
          const data = JSON.parse(line);
          const session = data.session || 0;
          for (const h of data.hooks || []) {
            if (h.status === "skip" || h.status === "budget_skip") continue;
            if (!map[h.hook] || session > map[h.hook]) {
              map[h.hook] = session;
            }
          }
        } catch {}
      }
    } catch {}
  }
  return map;
}

// Get git creation date for a file
function getCreatedDate(filepath) {
  try {
    return execSync(`git log --diff-filter=A --format='%aI' -- "${filepath}"`, {
      cwd: DIR, encoding: "utf8", timeout: 5000
    }).trim().split("\n").pop() || null;
  } catch { return null; }
}

// Detect session-type scope from filename suffix
function getScope(name) {
  if (name.endsWith("_B.sh")) return "B";
  if (name.endsWith("_E.sh")) return "E";
  if (name.endsWith("_R.sh")) return "R";
  if (name.endsWith("_A.sh")) return "A";
  return "all";
}

const lastTriggered = getLastTriggered();
const hooks = [];

for (const phase of PHASES) {
  const dir = join(DIR, "hooks", phase);
  let files;
  try { files = readdirSync(dir).filter(f => f.endsWith(".sh")).sort(); } catch { continue; }

  for (const name of files) {
    const filepath = join("hooks", phase, name);
    const created = getCreatedDate(filepath);
    hooks.push({
      name,
      phase,
      scope: getScope(name),
      created: created || "unknown",
      last_triggered_session: lastTriggered[name] || null,
    });
  }
}

const manifest = {
  version: 1,
  generated: new Date().toISOString(),
  total: hooks.length,
  hooks,
};

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Hook manifest: ${hooks.length} hooks written to hooks/manifest.json`);

// Report retirement candidates (not triggered in 50+ sessions)
const currentSession = parseInt(process.env.SESSION_NUM || "0");
if (currentSession > 0) {
  const stale = hooks.filter(h =>
    h.last_triggered_session !== null &&
    currentSession - h.last_triggered_session >= 50
  );
  if (stale.length > 0) {
    console.log(`Retirement candidates (50+ sessions since last trigger):`);
    for (const h of stale) {
      console.log(`  ${h.phase}/${h.name} — last triggered s${h.last_triggered_session} (${currentSession - h.last_triggered_session} sessions ago)`);
    }
  }
}

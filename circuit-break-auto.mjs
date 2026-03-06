#!/usr/bin/env node
/**
 * circuit-break-auto.mjs (wq-891)
 * Auto-demotes platforms with chronic substitution failures.
 *
 * When audit-stats.mjs reports circuit_break_recommended, this script
 * adds the candidates to picker-demotions.json automatically — closing
 * the loop from detection to remediation without a manual wq item.
 *
 * Usage:
 *   node circuit-break-auto.mjs              # Apply auto-demotions
 *   node circuit-break-auto.mjs --dry-run    # Preview without writing
 *   node circuit-break-auto.mjs --json       # JSON output
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEMOTIONS_PATH = join(__dirname, "picker-demotions.json");
const SESSION_NUM = process.env.SESSION_NUM || "unknown";

function loadJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function getSubstitutionRate() {
  try {
    const out = execSync("node audit-stats.mjs 2>/dev/null", {
      cwd: __dirname,
      encoding: "utf8",
      timeout: 15000,
    });
    const stats = JSON.parse(out);
    return stats.backup_substitution_rate || null;
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const jsonMode = args.includes("--json");

  const subRate = getSubstitutionRate();
  if (!subRate) {
    const msg = "Could not compute backup_substitution_rate";
    if (jsonMode) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    process.exit(1);
  }

  if (subRate.verdict !== "circuit_break_recommended") {
    const result = {
      verdict: subRate.verdict,
      action: "none",
      message: `No auto-demotion needed (verdict: ${subRate.verdict})`,
    };
    if (jsonMode) console.log(JSON.stringify(result, null, 2));
    else console.log(result.message);
    process.exit(0);
  }

  // Load current demotions
  const demotions = loadJSON(DEMOTIONS_PATH) || { demotions: [], weight_overrides: [] };
  const existingIds = new Set(demotions.demotions.map(d => d.id.toLowerCase()));

  const candidates = subRate.circuit_break_candidates || [];
  const added = [];
  const skipped = [];

  for (const candidate of candidates) {
    const id = candidate.platform.toLowerCase();
    if (existingIds.has(id)) {
      skipped.push({ id, reason: "already demoted" });
      continue;
    }

    const entry = {
      id,
      reason: `Auto circuit-break: substituted away ${candidate.count}/${subRate.sessions_checked} E sessions (${candidate.rate}). Chronic API failure detected by backup_substitution_rate audit.`,
      demoted_at: new Date().toISOString().slice(0, 10),
      demoted_by: `wq-891 auto (s${SESSION_NUM})`,
    };

    if (!dryRun) {
      demotions.demotions.push(entry);
      existingIds.add(id);
    }
    added.push(entry);
  }

  if (!dryRun && added.length > 0) {
    saveJSON(DEMOTIONS_PATH, demotions);
  }

  const result = {
    verdict: subRate.verdict,
    candidates: candidates.length,
    added: added.map(a => a.id),
    skipped: skipped.map(s => s.id),
    action: added.length > 0
      ? (dryRun ? `would demote ${added.length} platform(s)` : `demoted ${added.length} platform(s)`)
      : "all candidates already demoted",
    dry_run: dryRun,
  };

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (added.length > 0) {
      const verb = dryRun ? "Would demote" : "Auto-demoted";
      console.log(`${verb}: ${added.map(a => a.id).join(", ")}`);
      for (const entry of added) {
        console.log(`  ${entry.id}: ${entry.reason}`);
      }
    }
    if (skipped.length > 0) {
      console.log(`Already demoted: ${skipped.map(s => s.id).join(", ")}`);
    }
    if (added.length === 0 && skipped.length === 0) {
      console.log("No action needed.");
    }
  }
}

main();

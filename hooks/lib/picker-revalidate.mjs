#!/usr/bin/env node
/**
 * picker-revalidate.mjs — Real-time health revalidation of picker mandate (wq-956).
 *
 * Problem: platform-picker.mjs runs hours before E session starts. Platform health
 * can degrade between selection and execution, causing E sessions to waste time on
 * unreachable platforms and tanking picker compliance.
 *
 * Solution: At E session startup (after liveness probe updates platform-circuits.json),
 * re-check each mandated platform against fresh circuit data. If a selected platform
 * has consecutive_failures > 0, substitute it from the backup pool. Rewrite the
 * mandate so the E session sees only healthy platforms.
 *
 * Usage:
 *   node hooks/lib/picker-revalidate.mjs              # Revalidate and rewrite mandate
 *   node hooks/lib/picker-revalidate.mjs --dry-run    # Show what would change
 *   node hooks/lib/picker-revalidate.mjs --json       # JSON output
 *
 * Created: B#605 (wq-956, s1941)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_ROOT = join(__dirname, "..", "..");

const CONFIG_DIR = join(process.env.HOME || "/home/moltbot", ".config/moltbook");
const MANDATE_PATH = join(CONFIG_DIR, "picker-mandate.json");
const CIRCUITS_PATH = join(MCP_ROOT, "platform-circuits.json");

function loadJSON(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Check if a platform is healthy enough for engagement.
 * Returns { healthy: boolean, reason: string }
 */
export function checkPlatformHealth(circuits, platformId) {
  const entry = circuits[platformId];
  if (!entry) return { healthy: true, reason: "no circuit data" };

  const failures = entry.consecutive_failures || 0;
  if (failures === 0) return { healthy: true, reason: "no failures" };

  // Any consecutive failures make a platform risky at engagement time
  if (failures >= 3) {
    return { healthy: false, reason: `circuit open (${failures} consecutive failures)` };
  }
  // 1-2 failures: unhealthy but not circuit-broken
  return { healthy: false, reason: `${failures} consecutive failure(s)` };
}

/**
 * Revalidate picker mandate against fresh circuit data.
 * Returns { revalidated, substitutions, mandate } or null if no mandate.
 */
export function revalidateMandate(opts = {}) {
  const mandate = loadJSON(MANDATE_PATH);
  if (!mandate || !mandate.selected) {
    return { error: "no mandate found", revalidated: false };
  }

  const circuits = loadJSON(CIRCUITS_PATH) || {};
  const selected = [...mandate.selected];
  const backups = [...(mandate.backups || [])];
  const substitutions = [];
  let backupIdx = 0;

  // Check each selected platform against fresh circuit data
  for (let i = 0; i < selected.length; i++) {
    const platformId = selected[i];
    const health = checkPlatformHealth(circuits, platformId);

    if (!health.healthy) {
      // Find a healthy backup
      let substituted = false;
      while (backupIdx < backups.length) {
        const backup = backups[backupIdx];
        backupIdx++;
        const backupHealth = checkPlatformHealth(circuits, backup);
        if (backupHealth.healthy) {
          substitutions.push({
            original: platformId,
            replacement: backup,
            reason: health.reason,
          });
          selected[i] = backup;
          substituted = true;
          break;
        }
      }
      if (!substituted) {
        // No healthy backup available — keep original (E session will handle failure)
        substitutions.push({
          original: platformId,
          replacement: null,
          reason: `${health.reason}, no healthy backup available`,
        });
      }
    }
  }

  const result = {
    revalidated: true,
    substitutions,
    mandate: {
      ...mandate,
      selected,
      backups: backups.filter(b => !selected.includes(b)),
      revalidated_at: new Date().toISOString(),
      original_selected: mandate.selected,
    },
  };

  if (!opts.dryRun && substitutions.some(s => s.replacement !== null)) {
    saveJSON(MANDATE_PATH, result.mandate);
  }

  return result;
}

// CLI entry point
if (process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const jsonOut = args.includes("--json");

  const result = revalidateMandate({ dryRun });

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.error) {
      console.log(`[picker-revalidate] ${result.error}`);
    } else if (result.substitutions.length === 0) {
      console.log("[picker-revalidate] All mandated platforms healthy, no substitutions needed");
    } else {
      for (const sub of result.substitutions) {
        if (sub.replacement) {
          console.log(`[picker-revalidate] SUBSTITUTED: ${sub.original} → ${sub.replacement} (${sub.reason})`);
        } else {
          console.log(`[picker-revalidate] WARNING: ${sub.original} unhealthy (${sub.reason})`);
        }
      }
      if (!dryRun) {
        console.log("[picker-revalidate] Mandate rewritten with substitutions");
      } else {
        console.log("[picker-revalidate] Dry run — no changes written");
      }
    }
  }
}

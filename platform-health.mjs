#!/usr/bin/env node
// platform-health.mjs — Quick platform liveness pre-check for E sessions (wq-304)
// Shows which platforms have open circuits and recent failures
// Run: node platform-health.mjs

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_PATH = join(__dirname, "platform-circuits.json");
const REGISTRY_PATH = join(__dirname, "account-registry.json");
const STATE_DIR = join(process.env.HOME, ".config/moltbook");
const RECOVERY_EVENTS_PATH = join(STATE_DIR, "circuit-recovery-events.json");

function loadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

async function checkMoltchanNotifications() {
  const keyPath = join(__dirname, ".moltchan-key");
  if (!existsSync(keyPath)) return null;
  try {
    const key = readFileSync(keyPath, "utf8").trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://www.moltchan.org/api/v1/agents/me/notifications", {
      headers: { "Authorization": `Bearer ${key}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function main() {
  const circuits = loadJSON(CIRCUITS_PATH) || {};
  const registry = loadJSON(REGISTRY_PATH);

  const openCircuits = [];
  const halfOpen = [];
  const degraded = [];
  const defunct = [];  // wq-319: Track defunct platforms

  for (const [platformId, entry] of Object.entries(circuits)) {
    if (entry.status === "defunct") {
      // wq-319: Defunct platforms
      defunct.push({
        platform: platformId,
        reason: entry.defunct_reason || "unknown",
        defunctAt: entry.defunct_at
      });
    } else if (entry.status === "open") {
      openCircuits.push({
        platform: platformId,
        failures: entry.consecutive_failures,
        lastError: entry.last_error || "unknown",
        lastFailure: entry.last_failure
      });
    } else if (entry.status === "half-open") {
      halfOpen.push({
        platform: platformId,
        failures: entry.consecutive_failures,
        lastError: entry.last_error || "unknown"
      });
    } else if (entry.consecutive_failures >= 2) {
      // Track platforms that are showing signs of trouble
      degraded.push({
        platform: platformId,
        failures: entry.consecutive_failures
      });
    }
  }

  // Also check registry for auth issues
  const authIssues = [];
  if (registry && registry.accounts) {
    for (const acc of registry.accounts) {
      if (["no_creds", "bad_creds", "error"].includes(acc.last_status)) {
        authIssues.push({
          platform: acc.id,
          status: acc.last_status,
          notes: acc.notes?.slice(0, 50) || ""
        });
      }
    }
  }

  // wq-317: Check for recent recovery events (last 24 hours)
  const recentRecoveries = [];
  const recoveryEvents = loadJSON(RECOVERY_EVENTS_PATH);
  if (recoveryEvents && recoveryEvents.events) {
    const cutoff = Date.now() - 24 * 3600 * 1000;  // 24 hours ago
    for (const event of recoveryEvents.events) {
      const eventTime = new Date(event.timestamp).getTime();
      if (eventTime >= cutoff) {
        recentRecoveries.push(event);
      }
    }
  }

  // Output summary
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║              PLATFORM HEALTH PRE-CHECK                       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  // wq-385: Check Moltchan notifications
  const moltchanNotifs = await checkMoltchanNotifications();

  if (openCircuits.length === 0 && halfOpen.length === 0 && authIssues.length === 0 && recentRecoveries.length === 0 && (!moltchanNotifs || moltchanNotifs.unread === 0)) {
    console.log("✓ All platforms healthy. No open circuits, auth issues, or recent recoveries.");
    console.log();
    return;
  }

  // wq-317: Show recent recoveries FIRST (most actionable for E sessions)
  if (recentRecoveries.length > 0) {
    console.log(`🔄 RECENT RECOVERIES (${recentRecoveries.length}) — Consider re-engaging:`);
    for (const r of recentRecoveries) {
      const age = Math.round((Date.now() - new Date(r.timestamp).getTime()) / (3600 * 1000));
      const ageStr = age < 1 ? "<1h ago" : `${age}h ago`;
      console.log(`   • ${r.platform}: ${r.transition} (${ageStr}, s${r.session || "?"})`);
    }
    console.log();
  }

  // wq-385: Show Moltchan notifications
  if (moltchanNotifs && moltchanNotifs.unread > 0) {
    console.log(`📬 MOLTCHAN NOTIFICATIONS (${moltchanNotifs.unread} unread):`);
    for (const n of (moltchanNotifs.notifications || []).slice(0, 5)) {
      const type = n.type || "unknown";
      const preview = (n.message || n.content || "").slice(0, 60);
      console.log(`   • [${type}] ${preview}${preview.length >= 60 ? "..." : ""}`);
    }
    if (moltchanNotifs.total > 5) {
      console.log(`   ... and ${moltchanNotifs.total - 5} more`);
    }
    console.log();
  }

  if (openCircuits.length > 0) {
    console.log(`🔴 OPEN CIRCUITS (${openCircuits.length}) — Skip these platforms:`);
    for (const c of openCircuits) {
      const lastFailure = c.lastFailure ? new Date(c.lastFailure).toISOString().slice(0, 16) : "unknown";
      console.log(`   • ${c.platform}: ${c.failures} consecutive failures (${c.lastError}) [${lastFailure}]`);
    }
    console.log();
  }

  if (halfOpen.length > 0) {
    console.log(`🟡 HALF-OPEN (${halfOpen.length}) — May work, probe carefully:`);
    for (const c of halfOpen) {
      console.log(`   • ${c.platform}: ${c.failures} failures, recovering (${c.lastError})`);
    }
    console.log();
  }

  if (authIssues.length > 0) {
    console.log(`⚠️  AUTH ISSUES (${authIssues.length}) — Need credential attention:`);
    for (const a of authIssues) {
      console.log(`   • ${a.platform}: ${a.status}${a.notes ? ` — ${a.notes}` : ""}`);
    }
    console.log();
  }

  if (degraded.length > 0) {
    console.log(`📉 DEGRADED (${degraded.length}) — Showing instability:`);
    for (const d of degraded) {
      console.log(`   • ${d.platform}: ${d.failures} recent failures`);
    }
    console.log();
  }

  // wq-319: Show defunct platforms
  if (defunct.length > 0) {
    console.log(`☠️  DEFUNCT (${defunct.length}) — Permanently excluded:`);
    for (const d of defunct) {
      console.log(`   • ${d.platform}: ${d.reason}`);
    }
    console.log();
  }

  console.log("─────────────────────────────────────────────────────────────────");
  console.log("Recommendation: platform-picker.mjs already excludes open circuits and defunct platforms.");
  console.log("Focus engagement on picker selections; skip manual probes to excluded platforms.");
}

main().catch(e => { console.error(e.message); process.exit(1); });

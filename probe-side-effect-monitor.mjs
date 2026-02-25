#!/usr/bin/env node
/**
 * probe-side-effect-monitor.mjs — Narrow-scope side-effect monitor for platform probes
 *
 * Captures a deterministic behavioral fingerprint of probe execution:
 * - Which endpoints were called and in what order
 * - Response status codes and content types
 * - Whether registry was modified (and what fields changed)
 * - Timing profile (bucketed to reduce noise)
 *
 * Produces a "side-effect hash" that should be stable across identical probe runs.
 * Hash drift indicates changed probe behavior — a trust signal for behavioral reputation.
 *
 * wq-593: Proof-of-concept for @agent_god_couuas's behavioral reputation proposal.
 *
 * Usage:
 *   node probe-side-effect-monitor.mjs <platform-id>          # Run monitored probe
 *   node probe-side-effect-monitor.mjs --history <platform-id> # Show hash history
 *   node probe-side-effect-monitor.mjs --compare <platform-id> # Compare latest two
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(process.env.HOME || "/home/moltbot", ".config/moltbook");
const HISTORY_PATH = join(STATE_DIR, "probe-side-effects.json");
const REGISTRY_PATH = join(__dirname, "account-registry.json");

// --- Core types ---

/**
 * @typedef {Object} SideEffectTrace
 * @property {string} platform - Platform ID
 * @property {string} timestamp - ISO timestamp
 * @property {string} session - Session number
 * @property {ProbeEffect[]} effects - Ordered list of observed effects
 * @property {RegistryDelta|null} registryDelta - Changes to account-registry
 * @property {string} behaviorHash - SHA-256 of deterministic effect summary
 * @property {TimingProfile} timing - Bucketed timing data
 */

/**
 * @typedef {Object} ProbeEffect
 * @property {string} endpoint - Path probed
 * @property {number|null} status - HTTP status code
 * @property {string} contentType - Response content type
 * @property {boolean} success - Whether response was 2xx
 * @property {number} bodySize - Response body length
 * @property {string} bodyPrefix - First 64 chars of body (for fingerprinting)
 */

/**
 * @typedef {Object} RegistryDelta
 * @property {string[]} fieldsChanged - Which account fields were modified
 * @property {string|null} statusBefore - Previous status
 * @property {string|null} statusAfter - New status
 * @property {boolean} skillHashChanged - Whether skill.md hash changed
 */

/**
 * @typedef {Object} TimingProfile
 * @property {number} totalMs - Total probe duration
 * @property {string} bucket - "fast" (<2s), "normal" (2-10s), "slow" (>10s)
 */

// --- Utility ---

function loadJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

function saveJSON(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Snapshot the registry entry for a platform before probing.
 */
function snapshotRegistryEntry(platformId) {
  const registry = loadJSON(REGISTRY_PATH);
  if (!registry?.accounts) return null;
  const acc = registry.accounts.find(a => a.id === platformId);
  if (!acc) return null;
  return JSON.parse(JSON.stringify(acc)); // deep clone
}

/**
 * Diff two registry snapshots to compute a delta.
 */
function computeRegistryDelta(before, after) {
  if (!before || !after) return null;

  const fieldsChanged = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const bVal = JSON.stringify(before[key]);
    const aVal = JSON.stringify(after[key]);
    if (bVal !== aVal) fieldsChanged.push(key);
  }

  return {
    fieldsChanged,
    statusBefore: before.last_status || null,
    statusAfter: after.last_status || null,
    skillHashChanged: before.skill_hash !== after.skill_hash,
  };
}

/**
 * Convert probe results into a list of deterministic ProbeEffects.
 * Strips non-deterministic data (timestamps, full bodies) while keeping
 * enough to fingerprint behavior.
 */
function extractEffects(probeResults) {
  return probeResults.map(r => ({
    endpoint: r.path,
    status: r.status,
    contentType: r.contentType || "unknown",
    success: Boolean(r.isSuccess),
    bodySize: r.bodyPreview?.length || 0,
    bodyPrefix: (r.bodyPreview || "").substring(0, 64).replace(/\s+/g, " ").trim(),
  }));
}

/**
 * Compute a deterministic behavior hash from effects and registry delta.
 * The hash captures WHAT the probe did, not WHEN.
 */
function computeBehaviorHash(effects, registryDelta) {
  // Build a canonical representation — sorted effects by endpoint for stability
  const canonical = {
    effects: effects.map(e => ({
      endpoint: e.endpoint,
      status: e.status,
      contentType: e.contentType,
      success: e.success,
      // Body size bucketed to reduce noise from minor content changes
      bodySizeBucket: e.bodySize === 0 ? "empty" :
                      e.bodySize < 100 ? "small" :
                      e.bodySize < 1000 ? "medium" : "large",
    })).sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    registryFieldsChanged: registryDelta?.fieldsChanged?.sort() || [],
    skillHashChanged: registryDelta?.skillHashChanged || false,
  };

  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/**
 * Bucket timing into categories to reduce noise.
 */
function bucketTiming(ms) {
  if (ms < 2000) return "fast";
  if (ms < 10000) return "normal";
  return "slow";
}

// --- History management ---

function loadHistory() {
  return loadJSON(HISTORY_PATH) || { traces: [] };
}

function saveHistory(history) {
  // Keep max 100 traces total, max 20 per platform
  const platformCounts = {};
  const kept = [];

  // Most recent first
  const sorted = history.traces.sort((a, b) =>
    new Date(b.timestamp) - new Date(a.timestamp)
  );

  for (const trace of sorted) {
    if (kept.length >= 100) break;
    const count = platformCounts[trace.platform] || 0;
    if (count >= 20) continue;
    platformCounts[trace.platform] = count + 1;
    kept.push(trace);
  }

  history.traces = kept;
  saveJSON(HISTORY_PATH, history);
}

function addTrace(trace) {
  const history = loadHistory();
  history.traces.push(trace);
  saveHistory(history);
}

function getTracesForPlatform(platformId) {
  const history = loadHistory();
  return history.traces
    .filter(t => t.platform === platformId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

// --- Monitor entry point ---

/**
 * Run the side-effect monitor around a set of probe results.
 * Call this AFTER probing but BEFORE registry update — or provide
 * before/after registry snapshots manually.
 *
 * @param {string} platformId
 * @param {Object[]} probeResults - Array of probe endpoint results
 * @param {Object|null} registryBefore - Registry snapshot before probe
 * @param {Object|null} registryAfter - Registry snapshot after probe
 * @returns {SideEffectTrace}
 */
function monitorProbe(platformId, probeResults, registryBefore, registryAfter, durationMs = 0) {
  const effects = extractEffects(probeResults);
  const registryDelta = computeRegistryDelta(registryBefore, registryAfter);
  const behaviorHash = computeBehaviorHash(effects, registryDelta);

  const trace = {
    platform: platformId,
    timestamp: new Date().toISOString(),
    session: process.env.SESSION_NUM || "?",
    effects,
    registryDelta,
    behaviorHash,
    timing: {
      totalMs: durationMs,
      bucket: bucketTiming(durationMs),
    },
  };

  // Save to history
  addTrace(trace);

  return trace;
}

/**
 * Compare latest two traces for a platform.
 * Returns drift analysis.
 */
function compareLatest(platformId) {
  const traces = getTracesForPlatform(platformId);
  if (traces.length < 2) {
    return { hasDrift: false, reason: "insufficient_history", traces: traces.length };
  }

  const latest = traces[0];
  const previous = traces[1];
  const hashMatch = latest.behaviorHash === previous.behaviorHash;

  const result = {
    hasDrift: !hashMatch,
    platform: platformId,
    latest: {
      session: latest.session,
      timestamp: latest.timestamp,
      hash: latest.behaviorHash.substring(0, 16),
      timing: latest.timing.bucket,
    },
    previous: {
      session: previous.session,
      timestamp: previous.timestamp,
      hash: previous.behaviorHash.substring(0, 16),
      timing: previous.timing.bucket,
    },
  };

  if (!hashMatch) {
    // Find which effects changed
    const diffs = [];
    const latestEffects = new Map(latest.effects.map(e => [e.endpoint, e]));
    const prevEffects = new Map(previous.effects.map(e => [e.endpoint, e]));

    for (const [endpoint, le] of latestEffects) {
      const pe = prevEffects.get(endpoint);
      if (!pe) {
        diffs.push({ endpoint, change: "new_endpoint" });
      } else if (le.status !== pe.status) {
        diffs.push({ endpoint, change: "status_changed", from: pe.status, to: le.status });
      } else if (le.contentType !== pe.contentType) {
        diffs.push({ endpoint, change: "content_type_changed", from: pe.contentType, to: le.contentType });
      } else if (le.success !== pe.success) {
        diffs.push({ endpoint, change: "success_changed", from: pe.success, to: le.success });
      }
    }

    for (const endpoint of prevEffects.keys()) {
      if (!latestEffects.has(endpoint)) {
        diffs.push({ endpoint, change: "endpoint_removed" });
      }
    }

    // Check registry delta changes
    const lDelta = latest.registryDelta;
    const pDelta = previous.registryDelta;
    if (lDelta && pDelta) {
      const lFields = new Set(lDelta.fieldsChanged);
      const pFields = new Set(pDelta.fieldsChanged);
      const newFields = [...lFields].filter(f => !pFields.has(f));
      const removedFields = [...pFields].filter(f => !lFields.has(f));
      if (newFields.length > 0) diffs.push({ change: "new_registry_fields", fields: newFields });
      if (removedFields.length > 0) diffs.push({ change: "fewer_registry_fields", fields: removedFields });
    }

    result.diffs = diffs;
  }

  return result;
}

// --- Exports ---

export {
  monitorProbe,
  compareLatest,
  getTracesForPlatform,
  extractEffects,
  computeBehaviorHash,
  computeRegistryDelta,
  snapshotRegistryEntry,
  bucketTiming,
};

// --- CLI ---

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.log("Usage:");
  console.log("  node probe-side-effect-monitor.mjs <platform-id>          # Run monitored probe");
  console.log("  node probe-side-effect-monitor.mjs --history <platform-id> # Show hash history");
  console.log("  node probe-side-effect-monitor.mjs --compare <platform-id> # Compare latest two");
} else if (args.includes("--history")) {
  const platformId = args.find(a => !a.startsWith("--"));
  if (!platformId) { console.error("Error: provide a platform ID"); process.exit(1); }
  const traces = getTracesForPlatform(platformId);
  if (traces.length === 0) {
    console.log(`No side-effect history for ${platformId}`);
  } else {
    console.log(`Side-effect history for ${platformId} (${traces.length} traces):\n`);
    for (const t of traces) {
      console.log(`  s${t.session} ${t.timestamp.substring(0, 19)} hash=${t.behaviorHash.substring(0, 16)} timing=${t.timing.bucket}`);
    }
  }
} else if (args.includes("--compare")) {
  const platformId = args.find(a => !a.startsWith("--"));
  if (!platformId) { console.error("Error: provide a platform ID"); process.exit(1); }
  const result = compareLatest(platformId);
  console.log(JSON.stringify(result, null, 2));
} else {
  // Monitored probe — delegates to platform-probe.mjs logic
  // In practice, this is called programmatically via monitorProbe()
  // CLI mode just shows what would be captured
  const platformId = args[0];
  console.log(`Side-effect monitor ready for ${platformId}`);
  console.log("Use monitorProbe() programmatically after running platform-probe.mjs");
  console.log("Or use --history / --compare for existing traces.");
}

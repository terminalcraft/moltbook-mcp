#!/usr/bin/env node
/**
 * audit-picker-compliance.mjs — Check E session compliance with picker mandate (d048)
 *
 * Usage: node audit-picker-compliance.mjs [session_number]
 *
 * Compares picker-mandate.json (what was selected) with engagement-trace.json
 * (what was actually engaged). Logs violations and escalates after 3 consecutive.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(process.env.HOME || "/home/moltbot", ".config/moltbook");
const LOGS_DIR = join(CONFIG_DIR, "logs");
const MANDATE_PATH = join(CONFIG_DIR, "picker-mandate.json");
const TRACE_PATH = join(CONFIG_DIR, "engagement-trace.json");
const VIOLATIONS_LOG = join(LOGS_DIR, "picker-violations.log");
const COMPLIANCE_STATE_PATH = join(CONFIG_DIR, "picker-compliance-state.json");

function loadJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function appendLog(path, line) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n");
}

function extractEngagedPlatforms(trace) {
  // engagement-trace.json has various structures, try to extract platform IDs
  const engaged = new Set();

  // Handle array format (list of session traces)
  if (Array.isArray(trace)) {
    // Get the most recent trace entry
    const recent = trace[trace.length - 1];
    if (recent) return extractEngagedPlatforms(recent);
    return [];
  }

  // Check platforms_engaged array (string or object format)
  if (trace.platforms_engaged && Array.isArray(trace.platforms_engaged)) {
    for (const p of trace.platforms_engaged) {
      if (typeof p === 'string') engaged.add(p.toLowerCase());
      else if (p && p.platform) engaged.add(p.platform.toLowerCase());
    }
  }

  // Check interactions array
  if (trace.interactions) {
    for (const i of trace.interactions) {
      if (i.platform) engaged.add(i.platform.toLowerCase());
    }
  }

  // Check platforms object
  if (trace.platforms) {
    for (const p of Object.keys(trace.platforms)) {
      if (trace.platforms[p]?.engaged || trace.platforms[p]?.posts > 0) {
        engaged.add(p.toLowerCase());
      }
    }
  }

  // Check posts array
  if (trace.posts) {
    for (const p of trace.posts) {
      if (p.platform) engaged.add(p.platform.toLowerCase());
    }
  }

  // Check engagement array
  if (trace.engagement) {
    for (const e of trace.engagement) {
      if (e.platform) engaged.add(e.platform.toLowerCase());
    }
  }

  // Check threads_contributed array (skip if number)
  if (trace.threads_contributed && Array.isArray(trace.threads_contributed)) {
    for (const t of trace.threads_contributed) {
      if (t.platform) engaged.add(t.platform.toLowerCase());
    }
  }

  return Array.from(engaged);
}

function getSkippedPlatforms(trace) {
  // Handle array format
  if (Array.isArray(trace)) {
    const recent = trace[trace.length - 1];
    if (recent) return getSkippedPlatforms(recent);
    return [];
  }

  // Check for legitimate skips logged in trace
  if (trace.skipped_platforms && Array.isArray(trace.skipped_platforms)) {
    return trace.skipped_platforms.map(s => ({
      platform: (s.platform || s.id || "").toLowerCase(),
      reason: s.reason || "unknown",
    }));
  }
  return [];
}

function main() {
  const sessionArg = process.argv[2];
  const session = sessionArg ? parseInt(sessionArg, 10) : parseInt(process.env.SESSION_NUM || "0", 10);

  // Load mandate
  const mandate = loadJSON(MANDATE_PATH);
  if (!mandate) {
    console.log("No picker mandate found");
    return;
  }

  // Check mandate is for this session (or recent)
  if (mandate.session && Math.abs(mandate.session - session) > 5) {
    console.log(`Mandate is for session ${mandate.session}, current is ${session} — stale mandate, skipping`);
    return;
  }

  // Load trace
  let traceData = loadJSON(TRACE_PATH);
  if (!traceData) {
    console.log("No engagement trace found");
    return;
  }

  // If trace is an array, find the matching session entry or use most recent
  let trace = traceData;
  if (Array.isArray(traceData)) {
    // Try to find exact session match first
    trace = traceData.find(t => t.session === session);
    // If not found, use the most recent entry
    if (!trace) {
      trace = traceData[traceData.length - 1];
      if (trace && trace.session !== session) {
        console.log(`Note: Using trace from session ${trace.session} (closest to ${session})`);
      }
    }
  }

  if (!trace) {
    console.log("No matching engagement trace found");
    return;
  }

  const selected = (mandate.selected || []).map(s => s.toLowerCase());
  const engaged = extractEngagedPlatforms(trace);
  const skipped = getSkippedPlatforms(trace);
  const skippedIds = skipped.map(s => s.platform);

  // Calculate compliance
  // Platforms that were selected AND (engaged OR legitimately skipped) count as compliant
  const compliant = selected.filter(s => engaged.includes(s) || skippedIds.includes(s));
  const missed = selected.filter(s => !engaged.includes(s) && !skippedIds.includes(s));
  const complianceRate = selected.length > 0 ? compliant.length / selected.length : 1;
  const compliancePct = Math.round(complianceRate * 100);

  console.log(`Picker compliance check for session ${session}:`);
  console.log(`  Selected: ${selected.join(", ")}`);
  console.log(`  Engaged: ${engaged.join(", ") || "(none)"}`);
  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.map(s => `${s.platform} (${s.reason})`).join(", ")}`);
  }
  console.log(`  Compliance: ${compliancePct}% (${compliant.length}/${selected.length})`);

  // Load/update compliance state for escalation
  let state = loadJSON(COMPLIANCE_STATE_PATH) || {
    consecutive_violations: 0,
    last_violation_session: null,
    history: [],
  };

  const isViolation = compliancePct < 66; // Less than 66% = missed 2+ of 3

  // Record result
  const result = {
    session,
    selected,
    engaged,
    skipped: skippedIds,
    compliance_pct: compliancePct,
    violation: isViolation,
    timestamp: new Date().toISOString(),
  };

  // Keep last 10 results in history
  state.history = [result, ...(state.history || [])].slice(0, 10);

  if (isViolation) {
    console.log(`  ❌ VIOLATION: Missed ${missed.length} platform(s): ${missed.join(", ")}`);

    // Check if this is consecutive
    if (state.last_violation_session === null || state.last_violation_session === session - 5) {
      // Likely consecutive (E sessions are every 5th session in BBBRE rotation)
      state.consecutive_violations++;
    } else {
      // Reset if there was a gap
      const lastViolationDistance = session - state.last_violation_session;
      if (lastViolationDistance > 10) {
        state.consecutive_violations = 1;
      } else {
        state.consecutive_violations++;
      }
    }
    state.last_violation_session = session;

    // Log violation
    const logLine = `${new Date().toISOString()} | s${session} | selected: [${selected.join(",")}] | engaged: [${engaged.join(",")}] | compliance: ${compliancePct}% | VIOLATION | missed: [${missed.join(",")}]`;
    appendLog(VIOLATIONS_LOG, logLine);

    // Escalation after 3 consecutive violations
    if (state.consecutive_violations >= 3) {
      console.log(`  ⚠️ ESCALATION: ${state.consecutive_violations} consecutive violations`);

      // Add follow_up to engagement-trace.json
      if (trace) {
        trace.follow_ups = trace.follow_ups || [];
        trace.follow_ups.push({
          type: "picker_compliance_alert",
          message: `PICKER COMPLIANCE ALERT: ${state.consecutive_violations} consecutive violations. Next E session MUST engage picker selections or explain why each was skipped.`,
          added_session: session,
          timestamp: new Date().toISOString(),
        });
        saveJSON(TRACE_PATH, trace);
        console.log(`  Added follow_up to engagement-trace.json`);
      }
    }
  } else {
    console.log(`  ✓ Compliant`);
    // Reset consecutive counter on success
    state.consecutive_violations = 0;
  }

  // Save state
  saveJSON(COMPLIANCE_STATE_PATH, state);
}

main();

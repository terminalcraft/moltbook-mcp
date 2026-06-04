#!/usr/bin/env node
/**
 * engagement-surface-probe.mjs — Re-probe degraded platforms for engagement surfaces.
 *
 * Degraded platforms are live but lack known engagement APIs (comment/post/form).
 * This script fetches their HTML and scans for signals that they've added
 * engagement features since last check:
 *   - <form> or <textarea> elements
 *   - API route patterns in inline/linked JS (/api/comments, /api/posts, etc.)
 *   - Common framework patterns (Supabase realtime, Next.js API routes)
 *   - Input fields suggesting user interaction
 *
 * Designed to run every ~100 sessions via B session prehook.
 *
 * Usage:
 *   node lib/engagement-surface-probe.mjs [--dry] [--json] [--verbose]
 *
 * Created: wq-1056
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { safeFetch } from "./safe-fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, "..", "account-registry.json");
const SERVICES_PATH = join(__dirname, "..", "services.json");
const PROBE_STATE_PATH = join(__dirname, "..", "engagement-probe-state.json");

const PROBE_TIMEOUT = 8000;
const PROBE_INTERVAL_SESSIONS = 100; // Run every ~100 sessions

// Patterns that suggest engagement surfaces exist
const ENGAGEMENT_SIGNALS = [
  // HTML form elements
  { pattern: /<form[\s>]/i, signal: "html-form", weight: 2 },
  { pattern: /<textarea[\s>]/i, signal: "textarea", weight: 3 },
  { pattern: /contenteditable/i, signal: "contenteditable", weight: 2 },

  // Comment/post API patterns in JS or HTML
  { pattern: /\/api\/comments?/i, signal: "api-comments", weight: 5 },
  { pattern: /\/api\/posts?/i, signal: "api-posts", weight: 5 },
  { pattern: /\/api\/messages?/i, signal: "api-messages", weight: 4 },
  { pattern: /\/api\/reply/i, signal: "api-reply", weight: 5 },
  { pattern: /\/api\/submit/i, signal: "api-submit", weight: 4 },
  { pattern: /\/api\/v[0-9]+\/(comment|post|message|reply)/i, signal: "versioned-api", weight: 5 },

  // REST/GraphQL mutation patterns
  { pattern: /mutation\s*\{?\s*(create|add|post|submit)/i, signal: "graphql-mutation", weight: 4 },
  { pattern: /method:\s*["']POST["']/i, signal: "post-method", weight: 2 },
  { pattern: /fetch\(.*["']POST["']/i, signal: "fetch-post", weight: 3 },

  // Framework-specific patterns
  { pattern: /supabase.*\.insert/i, signal: "supabase-insert", weight: 4 },
  { pattern: /supabase.*realtime/i, signal: "supabase-realtime", weight: 3 },
  { pattern: /\.channel\(/i, signal: "realtime-channel", weight: 2 },

  // UI component patterns suggesting interaction
  { pattern: /CommentSection|CommentList|PostForm|ReplyBox/i, signal: "component-names", weight: 5 },
  { pattern: /placeholder=["'][^"']*comment|placeholder=["'][^"']*message/i, signal: "comment-placeholder", weight: 4 },
  { pattern: /type=["']submit["']/i, signal: "submit-button", weight: 2 },
];

// Minimum weight sum to flag as "engagement surface detected"
const DETECTION_THRESHOLD = 6;

function loadJSON(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Get list of degraded platforms to probe.
 * Returns platforms that are status:"degraded" in account-registry.json
 * and are not defunct/closed with human-intervention notes.
 */
function getDegradedPlatforms(registry) {
  if (!registry?.accounts) return [];
  return registry.accounts.filter(a =>
    a.status === "degraded" &&
    a.test?.url &&
    !/DNS NXDOMAIN|permanently down/i.test(a.notes || "")
  );
}

/**
 * Scan HTML content for engagement surface signals.
 */
function scanForEngagement(html) {
  const matches = [];
  let totalWeight = 0;

  for (const { pattern, signal, weight } of ENGAGEMENT_SIGNALS) {
    if (pattern.test(html)) {
      matches.push({ signal, weight });
      totalWeight += weight;
    }
  }

  return {
    detected: totalWeight >= DETECTION_THRESHOLD,
    totalWeight,
    matches,
  };
}

/**
 * Probe degraded platforms for engagement surfaces.
 * @param {Object} opts
 * @param {boolean} opts.dryRun - Don't write changes to disk
 * @param {number} opts.sessionNum - Current session number
 * @param {boolean} opts.force - Probe even if interval hasn't elapsed
 * @param {boolean} opts.verbose - Include HTML snippets in results
 * @returns {Object} probe results
 */
export async function probeEngagementSurfaces(opts = {}) {
  const { dryRun = false, sessionNum = 0, force = false, verbose = false } = opts;
  const registry = loadJSON(REGISTRY_PATH);
  const probeState = loadJSON(PROBE_STATE_PATH, { lastProbeSession: 0, results: {} });

  // Check if it's time to probe
  const sessionsSinceLastProbe = sessionNum - (probeState.lastProbeSession || 0);
  if (!force && sessionsSinceLastProbe < PROBE_INTERVAL_SESSIONS) {
    return {
      skipped: true,
      reason: `Only ${sessionsSinceLastProbe} sessions since last probe (threshold: ${PROBE_INTERVAL_SESSIONS})`,
      nextProbeAt: (probeState.lastProbeSession || 0) + PROBE_INTERVAL_SESSIONS,
    };
  }

  const platforms = getDegradedPlatforms(registry);
  if (platforms.length === 0) {
    return { probed: 0, detected: [], noChange: [], failed: [], skipped: false };
  }

  const detected = [];
  const noChange = [];
  const failed = [];
  const now = new Date().toISOString();

  const probePromises = platforms.map(async (account) => {
    const url = account.test.url;
    try {
      const resp = await safeFetch(url, {
        timeout: PROBE_TIMEOUT,
        bodyMode: "text",
        userAgent: "moltbook-engagement-probe/1.0",
      });

      if (resp.status < 200 || resp.status >= 400) {
        failed.push({ platform: account.id, reason: `HTTP ${resp.status}`, elapsed: resp.elapsed });
        return;
      }

      const html = resp.body || "";
      const scan = scanForEngagement(html);

      const result = {
        platform: account.id,
        url,
        scan,
        httpStatus: resp.status,
        elapsed: resp.elapsed,
        probedAt: now,
      };

      if (verbose && scan.detected) {
        result.htmlLength = html.length;
      }

      // Store per-platform probe result
      probeState.results[account.id] = {
        lastProbed: now,
        detected: scan.detected,
        weight: scan.totalWeight,
        signals: scan.matches.map(m => m.signal),
      };

      if (scan.detected) {
        detected.push(result);
        // Update account notes to flag for human/E-session review
        if (!dryRun) {
          account.notes = `${account.notes || ""} | engagement-probe s${sessionNum}: detected signals (weight=${scan.totalWeight}: ${scan.matches.map(m => m.signal).join(", ")}). Review for promotion.`.trim();
        }
      } else {
        noChange.push(result);
      }
    } catch (err) {
      failed.push({ platform: account.id, reason: err.message });
    }
  });

  await Promise.allSettled(probePromises);

  // Update probe state
  if (!dryRun) {
    probeState.lastProbeSession = sessionNum;
    probeState.lastProbeTime = now;
    saveJSON(PROBE_STATE_PATH, probeState);
    saveJSON(REGISTRY_PATH, registry);
  }

  return { probed: platforms.length, detected, noChange, failed, skipped: false };
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith("engagement-surface-probe.mjs")) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry");
  const jsonOutput = args.includes("--json");
  const verbose = args.includes("--verbose");
  const force = args.includes("--force");
  const sessionNum = parseInt(process.env.SESSION_NUM || "0", 10);

  probeEngagementSurfaces({ dryRun, sessionNum, force, verbose }).then(result => {
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.skipped) {
        console.log(`[engagement-probe] ${result.reason}`);
        return;
      }
      console.log(`[engagement-probe] Probed ${result.probed} degraded platforms`);
      if (result.detected.length) {
        console.log(`[engagement-probe] DETECTED engagement surfaces:`);
        for (const d of result.detected) {
          console.log(`  ${d.platform}: weight=${d.scan.totalWeight} signals=[${d.scan.matches.map(m => m.signal).join(", ")}]`);
        }
      }
      if (result.noChange.length) {
        console.log(`[engagement-probe] No change: ${result.noChange.map(r => r.platform).join(", ")}`);
      }
      if (result.failed.length) {
        console.log(`[engagement-probe] Failed: ${result.failed.map(f => `${f.platform} (${f.reason})`).join(", ")}`);
      }
      if (dryRun) console.log("[engagement-probe] (dry run — no changes written)");
    }
  }).catch(err => {
    console.error("[engagement-probe] Error:", err.message);
    process.exit(1);
  });
}

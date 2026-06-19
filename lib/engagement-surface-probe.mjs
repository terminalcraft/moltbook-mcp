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
const QUEUE_PATH = join(__dirname, "..", "work-queue.json");
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
  { pattern: /supabase.*\.rpc\s*\(/i, signal: "supabase-rpc", weight: 4 },
  { pattern: /supabase.*\.functions\.invoke\s*\(/i, signal: "supabase-edge-fn", weight: 4 },
  { pattern: /supabase.*realtime/i, signal: "supabase-realtime", weight: 3 },
  { pattern: /\.channel\(/i, signal: "realtime-channel", weight: 2 },

  // Firebase/Firestore write patterns (wq-1073)
  { pattern: /addDoc\s*\(/i, signal: "firestore-addDoc", weight: 4 },
  { pattern: /setDoc\s*\(/i, signal: "firestore-setDoc", weight: 4 },
  { pattern: /updateDoc\s*\(/i, signal: "firestore-updateDoc", weight: 4 },
  { pattern: /deleteDoc\s*\(/i, signal: "firestore-deleteDoc", weight: 3 },
  { pattern: /httpsCallable\s*\(/i, signal: "firebase-callable", weight: 4 },
  { pattern: /firebase.*\.push\s*\(/i, signal: "firebase-rtdb-push", weight: 4 },
  { pattern: /firebase.*\.set\s*\(/i, signal: "firebase-rtdb-set", weight: 3 },

  // Convex write patterns (wq-1077)
  { pattern: /useMutation\s*\(/i, signal: "convex-useMutation", weight: 4 },
  { pattern: /ctx\.db\.insert\s*\(/i, signal: "convex-db-insert", weight: 4 },
  { pattern: /ctx\.db\.patch\s*\(/i, signal: "convex-db-patch", weight: 4 },
  { pattern: /ctx\.db\.replace\s*\(/i, signal: "convex-db-replace", weight: 3 },
  { pattern: /ctx\.db\.delete\s*\(/i, signal: "convex-db-delete", weight: 3 },

  // Appwrite write patterns (wq-1077)
  { pattern: /databases\.createDocument\s*\(/i, signal: "appwrite-createDocument", weight: 4 },
  { pattern: /databases\.updateDocument\s*\(/i, signal: "appwrite-updateDocument", weight: 4 },
  { pattern: /databases\.deleteDocument\s*\(/i, signal: "appwrite-deleteDocument", weight: 3 },

  // PocketBase write patterns (wq-1077)
  { pattern: /pb\.collection\s*\([^)]*\)\.create\s*\(/i, signal: "pocketbase-create", weight: 4 },
  { pattern: /pb\.collection\s*\([^)]*\)\.update\s*\(/i, signal: "pocketbase-update", weight: 4 },
  { pattern: /pb\.collection\s*\([^)]*\)\.delete\s*\(/i, signal: "pocketbase-delete", weight: 3 },

  // Drizzle ORM write patterns (wq-1081)
  { pattern: /db\.insert\s*\([^)]*\)\.values\s*\(/i, signal: "drizzle-insert", weight: 4 },
  { pattern: /db\.update\s*\([^)]*\)\.set\s*\(/i, signal: "drizzle-update", weight: 4 },
  { pattern: /db\.delete\s*\([^)]*\)\.where\s*\(/i, signal: "drizzle-delete", weight: 3 },

  // Prisma ORM write patterns (wq-1081)
  { pattern: /prisma\.\w+\.create\s*\(/i, signal: "prisma-create", weight: 4 },
  { pattern: /prisma\.\w+\.update\s*\(/i, signal: "prisma-update", weight: 4 },
  { pattern: /prisma\.\w+\.upsert\s*\(/i, signal: "prisma-upsert", weight: 4 },
  { pattern: /prisma\.\w+\.delete\s*\(/i, signal: "prisma-delete", weight: 3 },
  { pattern: /prisma\.\w+\.createMany\s*\(/i, signal: "prisma-createMany", weight: 4 },

  // Kysely query builder write patterns (wq-1085)
  { pattern: /\.insertInto\s*\([^)]*\)\.values\s*\(/i, signal: "kysely-insert", weight: 4 },
  { pattern: /\.updateTable\s*\([^)]*\)\.set\s*\(/i, signal: "kysely-update", weight: 4 },
  { pattern: /\.deleteFrom\s*\([^)]*\)\.where\s*\(/i, signal: "kysely-delete", weight: 3 },

  // Knex query builder write patterns (wq-1085)
  { pattern: /knex\s*\([^)]*\)\.\w+.*\.insert\s*\(|knex\s*\([^)]*\)\.insert\s*\(/i, signal: "knex-insert", weight: 4 },
  { pattern: /knex\s*\([^)]*\)\.\w+.*\.update\s*\(|knex\s*\([^)]*\)\.update\s*\(/i, signal: "knex-update", weight: 4 },
  { pattern: /knex\s*\([^)]*\)\.\w+.*\.del\s*\(|knex\s*\([^)]*\)\.del\s*\(/i, signal: "knex-delete", weight: 3 },

  // UI component patterns suggesting interaction
  { pattern: /CommentSection|CommentList|PostForm|ReplyBox/i, signal: "component-names", weight: 5 },
  { pattern: /placeholder=["'][^"']*comment|placeholder=["'][^"']*message/i, signal: "comment-placeholder", weight: 4 },
  { pattern: /type=["']submit["']/i, signal: "submit-button", weight: 2 },

  // CSS selector + event handler patterns (SPA engagement surfaces, wq-1067)
  { pattern: /querySelector(?:All)?\s*\(\s*["'][^"']*\b(?:comment|reply|post|message|submit|form|input)\b/i, signal: "css-selector-engagement", weight: 3 },
  { pattern: /getElementById\s*\(\s*["'][^"']*\b(?:comment|reply|post|message|submit|form)\b/i, signal: "dom-id-engagement", weight: 3 },
  { pattern: /\$\(\s*["'][.#][^"']*\b(?:comment|reply|post|message|submit|form)\b/i, signal: "jquery-selector-engagement", weight: 3 },
  { pattern: /addEventListener\s*\(\s*["'](?:submit|input|change)["']/i, signal: "event-listener-form", weight: 2 },
  { pattern: /\.on\(\s*["'](?:submit|input|change)["']/i, signal: "jquery-event-form", weight: 2 },
];

// Minimum weight sum to flag as "engagement surface detected"
const DETECTION_THRESHOLD = 6;

// Max JS bundles to fetch per platform
const MAX_BUNDLES = 3;
const BUNDLE_TIMEOUT = 6000;
const MAX_BUNDLE_SIZE = 512 * 1024; // 512KB per bundle

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
 * Extract <script src="..."> URLs from HTML.
 * Returns absolute URLs, resolving relative paths against baseUrl.
 */
function extractScriptUrls(html, baseUrl) {
  const srcRe = /<script[^>]+\bsrc=["']([^"']+)["']/gi;
  const urls = [];
  let m;
  while ((m = srcRe.exec(html)) !== null) {
    const src = m[1];
    // Skip inline data URIs, analytics, and tiny shims
    if (/^data:|google|analytics|gtag|fbevents/i.test(src)) continue;
    try {
      urls.push(new URL(src, baseUrl).href);
    } catch { /* skip malformed */ }
  }
  return urls;
}

/**
 * Prioritize JS bundle URLs — prefer chunk/lazy-loaded bundles over vendor/framework.
 * Returns top N URLs most likely to contain app-specific API routes.
 */
function prioritizeBundles(urls, max) {
  // Score each URL: chunk files > generic app files > vendor/framework
  const scored = urls.map(url => {
    const name = url.split("/").pop() || "";
    let score = 1;
    if (/chunk|lazy|async/i.test(name)) score += 3;
    if (/app|main|index/i.test(name)) score += 2;
    if (/vendor|framework|react|vue|angular|polyfill|runtime/i.test(name)) score -= 2;
    if (/\.js$/i.test(name)) score += 1; // Prefer .js over .mjs etc.
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(s => s.url);
}

/**
 * Fetch and scan JS bundles for engagement signals.
 * Returns merged signal matches from all fetched bundles.
 */
async function scanJsBundles(scriptUrls, baseUrl) {
  const bundleUrls = prioritizeBundles(scriptUrls, MAX_BUNDLES);
  if (bundleUrls.length === 0) return { matches: [], totalWeight: 0, bundlesFetched: 0, bundleUrls: [] };

  const allMatches = [];
  const seenSignals = new Set();
  let totalWeight = 0;
  const fetchedUrls = [];

  const fetches = bundleUrls.map(async (url) => {
    try {
      const resp = await safeFetch(url, {
        timeout: BUNDLE_TIMEOUT,
        bodyMode: "text",
        maxBody: MAX_BUNDLE_SIZE,
        userAgent: "moltbook-engagement-probe/1.0",
      });
      if (resp.status >= 200 && resp.status < 400 && resp.body) {
        fetchedUrls.push(url);
        for (const { pattern, signal, weight } of ENGAGEMENT_SIGNALS) {
          if (!seenSignals.has(signal) && pattern.test(resp.body)) {
            seenSignals.add(signal);
            allMatches.push({ signal: `js:${signal}`, weight, source: url.split("/").pop() });
            totalWeight += weight;
          }
        }
      }
    } catch { /* skip failed bundle fetches */ }
  });

  await Promise.allSettled(fetches);
  return { matches: allMatches, totalWeight, bundlesFetched: fetchedUrls.length, bundleUrls: fetchedUrls };
}

/**
 * Scan HTML content for engagement surface signals.
 * Optionally scans JS bundles referenced in <script> tags.
 */
function scanForEngagement(html, bundleScan = null) {
  const matches = [];
  let totalWeight = 0;

  for (const { pattern, signal, weight } of ENGAGEMENT_SIGNALS) {
    if (pattern.test(html)) {
      matches.push({ signal, weight });
      totalWeight += weight;
    }
  }

  // Merge JS bundle scan results
  if (bundleScan && bundleScan.matches.length > 0) {
    const htmlSignals = new Set(matches.map(m => m.signal));
    for (const bm of bundleScan.matches) {
      // Avoid double-counting signals found in both HTML and JS
      const baseSignal = bm.signal.replace(/^js:/, "");
      if (!htmlSignals.has(baseSignal)) {
        matches.push(bm);
        totalWeight += bm.weight;
      }
    }
  }

  return {
    detected: totalWeight >= DETECTION_THRESHOLD,
    totalWeight,
    matches,
    bundlesFetched: bundleScan?.bundlesFetched || 0,
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
// Exported for testing
export { extractScriptUrls, prioritizeBundles, scanForEngagement, ENGAGEMENT_SIGNALS, DETECTION_THRESHOLD };

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

      // Extract and scan JS bundles for SPA API patterns
      const scriptUrls = extractScriptUrls(html, url);
      const bundleScan = scriptUrls.length > 0
        ? await scanJsBundles(scriptUrls, url)
        : null;
      const scan = scanForEngagement(html, bundleScan);

      const result = {
        platform: account.id,
        url,
        scan,
        httpStatus: resp.status,
        elapsed: resp.elapsed,
        probedAt: now,
      };

      if (verbose) {
        result.htmlLength = html.length;
        result.scriptUrls = scriptUrls.length;
        if (bundleScan) {
          result.bundlesFetched = bundleScan.bundlesFetched;
          result.bundleUrls = bundleScan.bundleUrls;
        }
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

  // Auto-create work-queue items for detected platforms (wq-1061)
  const createdItems = [];
  if (!dryRun && detected.length > 0) {
    const wq = loadJSON(QUEUE_PATH, { queue: [] });
    const existingTitles = wq.queue.map(item => item.title);
    const maxId = wq.queue.reduce((max, item) => {
      const num = parseInt((item.id || "").replace("wq-", ""), 10);
      return num > max ? num : max;
    }, 0);
    let nextId = maxId;

    for (const d of detected) {
      const title = `Promote ${d.platform}: engagement signals detected (weight=${d.scan.totalWeight})`;
      // Check for existing items mentioning this platform (both title and description)
      const platformLower = d.platform.toLowerCase();
      const alreadyQueued = wq.queue.some(item =>
        item.status !== "done" && item.status !== "retired" &&
        (item.title.toLowerCase().includes(platformLower) ||
         (item.description || "").toLowerCase().includes(platformLower))
      );
      if (alreadyQueued) continue;

      nextId++;
      const id = `wq-${String(nextId).padStart(3, "0")}`;
      const signals = d.scan.matches.map(m => m.signal).join(", ");
      const item = {
        id,
        title,
        description: `(auto-probe ~s${sessionNum}): ${d.platform} responded HTTP ${d.httpStatus} at ${d.url}. ` +
          `Engagement signals detected (weight=${d.scan.totalWeight}: ${signals}). ` +
          `Verify engagement surface is functional and re-enable in picker if appropriate.`,
        priority: nextId,
        status: "pending",
        added: now.split("T")[0],
        source: "engagement-probe-auto",
        tags: ["platform-promote"],
        commits: [],
      };
      wq.queue.push(item);
      existingTitles.push(title);
      createdItems.push({ id, platform: d.platform, weight: d.scan.totalWeight });
    }

    if (createdItems.length > 0) {
      saveJSON(QUEUE_PATH, wq);
    }
  }

  return { probed: platforms.length, detected, noChange, failed, skipped: false, createdItems };
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
        if (result.createdItems && result.createdItems.length > 0) {
          console.log(`[engagement-probe] Auto-created work-queue items: ${result.createdItems.map(ci => `${ci.id} (${ci.platform})`).join(", ")}`);
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

#!/usr/bin/env node
/**
 * service-liveness.mjs — Automated liveness checker for services.json URLs.
 *
 * Usage:
 *   node service-liveness.mjs                # Check all non-rejected services
 *   node service-liveness.mjs --all          # Check ALL services including rejected
 *   node service-liveness.mjs --json         # Machine-readable JSON output
 *   node service-liveness.mjs --update       # Update services.json with results
 *   node service-liveness.mjs --probe-tld    # Probe TLD variants on DNS failure (wq-127)
 *
 * Checks HTTP status of each service URL and reports:
 * - alive (2xx/3xx), degraded (4xx/5xx), down (timeout/connection error)
 *
 * TLD probing (--probe-tld): When a URL fails with DNS error, tries common TLD
 * variants (.ai, .io, .com, .dev, .app) to find working alternatives.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { safeFetch } from "./lib/safe-fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_PATH = resolve(__dirname, "services.json");
const TIMING_PATH = resolve(homedir(), ".config", "moltbook", "service-liveness-timing.json"); // wq-678
const FETCH_TIMEOUT = 3000; // Reduced from 8s — liveness only needs reachability (wq-598)

// TLD variants to probe when a URL fails (d033 gap fix - wq-127)
const TLD_VARIANTS = [".ai", ".io", ".com", ".dev", ".app", ".xyz", ".net", ".org"];

// wq-678: timing telemetry
const wallStart = performance.now();

// --- Args ---
const args = process.argv.slice(2);
const flagAll = args.includes("--all");
const flagJson = args.includes("--json");
const flagUpdate = args.includes("--update");
const flagProbeTld = args.includes("--probe-tld"); // wq-127: probe TLD variants on DNS failure
const flagDepth = args.includes("--depth"); // wq-658: compute probe-depth metric (1-4)

// Parse --session N flag for timing telemetry (mirrors engagement-liveness pattern)
const sessionIdx = args.indexOf("--session");
const sessionNum = (sessionIdx !== -1 && args[sessionIdx + 1])
  ? parseInt(args[sessionIdx + 1]) || 0
  : parseInt(process.env.SESSION_NUM) || 0;

// --- Helpers ---

async function checkUrl(url) {
  const result = await safeFetch(url, {
    timeout: FETCH_TIMEOUT,
    bodyMode: "none",
    userAgent: "moltbook-liveness/1.0",
  });

  const status = result.status;
  const elapsed = result.elapsed;

  if (status === 0) return { alive: false, status: 0, elapsed, error: result.error || "timeout" };
  if (status >= 200 && status < 400) return { alive: true, status, elapsed };
  return { alive: false, status, elapsed, error: `HTTP ${status}` };
}

/**
 * Compute probe-depth metric for a live URL (wq-658).
 * Level 1: HTTP alive (2xx/3xx) — already confirmed by caller
 * Level 2: Returns meaningful content (body > 500 bytes, not just error/empty)
 * Level 3: API endpoint responds (at least one of /api, /health, /api-docs returns 2xx)
 * Level 4: Write-capable endpoint found (/register, /api/register, POST accepts)
 * Returns { depth: 1-4, details: string[] }
 */
const DEPTH_API_ENDPOINTS = ["/api", "/health", "/api-docs", "/openapi.json", "/.well-known/ai-plugin.json"];
const DEPTH_WRITE_ENDPOINTS = ["/register", "/api/register", "/api/v1/agents/register"];

async function computeProbeDepth(url) {
  const details = ["L1: HTTP alive"];
  let depth = 1;

  // Level 2: meaningful content check
  try {
    const bodyResult = await safeFetch(url, {
      timeout: FETCH_TIMEOUT,
      bodyMode: "text",
      userAgent: "moltbook-liveness/1.0",
      maxBody: 64 * 1024,
    });
    const bodyLen = (bodyResult.body || "").length;
    if (bodyLen > 500) {
      depth = 2;
      details.push(`L2: meaningful content (${bodyLen} bytes)`);
    } else {
      details.push(`L2: thin content (${bodyLen} bytes)`);
    }
  } catch {
    details.push("L2: body fetch failed");
  }

  // Level 3: API endpoint check
  const base = url.replace(/\/+$/, "");
  let apiFound = false;
  for (const ep of DEPTH_API_ENDPOINTS) {
    try {
      const r = await safeFetch(base + ep, {
        timeout: FETCH_TIMEOUT,
        bodyMode: "none",
        userAgent: "moltbook-liveness/1.0",
      });
      if (r.status >= 200 && r.status < 400) {
        apiFound = true;
        details.push(`L3: API responds (${ep} → ${r.status})`);
        break;
      }
    } catch { /* skip */ }
  }
  if (apiFound) {
    depth = 3;
  } else {
    details.push("L3: no API endpoints found");
  }

  // Level 4: write-capable endpoint check
  if (depth >= 2) {
    let writeFound = false;
    for (const ep of DEPTH_WRITE_ENDPOINTS) {
      try {
        const r = await safeFetch(base + ep, {
          timeout: FETCH_TIMEOUT,
          bodyMode: "none",
          userAgent: "moltbook-liveness/1.0",
        });
        // 2xx, 3xx, or 405 (Method Not Allowed = endpoint exists but needs POST)
        if ((r.status >= 200 && r.status < 400) || r.status === 405) {
          writeFound = true;
          details.push(`L4: write endpoint found (${ep} → ${r.status})`);
          break;
        }
      } catch { /* skip */ }
    }
    if (writeFound) {
      depth = 4;
    } else {
      details.push("L4: no write endpoints found");
    }
  }

  return { depth, details };
}

/**
 * Probe TLD variants when a URL fails due to DNS (wq-127).
 * Returns the first working variant or null.
 */
async function probeTldVariants(url) {
  try {
    const parsed = new URL(url);
    const hostParts = parsed.hostname.split(".");
    if (hostParts.length < 2) return null;

    // Extract base domain without TLD (e.g., "chan.alphakek" from "chan.alphakek.io")
    const currentTld = "." + hostParts.pop();
    const baseDomain = hostParts.join(".");

    for (const tld of TLD_VARIANTS) {
      if (tld === currentTld) continue; // Skip current TLD
      const variantHost = baseDomain + tld;
      const variantUrl = `${parsed.protocol}//${variantHost}${parsed.pathname}`;

      const check = await safeFetch(variantUrl, {
        timeout: FETCH_TIMEOUT,
        bodyMode: "none",
        userAgent: "moltbook-liveness/1.0",
      });

      if (check.status >= 200 && check.status < 400) {
        return { url: variantUrl, tld, status: check.status };
      }
    }
  } catch (e) {
    // URL parsing failed, skip
  }
  return null;
}

// --- Main ---

const data = JSON.parse(readFileSync(SERVICES_PATH, "utf8"));
const services = flagAll
  ? data.services
  : data.services.filter(s => s.status !== "rejected");

const results = [];
const total = services.length;
let done = 0;

// wq-668: Hard global timeout — force exit if probes hang (same pattern as engagement-liveness)
const GLOBAL_TIMEOUT = 8000;
const forceExitTimer = setTimeout(() => {
  process.stderr.write(`[!] Hard timeout (${GLOBAL_TIMEOUT}ms) — force exiting\n`);
  process.exit(0);
}, GLOBAL_TIMEOUT);

// wq-598: Batch probes with Promise.allSettled for concurrency (was sequential)
// wq-668: Increased from 10→20 to reduce batch count (37 services = 2 batches instead of 4)
const CONCURRENCY = 20;
for (let batch = 0; batch < services.length; batch += CONCURRENCY) {
  const slice = services.slice(batch, batch + CONCURRENCY);
  const checks = await Promise.allSettled(
    slice.map(async (svc) => {
      const check = await checkUrl(svc.url);
      let liveness = check.alive ? "alive" : check.error === "timeout" ? "down" : "error";
      let tldSuggestion = null;

      // wq-127: Probe TLD variants on DNS failure
      if (flagProbeTld && !check.alive && check.status === 0) {
        const variant = await probeTldVariants(svc.url);
        if (variant) {
          tldSuggestion = variant;
          if (!flagJson) {
            process.stderr.write(`    → TLD variant found: ${variant.url} (HTTP ${variant.status})\n`);
          }
        }
      }

      // wq-658: Probe depth metric
      let probeDepth = null;
      if (flagDepth && check.alive) {
        probeDepth = await computeProbeDepth(svc.url);
      }

      return {
        id: svc.id,
        name: svc.name,
        url: svc.url,
        currentStatus: svc.status,
        liveness,
        httpStatus: check.status,
        elapsed: Math.round(check.elapsed * 1000),
        error: check.error || null,
        tldSuggestion: tldSuggestion ? tldSuggestion.url : null,
        probeDepth: probeDepth ? probeDepth.depth : (check.alive ? 1 : 0),
        probeDetails: probeDepth ? probeDepth.details : null,
      };
    })
  );

  for (const settled of checks) {
    const r = settled.status === "fulfilled" ? settled.value : {
      id: slice[checks.indexOf(settled)]?.id,
      name: "?",
      url: "?",
      currentStatus: "?",
      liveness: "error",
      httpStatus: 0,
      elapsed: 0,
      error: settled.reason?.message || "promise rejected",
      tldSuggestion: null,
    };
    results.push(r);
    done++;
    if (!flagJson) {
      const icon = r.liveness === "alive" ? "✓" : "✗";
      const code = r.httpStatus || "---";
      const depthTag = flagDepth && r.probeDepth ? ` D${r.probeDepth}` : "";
      process.stderr.write(`[${done}/${total}] ${icon} ${code} ${r.elapsed}ms${depthTag} ${r.name} (${r.url})\n`);
    }
  }
}
clearTimeout(forceExitTimer);

// wq-678: Log timing telemetry to separate file (mirrors wq-676 engagement-liveness pattern).
// Appends to service-liveness-timing.json so A sessions can track probe latency trends.
{
  const wallMs = Math.round(performance.now() - wallStart);
  const probed = results.map(r => ({
    name: r.name,
    ms: r.elapsed || 0,
    ok: r.liveness === "alive",
  }));
  const timingEntry = {
    ts: new Date().toISOString(),
    session: sessionNum,
    wallMs,
    total: results.length,
    alive: results.filter(r => r.liveness === "alive").length,
    down: results.filter(r => r.liveness !== "alive").length,
    avgMs: probed.length > 0 ? Math.round(probed.reduce((a, p) => a + p.ms, 0) / probed.length) : 0,
    p95Ms: probed.length > 0 ? probed.map(p => p.ms).sort((a, b) => a - b)[Math.floor(probed.length * 0.95)] : 0,
    platforms: probed,
  };
  try {
    mkdirSync(dirname(TIMING_PATH), { recursive: true });
    const existing = existsSync(TIMING_PATH)
      ? JSON.parse(readFileSync(TIMING_PATH, "utf8"))
      : { entries: [] };
    existing.entries.push(timingEntry);
    // Keep last 100 entries to bound file size
    if (existing.entries.length > 100) existing.entries = existing.entries.slice(-100);
    writeFileSync(TIMING_PATH, JSON.stringify(existing, null, 2) + "\n");
  } catch { /* non-critical — don't fail probe on timing write error */ }
}

// Summary
const alive = results.filter(r => r.liveness === "alive").length;
const down = results.filter(r => r.liveness === "down").length;
const errored = results.filter(r => r.liveness === "error").length;

if (flagJson) {
  const output = { checked: new Date().toISOString(), total, alive, down, errored, results };
  if (flagDepth) {
    output.depthDistribution = { L1: 0, L2: 0, L3: 0, L4: 0 };
    for (const r of results) {
      if (r.probeDepth >= 1 && r.probeDepth <= 4) output.depthDistribution[`L${r.probeDepth}`]++;
    }
  }
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`\n--- Liveness Report ---`);
  console.log(`Total: ${total} | Alive: ${alive} | Down: ${down} | Error: ${errored}`);
  if (flagDepth) {
    const depthCounts = [0, 0, 0, 0, 0]; // index 0-4
    for (const r of results) depthCounts[r.probeDepth || 0]++;
    console.log(`Depth: L1=${depthCounts[1]} L2=${depthCounts[2]} L3=${depthCounts[3]} L4=${depthCounts[4]}`);
  }
  console.log();
  if (down > 0) {
    console.log("DOWN:");
    results.filter(r => r.liveness === "down").forEach(r => console.log(`  ${r.name} — ${r.url}`));
  }
  if (errored > 0) {
    console.log("ERROR:");
    results.filter(r => r.liveness === "error").forEach(r => console.log(`  ${r.name} — ${r.url} (${r.error})`));
  }
  if (down === 0 && errored === 0) {
    console.log("All services alive.");
  }
}

// Update services.json if requested
if (flagUpdate) {
  const STALE_THRESHOLD = 3;
  const now = new Date().toISOString();
  const staled = [];
  for (const r of results) {
    const svc = data.services.find(s => s.id === r.id);
    if (!svc) continue;
    if (!svc.liveness) svc.liveness = {};
    svc.liveness.lastChecked = now;
    svc.liveness.alive = r.liveness === "alive";
    svc.liveness.httpStatus = r.httpStatus;
    svc.liveness.elapsed = r.elapsed;
    if (r.error) svc.liveness.error = r.error;
    else delete svc.liveness.error;
    // wq-658: Store probe-depth metric when --depth is used
    if (flagDepth && r.probeDepth != null) {
      svc.liveness.probeDepth = r.probeDepth;
    }

    // Track consecutive failures for auto-stale
    if (r.liveness === "alive") {
      svc.liveness.consecutiveFails = 0;
    } else {
      svc.liveness.consecutiveFails = (svc.liveness.consecutiveFails || 0) + 1;
    }

    // Auto-archive: mark as stale after STALE_THRESHOLD consecutive failures
    if (svc.liveness.consecutiveFails >= STALE_THRESHOLD && svc.status !== "rejected" && svc.status !== "stale") {
      svc.status = "stale";
      svc.staledAt = now;
      staled.push(svc.name);
    }

    // Auto-resurrect: if a stale service comes back alive, restore to evaluated
    if (svc.status === "stale" && r.liveness === "alive") {
      svc.status = "evaluated";
      delete svc.staledAt;
    }
  }
  data.lastLivenessCheck = now;
  writeFileSync(SERVICES_PATH, JSON.stringify(data, null, 2) + "\n");
  if (!flagJson) {
    console.log(`\nUpdated services.json (lastLivenessCheck: ${now})`);
    if (staled.length > 0) console.log(`Auto-staled ${staled.length} services: ${staled.join(", ")}`);
  }
}

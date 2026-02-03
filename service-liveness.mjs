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

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { safeFetch } from "./lib/safe-fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_PATH = resolve(__dirname, "services.json");
const FETCH_TIMEOUT = 8000;

// TLD variants to probe when a URL fails (d033 gap fix - wq-127)
const TLD_VARIANTS = [".ai", ".io", ".com", ".dev", ".app", ".xyz", ".net", ".org"];

// --- Args ---
const args = process.argv.slice(2);
const flagAll = args.includes("--all");
const flagJson = args.includes("--json");
const flagUpdate = args.includes("--update");
const flagProbeTld = args.includes("--probe-tld"); // wq-127: probe TLD variants on DNS failure

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

for (let i = 0; i < services.length; i++) {
  const svc = services[i];
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

  results.push({
    id: svc.id,
    name: svc.name,
    url: svc.url,
    currentStatus: svc.status,
    liveness,
    httpStatus: check.status,
    elapsed: Math.round(check.elapsed * 1000),
    error: check.error || null,
    tldSuggestion: tldSuggestion ? tldSuggestion.url : null,
  });
  done++;
  if (!flagJson) {
    const icon = check.alive ? "✓" : "✗";
    const code = check.status || "---";
    const ms = Math.round(check.elapsed * 1000);
    process.stderr.write(`[${done}/${total}] ${icon} ${code} ${ms}ms ${svc.name} (${svc.url})\n`);
  }
}

// Summary
const alive = results.filter(r => r.liveness === "alive").length;
const down = results.filter(r => r.liveness === "down").length;
const errored = results.filter(r => r.liveness === "error").length;

if (flagJson) {
  console.log(JSON.stringify({ checked: new Date().toISOString(), total, alive, down, errored, results }, null, 2));
} else {
  console.log(`\n--- Liveness Report ---`);
  console.log(`Total: ${total} | Alive: ${alive} | Down: ${down} | Error: ${errored}`);
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

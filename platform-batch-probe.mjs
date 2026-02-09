#!/usr/bin/env node
/**
 * platform-batch-probe.mjs — Batch prober for degraded platforms.
 *
 * Reads account-registry.json, probes all degraded platforms in parallel
 * (HTTP test URLs), updates liveness status, and outputs a triage report.
 *
 * "Degraded" = not currently live AND not defunct/rejected.
 * Covers: error, unreachable, bad_creds, needs_probe, unknown statuses.
 *
 * Usage:
 *   node platform-batch-probe.mjs                  # Probe all degraded
 *   node platform-batch-probe.mjs --all            # Probe ALL platforms
 *   node platform-batch-probe.mjs --json           # JSON output
 *   node platform-batch-probe.mjs --update         # Update account-registry.json
 *   node platform-batch-probe.mjs --dry            # Probe without updating
 *   node platform-batch-probe.mjs --concurrency=8  # Parallel limit (default 5)
 *
 * wq-530: Degraded platform batch prober
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { safeFetch } from "./lib/safe-fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, "account-registry.json");
const PROBE_TIMEOUT = 8000;
const DEFAULT_CONCURRENCY = 5;

// Statuses considered "healthy" — skip in degraded-only mode
const HEALTHY_STATUSES = new Set(["live"]);
// Statuses to always skip
const SKIP_STATUSES = new Set(["defunct", "rejected"]);
// Test methods we can probe via HTTP
const PROBEABLE_METHODS = new Set(["http"]);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    all: false,
    json: false,
    update: false,
    dry: false,
    concurrency: DEFAULT_CONCURRENCY,
  };
  for (const a of args) {
    if (a === "--all") opts.all = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--update") opts.update = true;
    else if (a === "--dry") opts.dry = true;
    else if (a.startsWith("--concurrency=")) opts.concurrency = parseInt(a.split("=")[1], 10) || DEFAULT_CONCURRENCY;
  }
  return opts;
}

function isDegraded(account) {
  // A platform is degraded if it's not live and not defunct/rejected
  const status = account.status;
  const lastStatus = account.last_status;

  if (SKIP_STATUSES.has(status)) return false;
  if (SKIP_STATUSES.has(lastStatus)) return false;

  // If explicitly "live" in both fields, not degraded
  if (HEALTHY_STATUSES.has(status) && HEALTHY_STATUSES.has(lastStatus)) return false;

  // If status is "live" but last_status isn't, still check it
  // If last_status is "live" but status is needs_probe, still check it
  // Basically: anything not clearly healthy in BOTH fields is worth probing
  if (HEALTHY_STATUSES.has(status) && HEALTHY_STATUSES.has(lastStatus)) return false;

  return true;
}

function classifyResult(probeResult, account) {
  const { status, elapsed, error } = probeResult;

  if (error === "timeout") return { new_status: "unreachable", reason: `timeout (${PROBE_TIMEOUT}ms)` };
  if (error === "connection_error") return { new_status: "unreachable", reason: "connection error" };
  if (error === "blocked_private_ip") return { new_status: "error", reason: "private IP blocked" };
  if (status === 0) return { new_status: "unreachable", reason: error || "no response" };

  // HTTP responses
  if (status >= 200 && status < 300) return { new_status: "live", reason: `${status} OK` };
  if (status === 301 || status === 302 || status === 307 || status === 308) return { new_status: "live", reason: `${status} redirect (reachable)` };
  if (status === 401 || status === 403) return { new_status: "bad_creds", reason: `${status} auth required` };
  if (status === 404) return { new_status: "error", reason: `${status} not found` };
  if (status >= 500) return { new_status: "error", reason: `${status} server error` };

  return { new_status: "error", reason: `${status} unexpected` };
}

async function probeAccount(account) {
  const url = account.test?.url;
  const start = Date.now();

  if (!url) {
    return {
      id: account.id,
      platform: account.platform,
      test_method: account.test?.method || "unknown",
      skipped: true,
      reason: "no HTTP test URL",
      prev_status: account.last_status,
      new_status: null,
      elapsed_ms: 0,
    };
  }

  // Determine auth headers from test config
  const headers = {};
  if (account.test?.auth === "bearer" && account.has_credentials && account.cred_file) {
    try {
      const credPath = account.cred_file.replace("~", process.env.HOME);
      if (existsSync(credPath)) {
        const credData = readFileSync(credPath, "utf8").trim();
        let token;
        try {
          const parsed = JSON.parse(credData);
          token = account.cred_key ? parsed[account.cred_key] : parsed.token || parsed.api_key;
        } catch {
          // Plain text token (e.g. .moltchan-key)
          token = credData;
        }
        if (token) headers["Authorization"] = `Bearer ${token}`;
      }
    } catch {
      // Ignore credential read errors — probe without auth
    }
  }

  const result = await safeFetch(url, {
    timeout: PROBE_TIMEOUT,
    headers,
    bodyMode: "none",
    userAgent: "moltbook-batch-probe/1.0",
  });

  const classification = classifyResult(result, account);
  const elapsed_ms = Math.round((result.elapsed || 0) * 1000);

  return {
    id: account.id,
    platform: account.platform,
    test_url: url,
    skipped: false,
    http_status: result.status,
    prev_status: account.last_status,
    new_status: classification.new_status,
    reason: classification.reason,
    elapsed_ms,
    error: result.error || null,
    status_changed: account.last_status !== classification.new_status,
  };
}

async function probeAllWithConcurrency(accounts, concurrency) {
  const results = [];
  for (let i = 0; i < accounts.length; i += concurrency) {
    const batch = accounts.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(probeAccount));
    results.push(...batchResults);
  }
  return results;
}

function printTriageReport(results) {
  const probed = results.filter(r => !r.skipped);
  const skipped = results.filter(r => r.skipped);
  const recovered = probed.filter(r => r.new_status === "live" && r.prev_status !== "live");
  const stillDown = probed.filter(r => r.new_status !== "live");
  const nowDegraded = probed.filter(r => r.new_status !== "live" && r.prev_status === "live");
  const changed = probed.filter(r => r.status_changed);

  console.log("=== Platform Batch Probe Report ===\n");

  if (recovered.length > 0) {
    console.log(`RECOVERED (${recovered.length}):`);
    for (const r of recovered) {
      console.log(`  [+] ${r.platform} — ${r.prev_status} → ${r.new_status} (${r.reason}, ${r.elapsed_ms}ms)`);
    }
    console.log();
  }

  if (nowDegraded.length > 0) {
    console.log(`NEWLY DEGRADED (${nowDegraded.length}):`);
    for (const r of nowDegraded) {
      console.log(`  [-] ${r.platform} — ${r.prev_status} → ${r.new_status} (${r.reason}, ${r.elapsed_ms}ms)`);
    }
    console.log();
  }

  if (stillDown.length > 0) {
    console.log(`STILL DOWN (${stillDown.length}):`);
    for (const r of stillDown) {
      const marker = r.status_changed ? "~" : "=";
      console.log(`  [${marker}] ${r.platform} — ${r.prev_status} → ${r.new_status} (${r.reason}, ${r.elapsed_ms}ms)`);
    }
    console.log();
  }

  if (skipped.length > 0) {
    console.log(`SKIPPED (${skipped.length}): ${skipped.map(r => r.platform).join(", ")}`);
    console.log();
  }

  // Status distribution
  const statusCounts = {};
  for (const r of probed) {
    statusCounts[r.new_status] = (statusCounts[r.new_status] || 0) + 1;
  }

  console.log("--- Summary ---");
  console.log(`Total: ${results.length} | Probed: ${probed.length} | Skipped: ${skipped.length}`);
  console.log(`Recovered: ${recovered.length} | Newly degraded: ${nowDegraded.length} | Status changed: ${changed.length}`);
  console.log(`Status distribution: ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}

async function main() {
  const opts = parseArgs();
  const data = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  const accounts = data.accounts || [];

  // Filter candidates
  let candidates;
  if (opts.all) {
    candidates = accounts.filter(a => !SKIP_STATUSES.has(a.status) && !SKIP_STATUSES.has(a.last_status));
  } else {
    candidates = accounts.filter(isDegraded);
  }

  // Only probe accounts with HTTP test methods
  const probeable = candidates.filter(a => PROBEABLE_METHODS.has(a.test?.method));
  const nonprobeable = candidates.filter(a => !PROBEABLE_METHODS.has(a.test?.method));

  if (probeable.length === 0 && nonprobeable.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ probed: 0, results: [] }));
    } else {
      console.log("No degraded platforms to probe.");
    }
    return;
  }

  if (!opts.json) {
    console.log(`Probing ${probeable.length} platforms (concurrency: ${opts.concurrency}, timeout: ${PROBE_TIMEOUT}ms)...\n`);
  }

  const results = await probeAllWithConcurrency(probeable, opts.concurrency);

  // Add non-probeable as skipped
  for (const a of nonprobeable) {
    results.push({
      id: a.id,
      platform: a.platform,
      test_method: a.test?.method || "unknown",
      skipped: true,
      reason: `non-HTTP test method (${a.test?.method || "none"})`,
      prev_status: a.last_status,
      new_status: null,
      elapsed_ms: 0,
    });
  }

  if (opts.json) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      probed: results.filter(r => !r.skipped).length,
      skipped: results.filter(r => r.skipped).length,
      recovered: results.filter(r => r.new_status === "live" && r.prev_status !== "live").length,
      results,
    }, null, 2));
  } else {
    printTriageReport(results);
  }

  // Update account-registry.json
  if (opts.update && !opts.dry) {
    const now = new Date().toISOString();
    let updated = 0;
    for (const r of results) {
      if (r.skipped || !r.new_status) continue;
      const account = accounts.find(a => a.id === r.id);
      if (!account) continue;
      account.last_status = r.new_status;
      account.last_tested = now;
      updated++;
    }
    writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2) + "\n");
    if (!opts.json) {
      console.log(`\nUpdated ${updated} entries in account-registry.json`);
    }
  }
}

main().catch(e => {
  console.error("platform-batch-probe error:", e.message);
  process.exit(1);
});

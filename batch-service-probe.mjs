#!/usr/bin/env node
/**
 * batch-service-probe.mjs — Batch service discovery probe for E sessions.
 *
 * Probes services from services.json in parallel, checking common discovery
 * endpoints (skill.md, api-docs, .well-known/agent-info.json, health, register).
 * Outputs structured results for E session consumption.
 *
 * Usage:
 *   node batch-service-probe.mjs                    # Probe all "discovered" services
 *   node batch-service-probe.mjs --status=all       # Probe all statuses
 *   node batch-service-probe.mjs --limit=5          # Probe at most 5
 *   node batch-service-probe.mjs --json             # JSON output
 *   node batch-service-probe.mjs --update           # Update services.json with results
 *
 * wq-397: Batch service evaluation tool
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { safeFetch } from "./lib/safe-fetch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_PATH = join(__dirname, "services.json");

const PROBE_TIMEOUT = 6000;
const CONCURRENCY = 5;

// Discovery endpoints to check on each service
const DISCOVERY_ENDPOINTS = [
  { path: "/skill.md", label: "skill-manifest", type: "text" },
  { path: "/.well-known/agent-info.json", label: "agent-info", type: "json" },
  { path: "/api-docs", label: "api-docs", type: "text" },
  { path: "/health", label: "health", type: "text" },
  { path: "/api/register", label: "register-endpoint", type: "json" },
  { path: "/api/v1/agents/register", label: "register-v1", type: "json" },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { status: "discovered", limit: 20, json: false, update: false };
  for (const a of args) {
    if (a.startsWith("--status=")) opts.status = a.split("=")[1];
    else if (a.startsWith("--limit=")) opts.limit = parseInt(a.split("=")[1], 10);
    else if (a === "--json") opts.json = true;
    else if (a === "--update") opts.update = true;
  }
  return opts;
}

async function probeService(service) {
  const baseUrl = service.url.replace(/\/$/, "");
  const result = {
    id: service.id,
    name: service.name,
    url: baseUrl,
    currentStatus: service.status,
    endpoints: [],
    hasSkillMd: false,
    hasAgentInfo: false,
    hasApiDocs: false,
    hasHealth: false,
    hasRegister: false,
    summary: "",
  };

  const probes = DISCOVERY_ENDPOINTS.map(async (ep) => {
    const url = baseUrl + ep.path;
    const res = await safeFetch(url, { timeout: PROBE_TIMEOUT, maxBody: 8192 });
    const hit = res.status >= 200 && res.status < 400 && res.body && res.body.length > 10;
    return {
      label: ep.label,
      path: ep.path,
      status: res.status,
      alive: hit,
      bodyLength: res.body?.length || 0,
      bodyPreview: hit ? res.body.slice(0, 200) : null,
      elapsed: res.elapsed,
      error: res.error,
    };
  });

  result.endpoints = await Promise.all(probes);

  // Summarize findings
  for (const ep of result.endpoints) {
    if (ep.alive) {
      if (ep.label === "skill-manifest") result.hasSkillMd = true;
      if (ep.label === "agent-info") result.hasAgentInfo = true;
      if (ep.label === "api-docs") result.hasApiDocs = true;
      if (ep.label === "health") result.hasHealth = true;
      if (ep.label === "register-endpoint" || ep.label === "register-v1") result.hasRegister = true;
    }
  }

  const found = [];
  if (result.hasSkillMd) found.push("skill.md");
  if (result.hasAgentInfo) found.push("agent-info");
  if (result.hasApiDocs) found.push("api-docs");
  if (result.hasHealth) found.push("health");
  if (result.hasRegister) found.push("register");

  if (found.length === 0) {
    result.summary = "No discovery endpoints found";
  } else {
    result.summary = `Found: ${found.join(", ")}`;
  }

  return result;
}

// Run probes with concurrency limit
async function probeAll(services) {
  const results = [];
  for (let i = 0; i < services.length; i += CONCURRENCY) {
    const batch = services.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(probeService));
    results.push(...batchResults);
  }
  return results;
}

async function main() {
  const opts = parseArgs();

  const data = JSON.parse(readFileSync(SERVICES_PATH, "utf-8"));
  const allServices = data.services || [];

  // Filter by status
  let candidates;
  if (opts.status === "all") {
    candidates = allServices.filter(s => s.liveness?.alive !== false);
  } else {
    candidates = allServices.filter(s => s.status === opts.status);
  }

  // Apply limit
  candidates = candidates.slice(0, opts.limit);

  if (candidates.length === 0) {
    console.log(`No services with status "${opts.status}" to probe.`);
    process.exit(0);
  }

  if (!opts.json) {
    console.log(`Probing ${candidates.length} services (status: ${opts.status}, concurrency: ${CONCURRENCY})...\n`);
  }

  const results = await probeAll(candidates);

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const eps = r.endpoints.filter(e => e.alive).map(e => e.label);
      const epStr = eps.length > 0 ? eps.join(", ") : "(none)";
      console.log(`${r.name} (${r.url})`);
      console.log(`  Status: ${r.currentStatus} | Discovery: ${epStr}`);
      if (r.hasSkillMd) {
        const skillEp = r.endpoints.find(e => e.label === "skill-manifest");
        if (skillEp?.bodyPreview) {
          const preview = skillEp.bodyPreview.split("\n").slice(0, 3).join(" ").slice(0, 120);
          console.log(`  skill.md: ${preview}...`);
        }
      }
      if (r.hasRegister) {
        console.log(`  *** Registration endpoint available ***`);
      }
      console.log();
    }

    // Summary
    const withDiscovery = results.filter(r => r.endpoints.some(e => e.alive));
    const withRegister = results.filter(r => r.hasRegister);
    console.log(`--- Summary ---`);
    console.log(`Probed: ${results.length} | With discovery endpoints: ${withDiscovery.length} | With registration: ${withRegister.length}`);
  }

  // Update services.json if requested
  if (opts.update) {
    const now = new Date().toISOString();
    for (const r of results) {
      const svc = allServices.find(s => s.id === r.id);
      if (!svc) continue;
      svc.evaluatedAt = now;
      const discoveries = [];
      if (r.hasSkillMd) discoveries.push("skill.md");
      if (r.hasAgentInfo) discoveries.push("agent-info");
      if (r.hasApiDocs) discoveries.push("api-docs");
      if (r.hasHealth) discoveries.push("health");
      if (r.hasRegister) discoveries.push("register");
      if (discoveries.length > 0) {
        svc.notes = `Batch probe ${now.split("T")[0]}: ${discoveries.join(", ")} found`;
        svc.api_docs = svc.api_docs || (r.hasSkillMd ? svc.url + "/skill.md" : null);
      } else {
        svc.notes = `Batch probe ${now.split("T")[0]}: no discovery endpoints`;
      }
    }
    writeFileSync(SERVICES_PATH, JSON.stringify(data, null, 2) + "\n");
    if (!opts.json) {
      console.log(`\nUpdated ${results.length} entries in services.json`);
    }
  }
}

main().catch(e => {
  console.error("batch-service-probe error:", e.message);
  process.exit(1);
});

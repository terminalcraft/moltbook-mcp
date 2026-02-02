#!/usr/bin/env node
// agent-compare.mjs — Fetch and compare /agent.json manifests across the ecosystem
// Usage: node agent-compare.mjs [--probe-all] [--json] [url1 url2 ...]

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const BASE = "/home/moltbot/moltbook-mcp";
const RESULTS_FILE = join(BASE, "agent-compare-results.json");
const TIMEOUT = 8000;

// Known agent exchange endpoints (curated list)
const KNOWN_ENDPOINTS = [
  { name: "moltbook (self)", url: "http://terminalcraft.xyz:3847/agent.json" },
];

// Platforms that might serve agent.json (discovered from services.json + ecosystem)
const PLATFORM_PROBES = [
  "https://chatr.ai/agent.json",
  "https://chatr.ai/.well-known/agent.json",
  "https://ctxly.app/agent.json",
  "https://ctxly.app/.well-known/agent.json",
  "https://www.4claw.org/agent.json",
  "https://lobchan.ai/agent.json",
  "https://thecolony.cc/agent.json",
  "https://thecolony.cc/.well-known/agent.json",
  "https://colonysim.ctxly.app/agent.json",
  "https://clawhub.ai/agent.json",
  "https://clawhub.ai/.well-known/agent.json",
  "https://clawdhub.com/agent.json",
  "https://darkclaw.net/agent.json",
  "https://darkclaw.net/.well-known/agent.json",
  "https://moltcities.org/agent.json",
  "https://grove.ctxly.app/agent.json",
  "https://home.ctxly.app/agent.json",
  "https://mydeadinternet.com/agent.json",
  "https://moltbook.com/agent.json",
  "https://agentid.sh/agent.json",
  "https://moltchan.org/agent.json",
  "https://www.moltchan.org/agent.json",
  "http://89.167.11.175:8082/agent.json",
  "http://100.29.245.213:3456/agent.json",
  "https://aiwot.org/agent.json",
  "https://wikclawpedia.com/agent.json",
  "https://clawwatch.online/agent.json",
  "https://8claw.net/agent.json",
  "https://openwork.bot/agent.json",
];

async function fetchManifest(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json", "User-Agent": "moltbook-agent-compare/1.0" },
    });
    clearTimeout(timer);
    if (!resp.ok) return { url, status: resp.status, error: `HTTP ${resp.status}` };
    const text = await resp.text();
    try {
      const json = JSON.parse(text);
      // Basic validation: must have agent or name or capabilities
      if (json.agent || json.name || json.capabilities) {
        return { url, status: 200, manifest: json };
      }
      return { url, status: 200, error: "Valid JSON but not an agent manifest" };
    } catch {
      return { url, status: 200, error: "Response is not JSON" };
    }
  } catch (e) {
    clearTimeout(timer);
    return { url, status: 0, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

function extractCapabilities(manifest) {
  if (Array.isArray(manifest.capabilities)) return manifest.capabilities;
  if (manifest.endpoints) return Object.keys(manifest.endpoints);
  return [];
}

function compareAgents(ours, theirs) {
  const ourCaps = new Set(extractCapabilities(ours));
  const theirCaps = new Set(extractCapabilities(theirs));
  const shared = [...ourCaps].filter(c => theirCaps.has(c));
  const weHave = [...ourCaps].filter(c => !theirCaps.has(c));
  const theyHave = [...theirCaps].filter(c => !ourCaps.has(c));
  return { shared, we_have_exclusively: weHave, they_have_exclusively: theyHave };
}

async function main() {
  const args = process.argv.slice(2);
  const probeAll = args.includes("--probe-all");
  const jsonOutput = args.includes("--json");
  const extraUrls = args.filter(a => !a.startsWith("--") && (a.startsWith("http://") || a.startsWith("https://")));

  // Build URL list
  let urls = KNOWN_ENDPOINTS.map(e => e.url);
  if (probeAll) urls.push(...PLATFORM_PROBES);
  urls.push(...extraUrls);
  urls = [...new Set(urls)]; // dedupe

  if (!jsonOutput) console.log(`Probing ${urls.length} endpoint(s)...\n`);

  // Fetch all in parallel
  const results = await Promise.all(urls.map(fetchManifest));

  // Separate successes
  const found = results.filter(r => r.manifest);
  const failed = results.filter(r => !r.manifest);

  // Get our own manifest
  const ours = found.find(r => r.url.includes("terminalcraft.xyz") || r.url.includes("127.0.0.1:3847"));
  const others = found.filter(r => r !== ours);

  // Build comparison report
  const report = {
    timestamp: new Date().toISOString(),
    probed: urls.length,
    found: found.length,
    failed: failed.length,
    agents: found.map(r => ({
      url: r.url,
      name: r.manifest.agent || r.manifest.name || "unknown",
      version: r.manifest.version || null,
      capabilities: extractCapabilities(r.manifest),
      endpoints: r.manifest.endpoints ? Object.keys(r.manifest.endpoints).length : 0,
      has_identity: !!r.manifest.identity,
      has_knowledge_exchange: extractCapabilities(r.manifest).includes("knowledge-exchange"),
    })),
    comparisons: ours ? others.map(r => ({
      agent: r.manifest.agent || r.manifest.name || "unknown",
      url: r.url,
      ...compareAgents(ours.manifest, r.manifest),
    })) : [],
    unreachable: failed.map(r => ({ url: r.url, error: r.error })),
    collaboration_targets: [],
    integration_gaps: [],
  };

  // Identify collaboration targets (agents with knowledge-exchange)
  report.collaboration_targets = report.agents
    .filter(a => a.has_knowledge_exchange && !a.url.includes("terminalcraft.xyz"))
    .map(a => ({ name: a.name, url: a.url, shared_protocol: "knowledge-exchange" }));

  // Identify integration gaps (capabilities others have that we don't)
  if (ours) {
    const ourCaps = new Set(extractCapabilities(ours.manifest));
    const gapMap = {};
    for (const r of others) {
      for (const cap of extractCapabilities(r.manifest)) {
        if (!ourCaps.has(cap)) {
          if (!gapMap[cap]) gapMap[cap] = [];
          gapMap[cap].push(r.manifest.agent || r.manifest.name || r.url);
        }
      }
    }
    report.integration_gaps = Object.entries(gapMap).map(([cap, agents]) => ({ capability: cap, agents }));
  }

  // Save results
  writeFileSync(RESULTS_FILE, JSON.stringify(report, null, 2));

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== Agent Manifest Comparison Report ===`);
    console.log(`Probed: ${report.probed} | Found: ${report.found} | Failed: ${report.failed}\n`);

    if (found.length > 0) {
      console.log("--- Discovered Agents ---");
      for (const a of report.agents) {
        console.log(`  ${a.name} (v${a.version || "?"})`);
        console.log(`    URL: ${a.url}`);
        console.log(`    Capabilities: ${a.capabilities.length} | Endpoints: ${a.endpoints} | Identity: ${a.has_identity ? "yes" : "no"} | Exchange: ${a.has_knowledge_exchange ? "yes" : "no"}`);
      }
    }

    if (report.comparisons.length > 0) {
      console.log("\n--- Capability Comparisons (vs moltbook) ---");
      for (const c of report.comparisons) {
        console.log(`  ${c.agent}:`);
        console.log(`    Shared: ${c.shared.length} | We have: ${c.we_have_exclusively.length} | They have: ${c.they_have_exclusively.length}`);
        if (c.they_have_exclusively.length > 0)
          console.log(`    Their unique: ${c.they_have_exclusively.join(", ")}`);
      }
    }

    if (report.collaboration_targets.length > 0) {
      console.log("\n--- Collaboration Targets ---");
      for (const t of report.collaboration_targets)
        console.log(`  ${t.name}: ${t.url} (${t.shared_protocol})`);
    } else {
      console.log("\n--- No collaboration targets found (no other agents serve /agent.json with knowledge-exchange) ---");
    }

    if (report.integration_gaps.length > 0) {
      console.log("\n--- Integration Gaps (capabilities we lack) ---");
      for (const g of report.integration_gaps)
        console.log(`  ${g.capability}: seen in ${g.agents.join(", ")}`);
    }

    console.log(`\nResults saved to ${RESULTS_FILE}`);
  }
}

main().catch(console.error);

#!/usr/bin/env node
/**
 * engage-orchestrator.mjs — Engagement session backbone.
 *
 * Sequences: platform health check → service evaluation → session plan.
 * Designed to be called at the start of E sessions.
 *
 * Usage:
 *   node engage-orchestrator.mjs              # Full orchestration, human-readable
 *   node engage-orchestrator.mjs --json       # Machine-readable JSON output
 *   node engage-orchestrator.mjs --plan-only  # Just output the session plan, no evaluation
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_PATH = join(__dirname, "services.json");
const INTEL_PATH = join(__dirname, "engagement-intel.json");

function loadJSON(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function run(cmd, timeout = 15000) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout, cwd: __dirname }).trim();
  } catch (e) {
    return null;
  }
}

// --- Phase 1: Platform Health ---

function checkPlatformHealth() {
  const raw = run("node account-manager.mjs json", 30000);
  if (!raw) return { error: "account-manager failed", platforms: [] };
  try {
    const platforms = JSON.parse(raw);
    return {
      live: platforms.filter(p => p.status === "live" || p.status === "creds_ok"),
      down: platforms.filter(p => p.status !== "live" && p.status !== "creds_ok"),
      all: platforms,
    };
  } catch {
    return { error: "parse error", platforms: [] };
  }
}

// --- Phase 2: Pick Service to Evaluate ---

function pickServiceToEvaluate() {
  const services = loadJSON(SERVICES_PATH);
  if (!services) return null;

  // Priority: discovered (never evaluated) > evaluated long ago > evaluated recently
  const discovered = services.services.filter(s => s.status === "discovered");
  if (discovered.length > 0) {
    // Pick the oldest discovered service
    discovered.sort((a, b) => new Date(a.discoveredAt) - new Date(b.discoveredAt));
    return discovered[0];
  }

  // Re-evaluate services that were evaluated > 7 days ago and aren't rejected
  const stale = services.services.filter(s => {
    if (s.status === "rejected" || s.status === "active" || s.status === "integrated") return false;
    if (!s.evaluatedAt) return true;
    const age = Date.now() - new Date(s.evaluatedAt).getTime();
    return age > 7 * 24 * 3600 * 1000;
  });
  if (stale.length > 0) {
    stale.sort((a, b) => new Date(a.evaluatedAt || 0) - new Date(b.evaluatedAt || 0));
    return stale[0];
  }

  return null;
}

// --- Phase 3: Run Service Evaluation ---

function evaluateService(service) {
  const raw = run(`node service-evaluator.mjs ${JSON.stringify(service.url)} --json`, 60000);
  if (!raw) return { error: "evaluator failed" };
  try {
    return JSON.parse(raw);
  } catch {
    return { error: "parse error", raw: raw?.slice(0, 500) };
  }
}

// --- Phase 4: Generate Session Plan ---

function generatePlan(health, service, evalReport) {
  const plan = {
    generated_at: new Date().toISOString(),
    phases: [],
  };

  // Phase A: Platform engagement
  if (health.live?.length > 0) {
    const platformNames = health.live.map(p => p.platform);
    plan.phases.push({
      name: "platform_engagement",
      description: `Check ${platformNames.length} live platform(s): ${platformNames.join(", ")}`,
      platforms: platformNames,
      priority: "high",
    });
  } else {
    plan.phases.push({
      name: "platform_engagement",
      description: "No live platforms — skip engagement, focus on evaluation",
      platforms: [],
      priority: "skip",
    });
  }

  // Phase B: Service evaluation
  if (service) {
    const verdict = evalReport?.summary?.verdict || "unknown";
    plan.phases.push({
      name: "service_evaluation",
      description: `Evaluate ${service.name} (${service.url}) — verdict: ${verdict}`,
      service_id: service.id,
      url: service.url,
      verdict,
      score: evalReport?.summary?.score,
      priority: verdict === "unreachable" ? "low" : "high",
      action: verdict === "active_with_api" ? "attempt_integration"
        : verdict === "active" ? "explore_deeper"
        : verdict === "basic" ? "note_and_move_on"
        : "skip",
    });
  }

  // Phase C: Intel capture
  plan.phases.push({
    name: "intel_capture",
    description: "Log findings to engagement-intel.json and update services.json",
    priority: "required",
  });

  return plan;
}

// --- Main ---

const jsonMode = process.argv.includes("--json");
const planOnly = process.argv.includes("--plan-only");

console.error("[orchestrator] Phase 1: Checking platform health...");
const health = checkPlatformHealth();

console.error("[orchestrator] Phase 2: Picking service to evaluate...");
const service = pickServiceToEvaluate();

let evalReport = null;
if (service && !planOnly) {
  console.error(`[orchestrator] Phase 3: Evaluating ${service.name} (${service.url})...`);
  evalReport = evaluateService(service);
}

const plan = generatePlan(health, service, evalReport);

const output = {
  session_plan: plan,
  platform_health: {
    live_count: health.live?.length || 0,
    down_count: health.down?.length || 0,
    live: health.live?.map(p => p.platform) || [],
  },
  service_to_evaluate: service ? {
    id: service.id,
    name: service.name,
    url: service.url,
    status: service.status,
  } : null,
  evaluation: evalReport,
};

if (jsonMode) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log("\n=== Engagement Session Plan ===\n");

  // Platform health
  if (health.live?.length) {
    console.log(`Live platforms (${health.live.length}):`);
    for (const p of health.live) console.log(`  ✓ ${p.platform}`);
  } else {
    console.log("No live platforms detected.");
  }
  if (health.down?.length) {
    console.log(`Down/unavailable (${health.down.length}):`);
    for (const p of health.down) console.log(`  ✗ ${p.platform} (${p.status})`);
  }

  // Service evaluation
  if (service) {
    console.log(`\nService to evaluate: ${service.name} (${service.url})`);
    if (evalReport?.summary) {
      console.log(`  Verdict: ${evalReport.summary.verdict} (${evalReport.summary.score}/${evalReport.summary.max_score})`);
      if (evalReport.page?.title) console.log(`  Title: ${evalReport.page.title}`);
      if (evalReport.api_discovery?.length) {
        console.log(`  API endpoints: ${evalReport.api_discovery.map(e => e.path).join(", ")}`);
      }
    }
  } else {
    console.log("\nNo services need evaluation right now.");
  }

  // Plan summary
  console.log("\nAction plan:");
  for (const phase of plan.phases) {
    const icon = phase.priority === "skip" ? "⊘" : phase.priority === "required" ? "!" : "→";
    console.log(`  ${icon} ${phase.description}`);
  }
}

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
 *   node engage-orchestrator.mjs --record-outcome <platform> <success|failure>
 *   node engage-orchestrator.mjs --circuit-status  # Show circuit breaker state
 *   node engage-orchestrator.mjs --history [--json]  # Diagnostic view: time since success, trends, retry info
 *   node engage-orchestrator.mjs --diversity  # Show engagement concentration metrics
 *   node engage-orchestrator.mjs --diversity-trends  # Show diversity history trends (wq-131)
 *   node engage-orchestrator.mjs --quality-check "text"  # Pre-post quality gate (d066)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { analyzeEngagement } from "./providers/engagement-analytics.js";
import { setCachedLiveness } from "./lib/platform-liveness-cache.mjs";
import { getDisplayName } from "./lib/platform-names.mjs";
import { handleHistory, handleDiversity, handleDiversityTrends, handleQualityCheck } from "./lib/orchestrator-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const SERVICES_PATH = join(__dirname, "services.json");
const INTEL_PATH = join(STATE_DIR, "engagement-intel.json");  // Must match session-context.mjs (wq-119 fix)
const CIRCUIT_PATH = join(__dirname, "platform-circuits.json");

// Circuit breaker config
const CIRCUIT_FAILURE_THRESHOLD = 3;  // consecutive failures to open circuit
const CIRCUIT_COOLDOWN_MS = 24 * 3600 * 1000;  // 24h before half-open retry

// Priority engagement targets — integrated services that E sessions should visit frequently.
// These get injected into the session plan with a high ROI boost (above normal platform scoring).
// Each entry: { name, url, boost } where boost is added to the ROI score.
const PRIORITY_TARGETS = [
  { name: "Pinchwork", url: "https://pinchwork.dev", boost: 40 },
];

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

// --- Circuit Breaker ---
// Tracks per-platform consecutive failures. States:
//   closed (healthy) → open (disabled after N failures) → half-open (retry after cooldown)

function loadCircuits() {
  if (!existsSync(CIRCUIT_PATH)) return {};
  try { return JSON.parse(readFileSync(CIRCUIT_PATH, "utf8")); } catch { return {}; }
}

function saveCircuits(circuits) {
  writeFileSync(CIRCUIT_PATH, JSON.stringify(circuits, null, 2) + "\n");
}

function getCircuitState(circuits, platform) {
  const entry = circuits[platform];
  if (!entry || entry.consecutive_failures < CIRCUIT_FAILURE_THRESHOLD) return "closed";
  // wq-319: Defunct platforms are permanently excluded
  if (entry.status === "defunct") return "defunct";
  // Check if cooldown has expired → half-open
  const elapsed = Date.now() - new Date(entry.last_failure).getTime();
  if (elapsed >= CIRCUIT_COOLDOWN_MS) return "half-open";
  return "open";
}

function recordOutcome(platform, success) {
  const circuits = loadCircuits();
  if (!circuits[platform]) {
    circuits[platform] = { consecutive_failures: 0, total_failures: 0, total_successes: 0, last_failure: null, last_success: null };
  }
  const entry = circuits[platform];
  if (success) {
    entry.consecutive_failures = 0;
    entry.total_successes++;
    entry.last_success = new Date().toISOString();
  } else {
    entry.consecutive_failures++;
    entry.total_failures++;
    entry.last_failure = new Date().toISOString();
  }
  saveCircuits(circuits);
  return { platform, state: getCircuitState(circuits, platform), ...entry };
}

function filterByCircuit(platformNames) {
  const circuits = loadCircuits();
  const allowed = [];
  const blocked = [];
  const halfOpen = [];
  const defunct = [];  // wq-319: Track defunct platforms separately
  for (const name of platformNames) {
    const state = getCircuitState(circuits, name);
    if (state === "defunct") {
      // wq-319: Defunct platforms are permanently excluded
      const entry = circuits[name];
      defunct.push({ platform: name, defunct_at: entry.defunct_at, reason: entry.defunct_reason });
    } else if (state === "open") {
      const entry = circuits[name];
      blocked.push({ platform: name, failures: entry.consecutive_failures, last_failure: entry.last_failure });
    } else if (state === "half-open") {
      halfOpen.push(name);
      allowed.push(name); // allow one retry
    } else {
      allowed.push(name);
    }
  }
  return { allowed, blocked, halfOpen, defunct };
}

// --- Phase 1: Platform Health ---

function checkPlatformHealth() {
  const raw = run("node account-manager.mjs json", 30000);
  if (!raw) return { error: "account-manager failed", platforms: [] };
  try {
    const platforms = JSON.parse(raw);
    // Three status categories: live (confirmed working), degraded (has creds but test failed),
    // down (no creds or unreachable). Degraded platforms are still engageable —
    // the test endpoint may be wrong or the platform temporarily erroring.
    const live = platforms.filter(p => p.status === "live" || p.status === "creds_ok");
    const degraded = platforms.filter(p =>
      p.status !== "live" && p.status !== "creds_ok" &&
      p.status !== "no_creds" && p.status !== "unreachable"
    );
    const down = platforms.filter(p =>
      p.status === "no_creds" || p.status === "unreachable"
    );
    // wq-509: Write health results to shared liveness cache for cross-tool reuse
    for (const p of platforms) {
      const reachable = p.status !== "unreachable";
      const healthy = p.status === "live" || p.status === "creds_ok";
      setCachedLiveness(p.platform, { reachable, healthy, status: healthy ? 200 : 0 });
    }
    return { live, degraded, down, all: platforms };
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

// --- Phase 3.5: Platform ROI Ranking ---

// Normalize analytics platform name to match health/account-manager names
// normalizePlatformName removed — use getDisplayName from lib/platform-names.mjs

function rankPlatformsByROI(livePlatformNames) {
  try {
    const analytics = analyzeEngagement();
    if (!analytics?.platforms?.length) return { ranked: livePlatformNames, roi: null };

    // Compute exploration stats: median e_sessions across known platforms
    const eSessions = analytics.platforms.map(p => p.e_sessions || 0);
    const sortedES = [...eSessions].sort((a, b) => a - b);
    const medianES = sortedES.length > 0 ? sortedES[Math.floor(sortedES.length / 2)] : 0;

    // Build ROI score with exploration bonus/penalty
    const roiMap = {};
    for (const p of analytics.platforms) {
      const name = getDisplayName(p.platform);
      const writes = p.writes || 0;
      const costPerWrite = p.cost_per_write;
      const writeRatio = p.write_ratio || 0;
      const pESessions = p.e_sessions || 0;

      // Base ROI score: high writes + low cost + high write ratio = good
      // Score range: 0-100, higher = better ROI
      let score = 0;
      if (writes > 0) {
        score += Math.min(writes, 50); // cap write volume contribution at 50
        score += writeRatio * 0.3;     // write ratio contributes up to 30
        if (costPerWrite !== null && costPerWrite > 0) {
          score += Math.max(0, 20 - costPerWrite * 10); // lower cost = higher score, cap at 20
        } else {
          score += 10; // neutral if no cost data
        }
      }

      // Exploration adjustment: boost under-visited, penalize over-visited
      // Range: -20 to +30. Platforms with 0 e_sessions get max boost.
      let explorationAdj = 0;
      if (pESessions === 0) {
        explorationAdj = 30; // never engaged — strong exploration boost
      } else if (medianES > 0) {
        // ratio < 1 = under-visited (bonus), ratio > 1 = over-visited (penalty)
        const ratio = pESessions / medianES;
        explorationAdj = Math.round(Math.max(-20, Math.min(20, (1 - ratio) * 15)));
      }

      score += explorationAdj;
      score = Math.max(0, score); // floor at 0
      roiMap[name] = { score: Math.round(score), writes, costPerWrite, writeRatio, eSessions: pESessions, explorationAdj };
    }

    // Platforms in livePlatformNames but NOT in analytics get max exploration boost
    for (const name of livePlatformNames) {
      if (!roiMap[name]) {
        roiMap[name] = { score: 30, writes: 0, costPerWrite: null, writeRatio: 0, eSessions: 0, explorationAdj: 30 };
      }
    }

    // Inject priority targets with their boost
    for (const target of PRIORITY_TARGETS) {
      const existing = roiMap[target.name];
      if (existing) {
        existing.score += target.boost;
        existing.priorityTarget = true;
      } else {
        roiMap[target.name] = {
          score: 30 + target.boost, writes: 0, costPerWrite: null,
          writeRatio: 0, eSessions: 0, explorationAdj: 30, priorityTarget: true,
        };
      }
      // Ensure priority targets appear in the ranking even if not in livePlatformNames
      if (!livePlatformNames.includes(target.name)) {
        livePlatformNames.push(target.name);
      }
    }

    // Rank live platforms by ROI score (highest first)
    const ranked = [...livePlatformNames].sort((a, b) => {
      const sa = roiMap[a]?.score || 0;
      const sb = roiMap[b]?.score || 0;
      return sb - sa;
    });

    return { ranked, roi: roiMap, analytics_summary: analytics.insight };
  } catch (e) {
    return { ranked: livePlatformNames, roi: null, error: e.message };
  }
}

// --- Phase 4: Generate Session Plan ---

function generatePlan(health, service, evalReport, roiData) {
  const plan = {
    generated_at: new Date().toISOString(),
    phases: [],
  };

  // Phase A: Platform engagement (ROI-ranked, includes degraded as fallbacks)
  const livePlatforms = health.live?.map(p => p.platform) || [];
  const degradedPlatforms = health.degraded?.map(p => p.platform) || [];
  if (livePlatforms.length > 0 || degradedPlatforms.length > 0) {
    const primaryNames = roiData?.ranked || livePlatforms;
    const roiDetail = roiData?.roi;
    const desc = roiDetail
      ? `Engage ${primaryNames.length} live platform(s) by ROI: ${primaryNames.map(p => `${p}(${roiDetail[p]?.score ?? "?"})`).join(" > ")}`
      : `Check ${primaryNames.length} live platform(s): ${primaryNames.join(", ")}`;
    plan.phases.push({
      name: "platform_engagement",
      description: desc + (degradedPlatforms.length ? ` + ${degradedPlatforms.length} degraded fallback(s)` : ""),
      platforms: primaryNames,
      degraded_fallbacks: degradedPlatforms,
      roi: roiDetail || null,
      priority: "high",
    });
  } else {
    plan.phases.push({
      name: "platform_engagement",
      description: "No live or degraded platforms — skip engagement, focus on evaluation",
      platforms: [],
      degraded_fallbacks: [],
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

// --- CLI: Record outcome ---
if (process.argv.includes("--record-outcome")) {
  const idx = process.argv.indexOf("--record-outcome");
  const platform = process.argv[idx + 1];
  const outcome = process.argv[idx + 2];
  if (!platform || !["success", "failure"].includes(outcome)) {
    console.error("Usage: --record-outcome <platform> <success|failure>");
    process.exit(1);
  }
  const result = recordOutcome(platform, outcome === "success");
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// --- CLI: Quality check (d066) ---
if (process.argv.includes("--quality-check")) {
  handleQualityCheck(process.argv, __dirname);
}

// --- CLI: Circuit status ---
if (process.argv.includes("--circuit-status")) {
  const circuits = loadCircuits();
  const status = {};
  for (const [platform, entry] of Object.entries(circuits)) {
    status[platform] = { state: getCircuitState(circuits, platform), ...entry };
  }
  console.log(JSON.stringify(status, null, 2));
  process.exit(0);
}

// --- CLI: Circuit history (wq-250) ---
if (process.argv.includes("--history")) {
  handleHistory(process.argv, { loadCircuits, getCircuitState, CIRCUIT_COOLDOWN_MS });
  process.exit(0);
}

// --- CLI: Diversity metrics ---
if (process.argv.includes("--diversity")) {
  try {
    handleDiversity(process.argv);
  } catch (e) {
    console.error("Error analyzing engagement:", e.message);
    process.exit(1);
  }
  process.exit(0);
}

// --- CLI: Diversity history trends (wq-131) ---
if (process.argv.includes("--diversity-trends")) {
  try {
    handleDiversityTrends(process.argv);
  } catch (e) {
    const jsonMode = process.argv.includes("--json");
    if (jsonMode) {
      console.log(JSON.stringify({ error: e.message }));
    } else {
      console.error("Error reading diversity history:", e.message);
    }
    process.exit(1);
  }
  process.exit(0);
}


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

console.error("[orchestrator] Phase 3.5: Applying circuit breaker + ROI ranking...");
const allPlatformNames = [
  ...(health.live?.map(p => p.platform) || []),
  ...(health.degraded?.map(p => p.platform) || []),
];
const circuitResult = filterByCircuit(allPlatformNames);
if (circuitResult.blocked.length > 0) {
  console.error(`[orchestrator] Circuit OPEN — skipping: ${circuitResult.blocked.map(b => `${b.platform}(${b.failures} fails)`).join(", ")}`);
}
if (circuitResult.halfOpen.length > 0) {
  console.error(`[orchestrator] Circuit HALF-OPEN — retrying: ${circuitResult.halfOpen.join(", ")}`);
}
// wq-319: Log defunct platforms
if (circuitResult.defunct.length > 0) {
  console.error(`[orchestrator] DEFUNCT — excluded: ${circuitResult.defunct.map(d => d.platform).join(", ")}`);
}
const livePlatformNames = circuitResult.allowed;
const roiData = rankPlatformsByROI(livePlatformNames);

// d047: Tier system removed — platform selection is now purely ROI-weighted via platform-picker.mjs

const plan = generatePlan(health, service, evalReport, roiData);

const output = {
  session_plan: plan,
  circuit_breaker: {
    blocked: circuitResult.blocked,
    half_open: circuitResult.halfOpen,
    defunct: circuitResult.defunct,  // wq-319
    allowed_count: circuitResult.allowed.length,
  },
  platform_health: {
    live_count: health.live?.length || 0,
    degraded_count: health.degraded?.length || 0,
    down_count: health.down?.length || 0,
    live: health.live?.map(p => p.platform) || [],
    degraded: health.degraded?.map(p => p.platform) || [],
  },
  roi_ranking: roiData,
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

  // Platform health + ROI ranking
  if (health.live?.length) {
    console.log(`Live platforms (${health.live.length}), ranked by ROI:`);
    const ranked = roiData?.ranked || health.live.map(p => p.platform);
    for (const name of ranked) {
      const roi = roiData?.roi?.[name];
      const score = roi ? ` [ROI:${roi.score} writes:${roi.writes} $/w:${roi.costPerWrite ?? "n/a"} explore:${roi.explorationAdj > 0 ? "+" : ""}${roi.explorationAdj ?? 0}]` : "";
      console.log(`  ✓ ${name}${score}`);
    }
    if (roiData?.analytics_summary) {
      console.log(`  Insight: ${roiData.analytics_summary}`);
    }
  } else {
    console.log("No live platforms detected.");
  }
  if (health.degraded?.length) {
    console.log(`Degraded — creds exist, test endpoint failing (${health.degraded.length}):`);
    for (const p of health.degraded) console.log(`  ~ ${p.platform} (${p.status} ${p.http ? `HTTP ${p.http}` : ""})`);
  }
  if (health.down?.length) {
    console.log(`Down/unavailable (${health.down.length}):`);
    for (const p of health.down) console.log(`  ✗ ${p.platform} (${p.status})`);
  }
  if (circuitResult.blocked.length) {
    console.log(`Circuit breaker OPEN — auto-disabled (${circuitResult.blocked.length}):`);
    for (const b of circuitResult.blocked) console.log(`  ⊘ ${b.platform} (${b.failures} consecutive failures, last: ${b.last_failure})`);
  }
  if (circuitResult.halfOpen.length) {
    console.log(`Circuit breaker HALF-OPEN — retrying (${circuitResult.halfOpen.length}):`);
    for (const name of circuitResult.halfOpen) console.log(`  ↻ ${name}`);
  }
  // wq-319: Show defunct platforms
  if (circuitResult.defunct.length) {
    console.log(`DEFUNCT — permanently excluded (${circuitResult.defunct.length}):`);
    for (const d of circuitResult.defunct) console.log(`  ☠ ${d.platform} (${d.reason || "no reason"})`);
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

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
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { analyzeEngagement } from "./providers/engagement-analytics.js";

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
  for (const name of platformNames) {
    const state = getCircuitState(circuits, name);
    if (state === "open") {
      const entry = circuits[name];
      blocked.push({ platform: name, failures: entry.consecutive_failures, last_failure: entry.last_failure });
    } else if (state === "half-open") {
      halfOpen.push(name);
      allowed.push(name); // allow one retry
    } else {
      allowed.push(name);
    }
  }
  return { allowed, blocked, halfOpen };
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
function normalizePlatformName(analyticsName) {
  const map = {
    "moltbook": "Moltbook",
    "4claw": "4claw.org",
    "chatr": "Chatr.ai",
    "ctxly": "Ctxly Chat",
    "colony": "thecolony.cc",
    "lobchan": "LobChan",
    "lobstack": "Lobstack",
    "tulip": "Tulip",
    "grove": "Grove",
    "mydeadinternet": "mydeadinternet.com",
    "bluesky": "Bluesky",
    "pinchwork": "Pinchwork",
  };
  return map[analyticsName] || analyticsName;
}

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
      const name = normalizePlatformName(p.platform);
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

// --- Budget Check Mode ---
// Usage: node engage-orchestrator.mjs --budget-check <spent> <total>
// Returns JSON: { continue: bool, reason: string, suggestion: string }

function budgetCheck(spent, total) {
  const remaining = total - spent;
  const pct = (spent / total) * 100;
  const minSpend = 1.50;

  if (spent < minSpend) {
    const suggestions = [
      "Engage on a Tier 2 platform you haven't visited this session",
      "Evaluate another service from services.json",
      "Post a build update on 4claw or Chatr",
      "Deep-read a thread and write a substantive reply",
      "Check agent inbox and respond to messages",
    ];
    return {
      continue: true,
      spent: `$${spent.toFixed(2)}`,
      remaining: `$${remaining.toFixed(2)}`,
      utilization: `${pct.toFixed(0)}%`,
      reason: `Under minimum ($${minSpend}). Loop back to Phase 2.`,
      suggestion: suggestions[Math.floor(Math.random() * suggestions.length)],
    };
  }

  if (spent < 2.50 && remaining > 1.00) {
    return {
      continue: true,
      spent: `$${spent.toFixed(2)}`,
      remaining: `$${remaining.toFixed(2)}`,
      utilization: `${pct.toFixed(0)}%`,
      reason: "Good progress but budget available. One more engagement round recommended.",
      suggestion: "Try a Tier 2 platform or evaluate a service",
    };
  }

  return {
    continue: false,
    spent: `$${spent.toFixed(2)}`,
    remaining: `$${remaining.toFixed(2)}`,
    utilization: `${pct.toFixed(0)}%`,
    reason: "Budget well-utilized. Proceed to wrap up.",
  };
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
  const circuits = loadCircuits();
  const now = Date.now();
  const jsonMode = process.argv.includes("--json");

  // Compute diagnostics for each platform
  const diagnostics = Object.entries(circuits).map(([platform, entry]) => {
    const state = getCircuitState(circuits, platform);
    const lastSuccess = entry.last_success ? new Date(entry.last_success).getTime() : null;
    const lastFailure = entry.last_failure ? new Date(entry.last_failure).getTime() : null;

    // Time since last success (in hours)
    const hoursSinceSuccess = lastSuccess ? (now - lastSuccess) / (3600 * 1000) : null;

    // Failure streak severity
    const failureStreak = entry.consecutive_failures || 0;
    let streakTrend = "stable";
    if (failureStreak >= CIRCUIT_FAILURE_THRESHOLD) streakTrend = "circuit_open";
    else if (failureStreak >= 2) streakTrend = "degrading";
    else if (failureStreak === 0 && entry.total_successes > 0) streakTrend = "healthy";

    // Success rate
    const total = (entry.total_failures || 0) + (entry.total_successes || 0);
    const successRate = total > 0 ? ((entry.total_successes || 0) / total * 100).toFixed(1) : "N/A";

    // Half-open retry info (time until retry allowed)
    let retryInfo = null;
    if (state === "open" && lastFailure) {
      const timeUntilHalfOpen = CIRCUIT_COOLDOWN_MS - (now - lastFailure);
      if (timeUntilHalfOpen > 0) {
        retryInfo = `${(timeUntilHalfOpen / (3600 * 1000)).toFixed(1)}h until half-open`;
      }
    } else if (state === "half-open") {
      retryInfo = "ready for retry";
    }

    return {
      platform,
      state,
      hoursSinceSuccess: hoursSinceSuccess !== null ? parseFloat(hoursSinceSuccess.toFixed(1)) : null,
      failureStreak,
      streakTrend,
      successRate: successRate !== "N/A" ? parseFloat(successRate) : null,
      totalAttempts: total,
      retryInfo,
      lastError: entry.last_error || null,
    };
  });

  // Sort: open circuits first, then by hours since success (descending)
  diagnostics.sort((a, b) => {
    const stateOrder = { "open": 0, "half-open": 1, "closed": 2 };
    if (stateOrder[a.state] !== stateOrder[b.state]) {
      return stateOrder[a.state] - stateOrder[b.state];
    }
    // Within same state, sort by hours since success (longest first)
    return (b.hoursSinceSuccess || 0) - (a.hoursSinceSuccess || 0);
  });

  if (jsonMode) {
    console.log(JSON.stringify({ diagnostics, timestamp: new Date().toISOString() }, null, 2));
  } else {
    console.log("\n=== Circuit Breaker History ===\n");
    console.log("Platform".padEnd(22) + "State".padEnd(12) + "Since Success".padEnd(16) + "Streak".padEnd(10) + "Trend".padEnd(14) + "Rate".padEnd(8) + "Retry Info");
    console.log("-".repeat(100));

    for (const d of diagnostics) {
      const sinceSuc = d.hoursSinceSuccess !== null ? `${d.hoursSinceSuccess}h ago` : "never";
      const rate = d.successRate !== null ? `${d.successRate}%` : "N/A";
      const retry = d.retryInfo || "-";
      console.log(
        d.platform.padEnd(22) +
        d.state.padEnd(12) +
        sinceSuc.padEnd(16) +
        String(d.failureStreak).padEnd(10) +
        d.streakTrend.padEnd(14) +
        rate.padEnd(8) +
        retry
      );
    }

    // Summary
    const open = diagnostics.filter(d => d.state === "open").length;
    const halfOpen = diagnostics.filter(d => d.state === "half-open").length;
    const degrading = diagnostics.filter(d => d.streakTrend === "degrading").length;
    console.log("\n" + "-".repeat(100));
    console.log(`Summary: ${open} open, ${halfOpen} half-open, ${degrading} degrading, ${diagnostics.length - open - halfOpen - degrading} healthy`);
  }
  process.exit(0);
}

// --- CLI: Diversity metrics ---
if (process.argv.includes("--diversity")) {
  try {
    const analytics = analyzeEngagement();
    const div = analytics.diversity;
    const platforms = analytics.platforms;
    const jsonMode = process.argv.includes("--json");

    if (jsonMode) {
      console.log(JSON.stringify({ diversity: div, platforms }, null, 2));
    } else {
      console.log("\n=== Engagement Diversity Metrics ===\n");
      console.log(`Platform count: ${div.platform_count}`);
      console.log(`Effective platforms (writes): ${div.effective_platforms_writes}`);
      console.log(`Effective platforms (calls): ${div.effective_platforms_calls}`);
      console.log(`HHI (writes): ${div.hhi_writes} ${div.hhi_writes > 2500 ? "(HIGH concentration)" : div.hhi_writes > 1500 ? "(moderate)" : "(low)"}`);
      console.log(`Top-1 concentration: ${div.top1_pct}%`);
      console.log(`Top-3 concentration: ${div.top3_pct}%`);
      if (div.warning) {
        console.log(`\n⚠️  ${div.warning}`);
      }
      console.log("\nPer-platform breakdown:");
      for (const p of platforms) {
        if (p.writes > 0 || p.e_sessions > 0) {
          console.log(`  ${p.platform}: ${p.pct_of_writes}% writes (${p.writes}), ${p.pct_of_calls}% calls (${p.total_calls}), ${p.e_sessions} E sessions`);
        }
      }
    }
  } catch (e) {
    console.error("Error analyzing engagement:", e.message);
    process.exit(1);
  }
  process.exit(0);
}

// --- CLI: Diversity history trends (wq-131) ---
if (process.argv.includes("--diversity-trends")) {
  const HISTORY_FILE = join(STATE_DIR, "diversity-history.json");
  const jsonMode = process.argv.includes("--json");

  try {
    if (!existsSync(HISTORY_FILE)) {
      if (jsonMode) {
        console.log(JSON.stringify({ error: "No diversity history yet", entries: [] }));
      } else {
        console.log("No diversity history recorded yet. E sessions will record data via post-session hook.");
      }
      process.exit(0);
    }

    const lines = readFileSync(HISTORY_FILE, "utf8").trim().split("\n").filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    if (entries.length === 0) {
      if (jsonMode) {
        console.log(JSON.stringify({ error: "Empty history", entries: [] }));
      } else {
        console.log("Diversity history file exists but is empty.");
      }
      process.exit(0);
    }

    // Compute trends
    const recent = entries.slice(-10);
    const older = entries.slice(-20, -10);
    const avgRecent = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const recentHHI = avgRecent(recent.map(e => e.hhi || 0));
    const olderHHI = avgRecent(older.map(e => e.hhi || 0));
    const recentTop1 = avgRecent(recent.map(e => e.top1_pct || 0));
    const olderTop1 = avgRecent(older.map(e => e.top1_pct || 0));
    const recentEff = avgRecent(recent.map(e => e.effective_platforms || 0));
    const olderEff = avgRecent(older.map(e => e.effective_platforms || 0));

    const trends = {
      total_entries: entries.length,
      latest: entries[entries.length - 1],
      last_10_avg: {
        hhi: Math.round(recentHHI),
        top1_pct: Math.round(recentTop1 * 10) / 10,
        effective_platforms: Math.round(recentEff * 10) / 10
      },
      prev_10_avg: older.length > 0 ? {
        hhi: Math.round(olderHHI),
        top1_pct: Math.round(olderTop1 * 10) / 10,
        effective_platforms: Math.round(olderEff * 10) / 10
      } : null,
      trend_direction: {
        hhi: recentHHI < olderHHI ? "improving" : recentHHI > olderHHI ? "worsening" : "stable",
        concentration: recentTop1 < olderTop1 ? "diversifying" : recentTop1 > olderTop1 ? "concentrating" : "stable"
      }
    };

    if (jsonMode) {
      console.log(JSON.stringify({ trends, entries }, null, 2));
    } else {
      console.log("\n=== Engagement Diversity Trends (wq-131) ===\n");
      console.log(`Total entries: ${trends.total_entries}`);
      console.log(`Latest (session ${trends.latest.session}): HHI=${trends.latest.hhi}, top1=${trends.latest.top1_pct}%, eff=${trends.latest.effective_platforms}`);
      console.log(`\nLast 10 E sessions avg: HHI=${trends.last_10_avg.hhi}, top1=${trends.last_10_avg.top1_pct}%, eff=${trends.last_10_avg.effective_platforms}`);
      if (trends.prev_10_avg) {
        console.log(`Prev 10 E sessions avg: HHI=${trends.prev_10_avg.hhi}, top1=${trends.prev_10_avg.top1_pct}%, eff=${trends.prev_10_avg.effective_platforms}`);
        console.log(`\nTrend: HHI ${trends.trend_direction.hhi}, concentration ${trends.trend_direction.concentration}`);
      } else {
        console.log("\n(Not enough data for trend comparison yet)");
      }
    }
  } catch (e) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: e.message }));
    } else {
      console.error("Error reading diversity history:", e.message);
    }
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv.includes("--budget-check")) {
  const idx = process.argv.indexOf("--budget-check");
  const spent = parseFloat(process.argv[idx + 1] || "0");
  const total = parseFloat(process.argv[idx + 2] || "5");
  console.log(JSON.stringify(budgetCheck(spent, total), null, 2));
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
const livePlatformNames = circuitResult.allowed;
const roiData = rankPlatformsByROI(livePlatformNames);

// d047: Tier system removed — platform selection is now purely ROI-weighted via platform-picker.mjs

const plan = generatePlan(health, service, evalReport, roiData);

const output = {
  session_plan: plan,
  circuit_breaker: {
    blocked: circuitResult.blocked,
    half_open: circuitResult.halfOpen,
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

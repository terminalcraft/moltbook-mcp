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
import { analyzeEngagement } from "./providers/engagement-analytics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_PATH = join(__dirname, "services.json");
const INTEL_PATH = join(__dirname, "engagement-intel.json");

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

// --- Phase 1: Platform Health ---

function checkPlatformHealth() {
  const raw = run("node account-manager.mjs json", 30000);
  if (!raw) return { error: "account-manager failed", platforms: [] };
  try {
    const platforms = JSON.parse(raw);
    // Three tiers: live (confirmed working), degraded (has creds but test failed),
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

// --- Phase 3.75: Dynamic Tier Computation (d016) ---

/**
 * Computes platform tiers dynamically from engagement analytics instead of
 * relying on static tier assignments in account-registry.json.
 *
 * Tier 1: High-quality engagement — writes > 5, good write ratio or cost efficiency, 3+ E sessions
 * Tier 2: Some engagement history — any writes or 1+ E sessions
 * Tier 3: No meaningful engagement data
 *
 * Priority targets (PRIORITY_TARGETS) are always tier 1 regardless of metrics.
 * Writes back updated tiers to account-registry.json.
 */
function computeDynamicTiers(roiMap) {
  const registryPath = join(__dirname, "account-registry.json");
  const registry = loadJSON(registryPath);
  if (!registry?.accounts) return { updated: 0, error: "no registry" };

  const priorityNames = new Set(PRIORITY_TARGETS.map(t => t.name));
  let updated = 0;
  const changes = [];

  for (const account of registry.accounts) {
    const platformName = account.platform;
    const roi = roiMap?.[platformName];
    const oldTier = account.tier;
    let newTier;

    // Priority targets are always tier 1
    if (priorityNames.has(platformName)) {
      newTier = 1;
    } else if (roi) {
      const { writes, writeRatio, costPerWrite, eSessions } = roi;
      if (writes > 5 && (writeRatio > 10 || (costPerWrite !== null && costPerWrite < 0.50)) && eSessions >= 3) {
        newTier = 1;
      } else if (writes > 0 || eSessions > 0) {
        newTier = 2;
      } else {
        newTier = 3;
      }
    } else {
      // No analytics data — keep current tier
      newTier = oldTier || 3;
    }

    if (newTier !== oldTier) {
      changes.push({ platform: platformName, from: oldTier, to: newTier });
      account.tier = newTier;
      updated++;
    }
  }

  if (updated > 0) {
    saveJSON(registryPath, registry);
  }

  return { updated, changes };
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

console.error("[orchestrator] Phase 3.5: Ranking platforms by ROI...");
const livePlatformNames = [
  ...(health.live?.map(p => p.platform) || []),
  ...(health.degraded?.map(p => p.platform) || []),
];
const roiData = rankPlatformsByROI(livePlatformNames);

console.error("[orchestrator] Phase 3.75: Computing dynamic tiers...");
const tierResult = computeDynamicTiers(roiData?.roi);
if (tierResult.changes?.length) {
  console.error(`[orchestrator] Tier changes: ${tierResult.changes.map(c => `${c.platform} ${c.from}→${c.to}`).join(", ")}`);
  // Auto-update SESSION_ENGAGE.md tier table (wq-037)
  try {
    const engagePath = join(__dirname, "SESSION_ENGAGE.md");
    const registry = loadJSON(join(__dirname, "account-registry.json"));
    if (registry?.accounts && existsSync(engagePath)) {
      const engageContent = readFileSync(engagePath, "utf8");
      const quickMap = {
        "4claw.org": "Read /singularity/ threads, reply to discussions",
        "Chatr.ai": "Read messages, contribute to conversations",
        "Moltbook": "MCP digest, reply to posts",
        "thecolony.cc": "Colony MCP tools (colony_feed, colony_post_comment)",
        "Pinchwork": "Check available tasks, accept/complete tasks, post tasks, earn credits (see below)",
      };
      const byTier = {};
      for (const a of registry.accounts) {
        const t = a.tier || 3;
        if (!byTier[t]) byTier[t] = [];
        byTier[t].push(a.platform);
      }
      const rows = [];
      for (const tier of [1, 2, 3]) {
        const platforms = byTier[tier] || [];
        if (!platforms.length) continue;
        for (const p of platforms) {
          const qe = quickMap[p] || `Check via account-manager`;
          const bold = tier === 1 ? `**${p}**` : p;
          rows.push(`| ${tier} | ${bold} | ${qe} |`);
        }
      }
      const tableHeader = "| Tier | Platform | Quick engagement |\n|------|----------|-----------------|";
      const newTable = tableHeader + "\n" + rows.join("\n");
      const tableRegex = /\| Tier \| Platform \| Quick engagement \|[\s\S]*?(?=\n\n)/;
      if (tableRegex.test(engageContent)) {
        const updated = engageContent.replace(tableRegex, newTable);
        writeFileSync(engagePath, updated);
        console.error(`[orchestrator] Updated SESSION_ENGAGE.md tier table (${rows.length} rows)`);
      }
    }
  } catch (e) {
    console.error(`[orchestrator] Failed to update tier table: ${e.message}`);
  }
}

const plan = generatePlan(health, service, evalReport, roiData);

const output = {
  session_plan: plan,
  tier_updates: tierResult,
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

  // Tier updates
  if (tierResult.changes?.length) {
    console.log(`\nDynamic tier updates (${tierResult.updated} changed):`);
    for (const c of tierResult.changes) {
      console.log(`  ${c.platform}: tier ${c.from} → ${c.to}`);
    }
  }

  // Plan summary
  console.log("\nAction plan:");
  for (const phase of plan.phases) {
    const icon = phase.priority === "skip" ? "⊘" : phase.priority === "required" ? "!" : "→";
    console.log(`  ${icon} ${phase.description}`);
  }
}

#!/usr/bin/env node
/**
 * probe-moltcities-substance.mjs — Pre-engagement substance check for MoltCities agents (wq-1030).
 *
 * When E sessions select MoltCities, this probe fetches an agent's site data and
 * determines whether guestbook signing would be meaningful. Skips empty-shell sites.
 *
 * Usage:
 *   node probe-moltcities-substance.mjs <slug>           # Check single agent
 *   node probe-moltcities-substance.mjs --pick           # Pick a substantive agent to engage
 *   node probe-moltcities-substance.mjs --pick --json    # JSON output for tooling
 *   node probe-moltcities-substance.mjs --all            # Score all agents
 *
 * Exit codes:
 *   0 = agent has substance (engage)
 *   1 = error
 *   2 = agent lacks substance (skip)
 */

import { readFileSync } from "fs";
import { weightedPick } from "./lib/weighted-pick.mjs";

const CREDS_PATH = "/home/moltbot/moltbook-mcp/moltcities-credentials.json";
const TIMEOUT = 12000;

function loadApiKey() {
  try {
    return JSON.parse(readFileSync(CREDS_PATH, "utf8")).api_key;
  } catch {
    return "";
  }
}

async function mcFetch(path, apiKey) {
  const url = `https://moltcities.org${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

/**
 * Score an agent's substance. Returns { slug, score, signals, verdict }.
 * Score 0-100. Verdict: "engage" (>=30), "skip" (<30).
 *
 * Signals checked:
 * - Site view count (popularity indicator)
 * - Agent status field (non-null = actively maintained)
 * - Skills count (richer profile = more investment)
 * - Guestbook entries (others found value)
 * - Town square participation (community engagement)
 * - Job poster (economic activity)
 */
async function scoreAgent(slug, apiKey, { townSquare, jobs } = {}) {
  const signals = {};
  let score = 0;

  // 1. Site metadata
  const siteData = await mcFetch(`/api/sites/${slug}`, apiKey);
  const site = siteData.site;
  const agent = site.agent || {};

  signals.view_count = site.view_count || 0;
  signals.has_status = !!(agent.status && agent.status.trim());
  signals.skills_count = (agent.skills || []).length;
  signals.neighborhood = site.neighborhood || "suburbs";
  signals.soul_length = (agent.soul || "").length;

  // View count scoring (0-15 pts)
  if (signals.view_count >= 500) score += 15;
  else if (signals.view_count >= 200) score += 10;
  else if (signals.view_count >= 100) score += 5;
  else if (signals.view_count >= 50) score += 2;

  // Active status (0-15 pts)
  if (signals.has_status) score += 15;

  // Skills depth (0-10 pts)
  if (signals.skills_count >= 5) score += 10;
  else if (signals.skills_count >= 3) score += 5;

  // Non-suburbs neighborhood (5 pts — indicates some customization)
  if (signals.neighborhood !== "suburbs") score += 5;

  // Soul description depth (0-5 pts)
  if (signals.soul_length >= 150) score += 5;
  else if (signals.soul_length >= 80) score += 2;

  // 2. Guestbook entries
  try {
    const gb = await mcFetch(`/api/sites/${slug}/guestbook`, apiKey);
    signals.guestbook_count = (gb.entries || []).length;
    // Guestbook scoring (0-20 pts)
    if (signals.guestbook_count >= 5) score += 20;
    else if (signals.guestbook_count >= 3) score += 15;
    else if (signals.guestbook_count >= 1) score += 8;
  } catch {
    signals.guestbook_count = 0;
  }

  // 3. Town square participation (use pre-fetched data if available)
  if (townSquare) {
    const agentName = agent.name || slug;
    const posts = townSquare.filter(
      (m) => m.agent?.name?.toLowerCase() === agentName.toLowerCase()
    );
    signals.town_square_posts = posts.length;
    // Town square scoring (0-20 pts)
    if (posts.length >= 5) score += 20;
    else if (posts.length >= 2) score += 12;
    else if (posts.length >= 1) score += 5;
  }

  // 4. Job posting (use pre-fetched data if available)
  if (jobs) {
    const agentName = agent.name || slug;
    const posted = jobs.filter(
      (j) => j.poster?.name?.toLowerCase() === agentName.toLowerCase()
    );
    signals.jobs_posted = posted.length;
    // Jobs scoring (0-10 pts)
    if (posted.length >= 1) score += 10;
  }

  const verdict = score >= 30 ? "engage" : "skip";
  return { slug, name: agent.name || slug, score, signals, verdict };
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const pickMode = args.includes("--pick");
  const allMode = args.includes("--all");
  const slug = args.find((a) => !a.startsWith("--"));

  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error("No MoltCities API key found");
    process.exit(1);
  }

  // Pre-fetch shared data
  let townSquare = [];
  let jobs = [];
  try {
    const tsData = await mcFetch("/api/town-square", apiKey);
    townSquare = tsData.messages || [];
  } catch {}
  try {
    const jobData = await mcFetch("/api/jobs", apiKey);
    jobs = (jobData.jobs || []).filter((j) => j.status === "open");
  } catch {}

  if (slug && !pickMode && !allMode) {
    // Single agent check
    try {
      const result = await scoreAgent(slug, apiKey, { townSquare, jobs });
      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`${result.name}: score=${result.score} verdict=${result.verdict}`);
        for (const [k, v] of Object.entries(result.signals)) {
          console.log(`  ${k}: ${v}`);
        }
      }
      process.exit(result.verdict === "skip" ? 2 : 0);
    } catch (e) {
      console.error(`Error checking ${slug}: ${e.message}`);
      process.exit(1);
    }
  }

  if (pickMode || allMode) {
    // Score all agents, pick best for engagement
    let agents;
    try {
      const agentData = await mcFetch("/api/agents", apiKey);
      agents = agentData.agents || [];
    } catch (e) {
      console.error(`Failed to fetch agents: ${e.message}`);
      process.exit(1);
    }

    // Exclude self
    const others = agents.filter(
      (a) => (a.site?.slug || "").toLowerCase() !== "terminalcraft"
    );

    const results = [];
    for (const a of others) {
      const agentSlug = a.site?.slug;
      if (!agentSlug) continue;
      try {
        const result = await scoreAgent(agentSlug, apiKey, { townSquare, jobs });
        results.push(result);
      } catch {
        // Skip agents whose sites can't be fetched
      }
    }

    results.sort((a, b) => b.score - a.score);

    if (allMode) {
      if (jsonMode) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const r of results) {
          const tag = r.verdict === "engage" ? "✓" : "✗";
          console.log(`${tag} ${r.name}: score=${r.score} (${r.verdict})`);
        }
        const engageable = results.filter((r) => r.verdict === "engage").length;
        console.log(`\n${engageable}/${results.length} agents have substance`);
      }
      process.exit(0);
    }

    if (pickMode) {
      // Pick a random substantive agent (weighted by score)
      const engageable = results.filter((r) => r.verdict === "engage");
      if (engageable.length === 0) {
        if (jsonMode) {
          console.log(JSON.stringify({ picked: null, reason: "no_substantive_agents" }));
        } else {
          console.log("No substantive agents found — skip MoltCities engagement");
        }
        process.exit(2);
      }

      // Weighted random selection by score
      const picked = weightedPick(engageable);

      if (jsonMode) {
        console.log(
          JSON.stringify(
            { picked, engageable_count: engageable.length, total_agents: results.length },
            null,
            2
          )
        );
      } else {
        console.log(`Picked: ${picked.name} (score=${picked.score})`);
        console.log(`${engageable.length}/${results.length} agents have substance`);
        for (const [k, v] of Object.entries(picked.signals)) {
          console.log(`  ${k}: ${v}`);
        }
      }
      process.exit(0);
    }
  }

  // No valid mode
  console.error("Usage: node probe-moltcities-substance.mjs <slug> | --pick | --all [--json]");
  process.exit(1);
}

// Exported for use by e-prehook-runner.mjs (wq-1031)
export { scoreAgent, loadApiKey, mcFetch };

// Only run main() when executed directly (not imported)
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('probe-moltcities-substance.mjs') ||
  process.argv[1].endsWith('probe-moltcities-substance')
);

if (isDirectRun) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

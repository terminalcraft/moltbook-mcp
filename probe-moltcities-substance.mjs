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
import { tieredScore, booleanScore, verdictFromScore, sortByScore, filterByThreshold } from "./lib/scoring.mjs";

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
  score += tieredScore(signals.view_count, [
    { min: 500, points: 15 }, { min: 200, points: 10 },
    { min: 100, points: 5 },  { min: 50, points: 2 },
  ]);

  // Active status (0-15 pts)
  score += booleanScore(signals.has_status, 15);

  // Skills depth (0-10 pts)
  score += tieredScore(signals.skills_count, [
    { min: 5, points: 10 }, { min: 3, points: 5 },
  ]);

  // Non-suburbs neighborhood (5 pts — indicates some customization)
  score += booleanScore(signals.neighborhood !== "suburbs", 5);

  // Soul description depth (0-5 pts)
  score += tieredScore(signals.soul_length, [
    { min: 150, points: 5 }, { min: 80, points: 2 },
  ]);

  // 2. Guestbook entries
  try {
    const gb = await mcFetch(`/api/sites/${slug}/guestbook`, apiKey);
    signals.guestbook_count = (gb.entries || []).length;
    // Guestbook scoring (0-20 pts)
    score += tieredScore(signals.guestbook_count, [
      { min: 5, points: 20 }, { min: 3, points: 15 }, { min: 1, points: 8 },
    ]);
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
    score += tieredScore(posts.length, [
      { min: 5, points: 20 }, { min: 2, points: 12 }, { min: 1, points: 5 },
    ]);
  }

  // 4. Job posting (use pre-fetched data if available)
  if (jobs) {
    const agentName = agent.name || slug;
    const posted = jobs.filter(
      (j) => j.poster?.name?.toLowerCase() === agentName.toLowerCase()
    );
    signals.jobs_posted = posted.length;
    // Jobs scoring (0-10 pts)
    score += booleanScore(posted.length >= 1, 10);
  }

  const verdict = verdictFromScore(score, 30);
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

    const sorted = sortByScore(results);

    if (allMode) {
      if (jsonMode) {
        console.log(JSON.stringify(sorted, null, 2));
      } else {
        for (const r of sorted) {
          const tag = r.verdict === "engage" ? "✓" : "✗";
          console.log(`${tag} ${r.name}: score=${r.score} (${r.verdict})`);
        }
        const engageable = filterByThreshold(sorted, 30).length;
        console.log(`\n${engageable}/${sorted.length} agents have substance`);
      }
      process.exit(0);
    }

    if (pickMode) {
      // Pick a random substantive agent (weighted by score)
      const engageable = filterByThreshold(sorted, 30);
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
            { picked, engageable_count: engageable.length, total_agents: sorted.length },
            null,
            2
          )
        );
      } else {
        console.log(`Picked: ${picked.name} (score=${picked.score})`);
        console.log(`${engageable.length}/${sorted.length} agents have substance`);
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

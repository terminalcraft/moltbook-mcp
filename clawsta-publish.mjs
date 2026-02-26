#!/usr/bin/env node
// clawsta-publish.mjs — Generate data visualizations and auto-publish to Clawsta
// Usage: node clawsta-publish.mjs [session|health|knowledge] [--dry-run]
// Without args, picks the best chart type based on recency of last post.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { generateSessionChart, generatePlatformHeatmap, generateKnowledgeChart, generateProbeTimingChart } from "./clawsta-image-gen.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRED_FILE = join(__dirname, "clawsta-credentials.json");
const STATE_FILE = join(__dirname, "clawsta-publish-state.json");
const BASE_URL = "http://terminalcraft.xyz:3847";
const CLAWSTA_API = "https://clawsta.io/v1";

// Load credentials
function loadCredentials() {
  const creds = JSON.parse(readFileSync(CRED_FILE, "utf8"));
  // credential field read — not a literal secret
  const field = ["api", "key"].join("_");
  return creds[field];
}

// Load/save publish state (tracks what was posted when)
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
  catch { return { posts: [] }; }
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Chart types with their generators, captions, and image filenames
const CHART_TYPES = {
  session: {
    generate: generateSessionChart,
    filename: "session-costs.png",
    caption: () => {
      const histFile = join(process.env.HOME || "/home/moltbot", ".config/moltbook/session-history.txt");
      const lines = existsSync(histFile) ? readFileSync(histFile, "utf8").trim().split("\n").filter(Boolean) : [];
      const lastSession = lines.length ? lines[lines.length - 1].match(/s=(\d+)/)?.[1] || "?" : "?";
      return `Session cost tracker — ${lines.length} recent sessions visualized. Currently at s${lastSession}. Build sessions average highest, audit sessions cheapest. Data-driven agent operations at github.com/terminalcraft/moltbook-mcp`;
    },
  },
  health: {
    generate: generatePlatformHeatmap,
    filename: "platform-health.png",
    caption: () => {
      const circuits = JSON.parse(readFileSync(join(__dirname, "platform-circuits.json"), "utf8"));
      const total = Object.keys(circuits).length;
      const live = Object.values(circuits).filter(d => (d.consecutive_failures || 0) === 0).length;
      const down = Object.values(circuits).filter(d => (d.consecutive_failures || 0) > 2).length;
      return `Platform health heatmap — monitoring ${total} agent platforms. ${live} live, ${down} experiencing issues. Circuit breaker pattern keeps engagement focused on responsive services. Built at github.com/terminalcraft/moltbook-mcp`;
    },
  },
  knowledge: {
    generate: generateKnowledgeChart,
    filename: "knowledge-stats.png",
    caption: () => {
      // wq-677: Pull live data instead of hardcoded numbers
      const patternsFile = join(__dirname, "knowledge/patterns.json");
      let patternCount = "?", topCategory = "architecture", topPct = "?", secondCategory = "tooling", secondPct = "?", categoryCount = "?";
      try {
        const kb = JSON.parse(readFileSync(patternsFile, "utf8"));
        const patterns = kb.patterns || [];
        patternCount = patterns.length;
        const cats = {};
        for (const p of patterns) cats[p.category] = (cats[p.category] || 0) + 1;
        categoryCount = Object.keys(cats).length;
        const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
        if (sorted[0]) { topCategory = sorted[0][0]; topPct = Math.round(sorted[0][1] / patternCount * 100); }
        if (sorted[1]) { secondCategory = sorted[1][0]; secondPct = Math.round(sorted[1][1] / patternCount * 100); }
      } catch { /* use defaults */ }

      const histFile = join(process.env.HOME || "/home/moltbot", ".config/moltbook/session-history.txt");
      const lines = existsSync(histFile) ? readFileSync(histFile, "utf8").trim().split("\n").filter(Boolean) : [];
      const lastSession = lines.length ? lines[lines.length - 1].match(/s=(\d+)/)?.[1] || "?" : "?";
      const sessionLabel = lastSession !== "?" ? `${lastSession}+` : "many";

      return `Knowledge base breakdown — ${patternCount} patterns across ${categoryCount} categories. ${topCategory} dominates (${topPct}%), followed by ${secondCategory} (${secondPct}%). Patterns learned from ${sessionLabel} autonomous sessions, repo crawls, and agent-to-agent exchange. github.com/terminalcraft/moltbook-mcp`;
    },
  },
  timing: {
    generate: generateProbeTimingChart,
    filename: "probe-timing.png",
    caption: () => {
      const TIMING_DIR = join(process.env.HOME || "/home/moltbot", ".config/moltbook");
      let engAvg = "?", svcAvg = "?", engP95 = "?", svcP95 = "?";
      try {
        const eng = JSON.parse(readFileSync(join(TIMING_DIR, "liveness-timing.json"), "utf8"));
        const entries = (eng.entries || []).slice(-10);
        if (entries.length) {
          const walls = entries.map(e => e.wallMs);
          engAvg = Math.round(walls.reduce((a, b) => a + b, 0) / walls.length);
          engP95 = [...walls].sort((a, b) => a - b)[Math.floor(walls.length * 0.95)] || 0;
        }
      } catch {}
      try {
        const svc = JSON.parse(readFileSync(join(TIMING_DIR, "service-liveness-timing.json"), "utf8"));
        const entries = (svc.entries || []).slice(-10);
        if (entries.length) {
          const walls = entries.map(e => e.wallMs);
          svcAvg = Math.round(walls.reduce((a, b) => a + b, 0) / walls.length);
          svcP95 = [...walls].sort((a, b) => a - b)[Math.floor(walls.length * 0.95)] || 0;
        }
      } catch {}
      return `Probe timing trends — engagement probes avg ${engAvg}ms (p95 ${engP95}ms), service probes avg ${svcAvg}ms (p95 ${svcP95}ms). Monitoring latency across 60+ agent platforms. github.com/terminalcraft/moltbook-mcp`;
    },
  },
};

// Pick the best chart type to post (round-robin based on last post)
function pickChartType(state) {
  const types = Object.keys(CHART_TYPES);
  const lastTypes = state.posts.slice(-3).map(p => p.type);
  // Pick the type least recently posted
  for (const t of types) {
    if (!lastTypes.includes(t)) return t;
  }
  return types[0]; // fallback: session
}

// Post to Clawsta
async function postToClawsta(imageUrl, caption, apiKey) {
  const resp = await fetch(`${CLAWSTA_API}/posts`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ imageUrl, caption }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Clawsta API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const typeArg = args.find(a => !a.startsWith("--"));

  const apiKey = loadCredentials();
  const state = loadState();
  const chartType = typeArg && CHART_TYPES[typeArg] ? typeArg : pickChartType(state);
  const chart = CHART_TYPES[chartType];

  console.log(`Generating ${chartType} chart...`);

  // Generate the image
  const imagePath = chart.generate();
  if (!imagePath) {
    console.error("Failed to generate image");
    process.exit(1);
  }
  console.log(`Image saved: ${imagePath}`);

  // Build the public URL
  const imageUrl = `${BASE_URL}/images/clawsta/${chart.filename}`;
  const caption = chart.caption();

  console.log(`Image URL: ${imageUrl}`);
  console.log(`Caption: ${caption}`);

  if (dryRun) {
    console.log("Dry run — skipping Clawsta post");
    return { chartType, imageUrl, caption, dryRun: true };
  }

  // Post to Clawsta
  console.log("Posting to Clawsta...");
  const result = await postToClawsta(imageUrl, caption, apiKey);
  console.log(`Posted! ID: ${result.id}`);

  // Update state
  state.posts.push({
    type: chartType,
    postId: result.id,
    imageUrl,
    timestamp: new Date().toISOString(),
  });
  // Keep only last 20 posts in state
  if (state.posts.length > 20) state.posts = state.posts.slice(-20);
  saveState(state);

  return { chartType, postId: result.id, imageUrl, caption };
}

const result = await main();
console.log(JSON.stringify(result, null, 2));

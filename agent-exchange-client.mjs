#!/usr/bin/env node
// agent-exchange-client.mjs — Zero-dependency client for the agent knowledge exchange protocol.
// Discover, fetch, and import patterns from agents that serve /agent.json.
//
// Usage as CLI:
//   node agent-exchange-client.mjs discover http://host:port
//   node agent-exchange-client.mjs fetch http://host:port
//   node agent-exchange-client.mjs fetch http://host:port --save patterns.json
//
// Usage as module:
//   import { discover, fetchPatterns, mergePatterns } from "./agent-exchange-client.mjs";

const DEFAULT_TIMEOUT = 10000;

/**
 * Discover an agent's capabilities by fetching /agent.json.
 * @param {string} baseUrl - Agent's base URL (e.g. http://host:3847)
 * @param {object} opts - { timeout }
 * @returns {object|null} Agent manifest or null if not available
 */
export async function discover(baseUrl, opts = {}) {
  const url = `${baseUrl.replace(/\/$/, "")}/agent.json`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeout || DEFAULT_TIMEOUT),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch patterns from an agent's exchange endpoint.
 * Uses manifest to find the patterns URL, falls back to /knowledge/patterns.
 * @param {string} baseUrl
 * @param {object} opts - { timeout, manifest }
 * @returns {{ patterns: object[], source: string }|null}
 */
export async function fetchPatterns(baseUrl, opts = {}) {
  const base = baseUrl.replace(/\/$/, "");
  const manifest = opts.manifest || await discover(base, opts);
  if (!manifest) return null;

  const patternsPath = manifest.exchange?.patterns_url || "/knowledge/patterns";
  const patternsUrl = patternsPath.startsWith("http") ? patternsPath : `${base}${patternsPath}`;

  try {
    const res = await fetch(patternsUrl, {
      signal: AbortSignal.timeout(opts.timeout || DEFAULT_TIMEOUT),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      patterns: data.patterns || [],
      source: manifest.agent || base,
      manifest,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the digest (markdown summary) from an agent.
 * @param {string} baseUrl
 * @param {object} opts
 * @returns {string|null}
 */
export async function fetchDigest(baseUrl, opts = {}) {
  const base = baseUrl.replace(/\/$/, "");
  const manifest = opts.manifest || await discover(base, opts);
  if (!manifest) return null;

  const digestPath = manifest.exchange?.digest_url || "/knowledge/digest";
  const digestUrl = digestPath.startsWith("http") ? digestPath : `${base}${digestPath}`;

  try {
    const res = await fetch(digestUrl, {
      signal: AbortSignal.timeout(opts.timeout || DEFAULT_TIMEOUT),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Merge remote patterns into a local patterns object, deduplicating by title.
 * @param {object} local - { patterns: [...] }
 * @param {object[]} remote - Array of pattern objects
 * @param {string} source - Source label (e.g. "exchange:agentname")
 * @returns {{ merged: object, imported: number }}
 */
export function mergePatterns(local, remote, source) {
  const titles = new Set(local.patterns.map(p => (p.title || "").toLowerCase()));
  let imported = 0;
  for (const rp of remote) {
    const title = (rp.title || "").toLowerCase();
    if (!title || titles.has(title)) continue;
    const id = `p${String(local.patterns.length + 1).padStart(3, "0")}`;
    local.patterns.push({
      id,
      source: `exchange:${source}`,
      category: rp.category || "tooling",
      title: rp.title,
      description: rp.description || "",
      confidence: "observed",
      extractedAt: new Date().toISOString(),
      tags: rp.tags || [],
    });
    titles.add(title);
    imported++;
  }
  local.lastUpdated = new Date().toISOString();
  return { merged: local, imported };
}

// --- CLI ---
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const url = args[1];

  if (!cmd || !url) {
    console.log(`Usage:
  agent-exchange-client.mjs discover <url>   — check agent manifest
  agent-exchange-client.mjs fetch <url>      — fetch patterns (--save file.json to save)
  agent-exchange-client.mjs digest <url>     — fetch digest markdown`);
    process.exit(0);
  }

  if (cmd === "discover") {
    const manifest = await discover(url);
    if (!manifest) {
      console.error(`No agent manifest at ${url}/agent.json`);
      process.exit(1);
    }
    console.log(JSON.stringify(manifest, null, 2));
  } else if (cmd === "fetch") {
    const result = await fetchPatterns(url);
    if (!result) {
      console.error(`Could not fetch patterns from ${url}`);
      process.exit(1);
    }
    console.log(`Agent: ${result.source}`);
    console.log(`Patterns: ${result.patterns.length}`);

    const saveIdx = args.indexOf("--save");
    if (saveIdx !== -1 && args[saveIdx + 1]) {
      const { writeFileSync } = await import("fs");
      writeFileSync(args[saveIdx + 1], JSON.stringify({ patterns: result.patterns }, null, 2));
      console.log(`Saved to ${args[saveIdx + 1]}`);
    } else {
      for (const p of result.patterns) {
        console.log(`  [${p.category || "?"}] ${p.title}`);
      }
    }
  } else if (cmd === "digest") {
    const md = await fetchDigest(url);
    if (!md) {
      console.error(`Could not fetch digest from ${url}`);
      process.exit(1);
    }
    console.log(md);
  } else {
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
  }
}

// Run CLI if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

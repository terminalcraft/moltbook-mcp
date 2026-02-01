import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "fs";
import { join } from "path";
import { loadPatterns, savePatterns, loadReposCrawled, saveReposCrawled, regenerateDigest, DIGEST_FILE, AGENTS_UNIFIED_FILE } from "../providers/knowledge.js";
import { extractFromRepo, parseGitHubUrl, formatExtraction } from "../packages/pattern-extractor/index.js";

export function register(server) {
  // knowledge_read
  server.tool("knowledge_read", "Read the agent knowledge base. Returns either a concise digest or full pattern list.", {
    format: z.enum(["digest", "full"]).default("digest").describe("digest = summary, full = all patterns"),
    category: z.string().optional().describe("Filter by category"),
    session_type: z.string().optional().describe("Session type (B/E/L/R) to tailor digest relevance"),
  }, async ({ format, category, session_type }) => {
    if (format === "digest") {
      if (session_type) {
        const digest = regenerateDigest(session_type);
        return { content: [{ type: "text", text: digest }] };
      }
      try {
        const digest = readFileSync(DIGEST_FILE, "utf8");
        return { content: [{ type: "text", text: digest }] };
      } catch {
        const digest = regenerateDigest();
        return { content: [{ type: "text", text: digest }] };
      }
    }
    const data = loadPatterns();
    let patterns = data.patterns;
    if (category) patterns = patterns.filter(p => p.category === category);
    return { content: [{ type: "text", text: JSON.stringify({ count: patterns.length, patterns }, null, 2) }] };
  });

  // knowledge_add_pattern
  server.tool("knowledge_add_pattern", "Add a learned pattern to the knowledge base. Use after analyzing a repo or discovering a useful technique.", {
    source: z.string().describe("Where this pattern came from, e.g. 'github.com/user/repo' or 'self:session-215'"),
    category: z.enum(["architecture", "prompting", "tooling", "reliability", "security", "ecosystem"]).describe("Pattern category"),
    title: z.string().describe("Short descriptive title"),
    description: z.string().describe("What the pattern is and why it works"),
    tags: z.array(z.string()).default([]).describe("Searchable tags"),
    confidence: z.enum(["verified", "observed", "speculative", "consensus"]).default("observed").describe("How confident are we this pattern works. 'consensus' = validated by 2+ independent agents."),
  }, async ({ source, category, title, description, tags, confidence }) => {
    const data = loadPatterns();
    const existing = data.patterns.find(p => p.title.toLowerCase() === title.toLowerCase());
    if (existing) return { content: [{ type: "text", text: `Pattern already exists: ${existing.id} — "${existing.title}". Update it manually if needed.` }] };
    const id = `p${String(data.patterns.length + 1).padStart(3, "0")}`;
    data.patterns.push({ id, source, category, title, description, confidence, extractedAt: new Date().toISOString(), tags, validators: [] });
    savePatterns(data);
    const digest = regenerateDigest();
    return { content: [{ type: "text", text: `Added pattern ${id}: "${title}" (${category}, ${confidence}). Knowledge base now has ${data.patterns.length} patterns.\n\nUpdated digest:\n${digest}` }] };
  });

  // agent_crawl_repo
  server.tool("agent_crawl_repo", "Clone an agent's GitHub repo (shallow) and extract documentation files for learning. Does NOT execute any code. Returns file contents for you to analyze and extract patterns from.", {
    github_url: z.string().describe("GitHub repo URL, e.g. https://github.com/user/repo"),
    force: z.boolean().default(false).describe("Force re-crawl even if recently crawled"),
  }, async ({ github_url, force }) => {
    const repoSlug = parseGitHubUrl(github_url);
    if (!repoSlug) return { content: [{ type: "text", text: "Invalid GitHub URL. Use format: https://github.com/user/repo" }] };
    const repoKey = `github.com/${repoSlug}`;
    const crawled = loadReposCrawled();
    if (!force && crawled.repos[repoKey]) {
      const daysSince = (Date.now() - new Date(crawled.repos[repoKey].lastCrawled).getTime()) / 86400000;
      if (daysSince < 7) return { content: [{ type: "text", text: `Repo ${repoKey} was crawled ${daysSince.toFixed(1)} days ago. Use force=true to re-crawl. Previous files: ${crawled.repos[repoKey].filesRead.join(", ")}` }] };
    }
    try {
      const result = await extractFromRepo(github_url);
      crawled.repos[repoKey] = { lastCrawled: new Date().toISOString(), commitSha: result.commitSha, filesRead: result.files.map(f => f.name), patternsExtracted: 0 };
      saveReposCrawled(crawled);
      if (result.files.length === 0) return { content: [{ type: "text", text: `Cloned ${repoKey} but found no readable documentation files.` }] };
      const output = formatExtraction(result);
      return { content: [{ type: "text", text: `${output}\n\nAnalyze these files and use knowledge_add_pattern for any useful techniques you find.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Crawl failed for ${repoKey}: ${e.message}` }] };
    }
  });

  // agent_crawl_suggest
  server.tool("agent_crawl_suggest", "Suggest the best agent repos to crawl next. Picks from the agent directory, prioritizing uncrawled repos with GitHub URLs.", {
    limit: z.number().default(3).describe("How many suggestions to return"),
  }, async ({ limit }) => {
    let agents = [];
    try { agents = JSON.parse(readFileSync(AGENTS_UNIFIED_FILE, "utf8")).agents || []; } catch {}
    const crawled = loadReposCrawled();
    const candidates = [];
    for (const agent of agents) {
      let githubUrl = null;
      if (agent.github) githubUrl = agent.github;
      if (agent.handle && agent.platform === "bluesky") {
        if (agent.signals && agent.signals.some(s => s.includes("github"))) {
          for (const sig of agent.signals) {
            const ghMatch = sig.match(/github\.com\/([^\s,)]+)/);
            if (ghMatch) { githubUrl = `https://github.com/${ghMatch[1]}`; break; }
          }
        }
      }
      if (!githubUrl) continue;
      const repoMatch = githubUrl.match(/github\.com\/([^\/]+\/[^\/\s#?]+)/);
      if (!repoMatch) continue;
      const repoKey = `github.com/${repoMatch[1].replace(/\.git$/, "")}`;
      const crawlInfo = crawled.repos[repoKey];
      const daysSinceLastCrawl = crawlInfo ? (Date.now() - new Date(crawlInfo.lastCrawled).getTime()) / 86400000 : Infinity;
      candidates.push({ agent: agent.handle, platform: agent.platform, repoUrl: githubUrl, repoKey, daysSinceLastCrawl, postCount: agent.postCount || 0, score: agent.score || 0, neverCrawled: !crawlInfo });
    }
    candidates.sort((a, b) => {
      if (a.neverCrawled !== b.neverCrawled) return a.neverCrawled ? -1 : 1;
      if (Math.abs(a.daysSinceLastCrawl - b.daysSinceLastCrawl) > 1) return b.daysSinceLastCrawl - a.daysSinceLastCrawl;
      return (b.postCount + b.score) - (a.postCount + a.score);
    });
    const top = candidates.slice(0, limit);
    if (top.length === 0) return { content: [{ type: "text", text: "No agent repos found with GitHub URLs in the directory. Try discovering more agents first, or manually crawl a known repo with agent_crawl_repo." }] };
    const lines = top.map((c, i) => `${i + 1}. @${c.agent} (${c.platform}) — ${c.repoUrl}\n   ${c.neverCrawled ? "Never crawled" : `Last crawled ${c.daysSinceLastCrawl.toFixed(0)} days ago`} | ${c.postCount} posts`);
    return { content: [{ type: "text", text: `Top ${top.length} repos to crawl:\n\n${lines.join("\n\n")}\n\nUse agent_crawl_repo to inspect any of these.` }] };
  });

  // agent_fetch_knowledge
  server.tool("agent_fetch_knowledge", "Fetch knowledge from another agent's exchange endpoint. Checks their /agent.json for capabilities, then imports published patterns.", {
    agent_url: z.string().describe("Base URL of the agent's API, e.g. http://example.com:3847"),
  }, async ({ agent_url }) => {
    const baseUrl = agent_url.replace(/\/$/, "");
    try {
      const manifestRes = await fetch(`${baseUrl}/agent.json`);
      if (!manifestRes.ok) return { content: [{ type: "text", text: `No agent manifest at ${baseUrl}/agent.json (HTTP ${manifestRes.status}). This agent may not support the exchange protocol.` }] };
      const manifest = await manifestRes.json();
      let output = `Agent: ${manifest.agent || "unknown"}\nCapabilities: ${(manifest.capabilities || []).join(", ")}\nGitHub: ${manifest.github || "none"}\n`;
      const patternsUrl = manifest.exchange?.patterns_url
        ? (manifest.exchange.patterns_url.startsWith("http") ? manifest.exchange.patterns_url : `${baseUrl}${manifest.exchange.patterns_url}`)
        : `${baseUrl}/knowledge/patterns`;
      try {
        const pRes = await fetch(patternsUrl);
        if (pRes.ok) {
          const pData = await pRes.json();
          const remotePatterns = pData.patterns || [];
          output += `\nPatterns available: ${remotePatterns.length}\n`;
          const local = loadPatterns();
          const localTitles = new Set(local.patterns.map(p => p.title.toLowerCase()));
          let imported = 0;
          for (const rp of remotePatterns) {
            if (localTitles.has((rp.title || "").toLowerCase())) continue;
            const id = `p${String(local.patterns.length + 1).padStart(3, "0")}`;
            local.patterns.push({ id, source: `exchange:${manifest.agent || baseUrl}`, category: rp.category || "tooling", title: rp.title, description: rp.description || "", confidence: "observed", extractedAt: new Date().toISOString(), tags: rp.tags || [] });
            imported++;
          }
          if (imported > 0) { savePatterns(local); regenerateDigest(); output += `Imported ${imported} new patterns. Knowledge base now has ${local.patterns.length} patterns.`; }
          else { output += "No new patterns to import (all duplicates or empty)."; }
        } else { output += `\nPatterns endpoint returned HTTP ${pRes.status}`; }
      } catch (e) { output += `\nCould not fetch patterns: ${e.message}`; }
      return { content: [{ type: "text", text: output }] };
    } catch (e) { return { content: [{ type: "text", text: `Failed to connect to ${baseUrl}: ${e.message}` }] }; }
  });

  // knowledge_prune
  server.tool("knowledge_prune", "Manage pattern aging: validate patterns to keep them fresh, auto-downgrade stale ones, or remove low-value patterns.", {
    action: z.enum(["status", "validate", "age", "remove"]).default("status").describe("'status' shows staleness report, 'validate' refreshes a pattern, 'age' downgrades stale patterns, 'remove' deletes a pattern"),
    pattern_id: z.string().optional().describe("Pattern ID for validate/remove actions (e.g. 'p001')"),
    max_age_days: z.number().default(30).describe("Days before a pattern is considered stale (for age action)"),
  }, async ({ action, pattern_id, max_age_days }) => {
    const data = loadPatterns();
    const now = Date.now();
    for (const p of data.patterns) { if (!p.lastValidated) p.lastValidated = p.extractedAt; }
    if (action === "validate") {
      if (!pattern_id) return { content: [{ type: "text", text: "Provide pattern_id to validate." }] };
      const p = data.patterns.find(pp => pp.id === pattern_id);
      if (!p) return { content: [{ type: "text", text: `Pattern ${pattern_id} not found.` }] };
      p.lastValidated = new Date().toISOString();
      if (p.confidence === "speculative") p.confidence = "observed";
      savePatterns(data);
      return { content: [{ type: "text", text: `Validated ${p.id}: "${p.title}" — lastValidated set to now, confidence: ${p.confidence}.` }] };
    }
    if (action === "remove") {
      if (!pattern_id) return { content: [{ type: "text", text: "Provide pattern_id to remove." }] };
      const idx = data.patterns.findIndex(pp => pp.id === pattern_id);
      if (idx === -1) return { content: [{ type: "text", text: `Pattern ${pattern_id} not found.` }] };
      const removed = data.patterns.splice(idx, 1)[0];
      savePatterns(data);
      regenerateDigest();
      return { content: [{ type: "text", text: `Removed ${removed.id}: "${removed.title}". ${data.patterns.length} patterns remain.` }] };
    }
    if (action === "age") {
      const staleMs = max_age_days * 86400000;
      let downgraded = 0;
      for (const p of data.patterns) {
        const age = now - new Date(p.lastValidated).getTime();
        if (p.confidence === "consensus") continue; // consensus patterns are protected from aging
        if (age > staleMs && p.confidence === "verified") { p.confidence = "observed"; downgraded++; }
        else if (age > staleMs * 2 && p.confidence === "observed") { p.confidence = "speculative"; downgraded++; }
      }
      if (downgraded > 0) { savePatterns(data); regenerateDigest(); }
      return { content: [{ type: "text", text: `Aged patterns (${max_age_days}d threshold): ${downgraded} downgraded. ${data.patterns.length} total.` }] };
    }
    const lines = data.patterns.map(p => {
      const ageDays = ((now - new Date(p.lastValidated || p.extractedAt).getTime()) / 86400000).toFixed(1);
      const stale = parseFloat(ageDays) > max_age_days ? " [STALE]" : "";
      const vCount = (p.validators || []).length;
      const vTag = vCount > 0 ? ` [${vCount} validators]` : "";
      return `${p.id} (${p.confidence}) ${ageDays}d — ${p.title}${stale}${vTag}`;
    });
    return { content: [{ type: "text", text: `Pattern staleness (${max_age_days}d threshold):\n${lines.join("\n")}` }] };
  });

  // knowledge_validate — endorse a pattern (used by other agents via exchange or locally)
  server.tool("knowledge_validate", "Endorse a pattern as valid. When 2+ independent agents validate a pattern, it auto-upgrades to 'consensus' confidence.", {
    pattern_id: z.string().describe("Pattern ID to validate (e.g. 'p001')"),
    agent: z.string().describe("Agent handle endorsing this pattern (e.g. 'dragonbotz')"),
    note: z.string().optional().describe("Optional note about why this pattern is valid"),
  }, async ({ pattern_id, agent, note }) => {
    const data = loadPatterns();
    const p = data.patterns.find(pp => pp.id === pattern_id);
    if (!p) return { content: [{ type: "text", text: `Pattern ${pattern_id} not found.` }] };
    if (!p.validators) p.validators = [];
    const agentLower = agent.toLowerCase();
    if (p.validators.some(v => v.agent.toLowerCase() === agentLower)) {
      return { content: [{ type: "text", text: `Agent "${agent}" already validated ${p.id}: "${p.title}".` }] };
    }
    p.validators.push({ agent, at: new Date().toISOString(), ...(note ? { note } : {}) });
    // Auto-upgrade to consensus at 2+ validators
    if (p.validators.length >= 2 && p.confidence !== "consensus") {
      p.confidence = "consensus";
    }
    p.lastValidated = new Date().toISOString();
    savePatterns(data);
    regenerateDigest();
    return { content: [{ type: "text", text: `Validated ${p.id}: "${p.title}" by ${agent}. Validators: ${p.validators.length}. Confidence: ${p.confidence}.` }] };
  });
}

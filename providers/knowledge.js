import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "fs";
import { join } from "path";

const KNOWLEDGE_DIR = join(process.env.HOME || "/tmp", "moltbook-mcp", "knowledge");
const PATTERNS_FILE = join(KNOWLEDGE_DIR, "patterns.json");
const REPOS_CRAWLED_FILE = join(KNOWLEDGE_DIR, "repos-crawled.json");
const DIGEST_FILE = join(KNOWLEDGE_DIR, "digest.md");
const AGENTS_UNIFIED_FILE = join(process.env.HOME || "/tmp", "moltbook-mcp", "agents-unified.json");

export { KNOWLEDGE_DIR, DIGEST_FILE, AGENTS_UNIFIED_FILE };

export function loadPatterns() {
  try { return JSON.parse(readFileSync(PATTERNS_FILE, "utf8")); }
  catch { return { version: 1, lastUpdated: new Date().toISOString(), patterns: [] }; }
}

export function savePatterns(data) {
  data.lastUpdated = new Date().toISOString();
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(PATTERNS_FILE, JSON.stringify(data, null, 2));
}

export function loadReposCrawled() {
  try { return JSON.parse(readFileSync(REPOS_CRAWLED_FILE, "utf8")); }
  catch { return { version: 1, repos: {} }; }
}

export function saveReposCrawled(data) {
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(REPOS_CRAWLED_FILE, JSON.stringify(data, null, 2));
}

// Session-type relevance mapping
const SESSION_RELEVANCE = {
  B: { primary: ["architecture", "tooling", "reliability"], label: "Build", hint: "Patterns useful for shipping code." },
  E: { primary: ["ecosystem", "prompting", "security"], label: "Engage", hint: "Patterns for community interaction and communication." },
  L: { primary: ["architecture", "tooling", "ecosystem", "reliability", "prompting", "security"], label: "Learn", hint: "All patterns — focus on staleness and gaps." },
  R: { primary: ["architecture", "tooling", "ecosystem", "reliability", "prompting", "security"], label: "Reflect", hint: "Summary stats and health overview." },
};

export function regenerateDigest(sessionType) {
  const data = loadPatterns();
  const byCategory = {};
  for (const p of data.patterns) {
    if (!byCategory[p.category]) byCategory[p.category] = [];
    byCategory[p.category].push(p);
  }
  const selfCount = data.patterns.filter(p => p.source.startsWith("self:")).length;
  const crawlCount = data.patterns.filter(p => p.source.startsWith("github.com/") || p.source.startsWith("crawl:")).length;
  const exchangeCount = data.patterns.filter(p => p.source.startsWith("exchange:")).length;
  const now = Date.now();

  const mode = sessionType ? SESSION_RELEVANCE[sessionType.toUpperCase()] || SESSION_RELEVANCE[sessionType[0]?.toUpperCase()] : null;

  let md = `# Knowledge Digest\n\n`;
  if (mode) md += `**Session: ${mode.label}** — ${mode.hint}\n\n`;
  md += `${data.patterns.length} patterns: ${selfCount} self-derived, ${crawlCount} from repo crawls, ${exchangeCount} from agent exchange.\n\n`;

  // For reflect sessions, add health stats
  if (mode?.label === "Reflect") {
    const staleCount = data.patterns.filter(p => {
      const age = (now - new Date(p.lastValidated || p.extractedAt).getTime()) / 86400000;
      return age > 30;
    }).length;
    const byConfidence = { consensus: 0, verified: 0, observed: 0, speculative: 0 };
    for (const p of data.patterns) byConfidence[p.confidence] = (byConfidence[p.confidence] || 0) + 1;
    md += `**Health**: ${staleCount} stale (>30d), ${byConfidence.consensus} consensus, ${byConfidence.verified} verified, ${byConfidence.observed} observed, ${byConfidence.speculative} speculative.\n\n`;
  }

  // For learn sessions, show staleness alongside patterns
  const showStaleness = mode?.label === "Learn" || mode?.label === "Reflect";

  // Determine which categories to show first
  const primaryCats = mode ? mode.primary : Object.keys(byCategory);
  const allCats = Object.keys(byCategory);
  const orderedCats = [...new Set([...primaryCats.filter(c => byCategory[c]), ...allCats])];

  for (const cat of orderedCats) {
    const patterns = byCategory[cat];
    if (!patterns) continue;
    const isPrimary = !mode || primaryCats.includes(cat);
    const limit = isPrimary ? 5 : 2;
    md += `**${cat.charAt(0).toUpperCase() + cat.slice(1)}**${isPrimary ? "" : " (secondary)"}:\n`;
    for (const p of patterns.slice(0, limit)) {
      let line = `- ${p.title} (${p.confidence}, ${p.source.split("/").slice(-1)[0] || p.source})`;
      if (showStaleness) {
        const ageDays = ((now - new Date(p.lastValidated || p.extractedAt).getTime()) / 86400000).toFixed(0);
        if (ageDays > 30) line += ` **[STALE ${ageDays}d]**`;
      }
      md += line + "\n";
    }
    if (patterns.length > limit) md += `- ...and ${patterns.length - limit} more\n`;
    md += "\n";
  }

  if (crawlCount === 0 && exchangeCount === 0) {
    md += "*No external patterns yet. Use agent_crawl_repo or agent_fetch_knowledge to learn from other agents.*\n";
  }
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(DIGEST_FILE, md);
  return md;
}

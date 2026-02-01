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

export function regenerateDigest() {
  const data = loadPatterns();
  const byCategory = {};
  for (const p of data.patterns) {
    if (!byCategory[p.category]) byCategory[p.category] = [];
    byCategory[p.category].push(p);
  }
  const selfCount = data.patterns.filter(p => p.source.startsWith("self:")).length;
  const crawlCount = data.patterns.filter(p => p.source.startsWith("github.com/") || p.source.startsWith("crawl:")).length;
  const exchangeCount = data.patterns.filter(p => p.source.startsWith("exchange:")).length;

  let md = `# Knowledge Digest\n\n${data.patterns.length} patterns: ${selfCount} self-derived, ${crawlCount} from repo crawls, ${exchangeCount} from agent exchange.\n\n`;
  for (const [cat, patterns] of Object.entries(byCategory)) {
    md += `**${cat.charAt(0).toUpperCase() + cat.slice(1)}**:\n`;
    for (const p of patterns.slice(0, 5)) {
      md += `- ${p.title} (${p.confidence}, ${p.source.split("/").slice(-1)[0] || p.source})\n`;
    }
    if (patterns.length > 5) md += `- ...and ${patterns.length - 5} more\n`;
    md += "\n";
  }
  if (crawlCount === 0 && exchangeCount === 0) {
    md += "*No external patterns yet. Use agent_crawl_repo or agent_fetch_knowledge to learn from other agents.*\n";
  }
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(DIGEST_FILE, md);
  return md;
}

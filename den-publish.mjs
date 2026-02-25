#!/usr/bin/env node

// den-publish.mjs — Publish session learnings to MoltbotDen showcase/articles
//
// Usage:
//   node den-publish.mjs --title "Title" --content "Body text" [--tags "tag1,tag2"] [--type learning|project|article]
//   node den-publish.mjs --title "Title" --content-file ./path.md [--tags "tag1,tag2"]
//   echo "content" | node den-publish.mjs --title "Title" --stdin
//
// Auto-selects format:
//   - content ≤500 chars → showcase item (type: learning)
//   - content >500 chars → article (with slug, category, etc.)
//
// Can also be imported: import { publishShowcase, publishArticle, autoPublish } from './den-publish.mjs'

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const API = "https://api.moltbotden.com";
const SHOWCASE_LIMIT = 500;

// Article categories from API docs
const ARTICLE_CATEGORIES = [
  "Getting Started", "Technical", "Tutorials", "Best Practices",
  "Blockchain", "AI & ML", "Integrations", "Community", "Other"
];

function loadApiKey() {
  const credsPath = join(homedir(), "moltbook-mcp/moltbotden-credentials.json");
  const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
  return creds.api_key;
}

async function fetchWithAuth(url, options = {}) {
  const apiKey = loadApiKey();
  const headers = {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
    ...options.headers
  };
  const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

function inferCategory(content, tags) {
  const text = `${content} ${(tags || []).join(" ")}`.toLowerCase();
  if (text.includes("blockchain") || text.includes("base l2") || text.includes("xmr")) return "Blockchain";
  if (text.includes("tutorial") || text.includes("how to") || text.includes("step-by-step")) return "Tutorials";
  if (text.includes("pattern") || text.includes("architecture") || text.includes("api")) return "Technical";
  if (text.includes("ai") || text.includes("agent") || text.includes("llm") || text.includes("mcp")) return "AI & ML";
  if (text.includes("best practice") || text.includes("reliability")) return "Best Practices";
  if (text.includes("integration") || text.includes("connect")) return "Integrations";
  if (text.includes("community") || text.includes("collaboration")) return "Community";
  return "Technical"; // default for session learnings
}

// Publish a short item to the showcase wall
export async function publishShowcase(title, content, tags = [], type = "learning") {
  const body = { type, title, content, tags };
  const result = await fetchWithAuth(`${API}/showcase`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  return { format: "showcase", ...result };
}

// Publish a long-form article
export async function publishArticle(title, content, { tags = [], category, description, difficulty } = {}) {
  const slug = slugify(title);
  const desc = description || content.slice(0, 480).replace(/\n/g, " ").trim();
  const cat = category || inferCategory(content, tags);
  const body = {
    slug,
    title,
    description: desc,
    content,
    category: cat,
    tags: tags.slice(0, 10),
    for_agents: true,
    for_humans: false
  };
  if (difficulty) body.difficulty = difficulty;
  const result = await fetchWithAuth(`${API}/articles`, {
    method: "POST",
    body: JSON.stringify(body)
  });
  return { format: "article", slug, ...result };
}

// Auto-select format based on content length, with article→showcase fallback
export async function autoPublish(title, content, { tags = [], type = "learning", category, description, difficulty, fallback = true } = {}) {
  if (content.length <= SHOWCASE_LIMIT) {
    return publishShowcase(title, content, tags, type);
  }
  try {
    return await publishArticle(title, content, { tags, category, description, difficulty });
  } catch (e) {
    if (!fallback) throw e;
    // Article endpoint failed — truncate to showcase as fallback
    const truncated = content.slice(0, SHOWCASE_LIMIT - 3) + "...";
    const result = await publishShowcase(title, truncated, tags, type);
    return { ...result, fallback: true, articleError: e.message };
  }
}

// Format a session pattern for publishing
export function formatSessionLearning(title, description, { session, source, tags = [] } = {}) {
  let content = description;
  if (session) content += `\n\n_Discovered in session ${session}_`;
  if (source) content += ` | Source: ${source}`;
  return { title, content, tags: [...new Set(["session-learning", ...tags])] };
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(`den-publish.mjs — Publish to MoltbotDen showcase/articles

Usage:
  node den-publish.mjs --title "Title" --content "Body" [--tags "t1,t2"] [--type learning|project|article]
  node den-publish.mjs --title "Title" --content-file ./file.md [--tags "t1,t2"]
  node den-publish.mjs --dry-run --title "Title" --content "Body"

Options:
  --title        Item title (required)
  --content      Body text (inline)
  --content-file Read body from file
  --tags         Comma-separated tags
  --type         Showcase type: learning, project, collaboration, article (default: learning)
  --category     Article category (auto-inferred if omitted)
  --description  Article summary (auto-generated if omitted)
  --difficulty   beginner, intermediate, advanced
  --dry-run      Show what would be published without sending
  --format       Force: showcase or article (default: auto by length)`);
    process.exit(0);
  }

  function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  }

  const title = getArg("title");
  const contentInline = getArg("content");
  const contentFile = getArg("content-file");
  const tagsStr = getArg("tags");
  const type = getArg("type") || "learning";
  const category = getArg("category");
  const description = getArg("description");
  const difficulty = getArg("difficulty");
  const format = getArg("format");
  const dryRun = args.includes("--dry-run");

  if (!title) { console.error("Error: --title is required"); process.exit(1); }

  let content;
  if (contentFile) {
    content = readFileSync(contentFile, "utf-8");
  } else if (contentInline) {
    content = contentInline;
  } else {
    console.error("Error: --content or --content-file is required"); process.exit(1);
  }

  const tags = tagsStr ? tagsStr.split(",").map(t => t.trim()) : [];

  const useFormat = format || (content.length > SHOWCASE_LIMIT ? "article" : "showcase");

  if (dryRun) {
    console.log(`[DRY RUN] Would publish as: ${useFormat}`);
    console.log(`  Title: ${title}`);
    console.log(`  Content length: ${content.length} chars`);
    console.log(`  Tags: ${tags.join(", ") || "(none)"}`);
    if (useFormat === "article") {
      console.log(`  Slug: ${slugify(title)}`);
      console.log(`  Category: ${category || inferCategory(content, tags)}`);
    }
    process.exit(0);
  }

  try {
    let result;
    if (format) {
      // Explicit format requested — no fallback
      if (format === "article") {
        result = await publishArticle(title, content, { tags, category, description, difficulty });
      } else {
        result = await publishShowcase(title, content, tags, type);
      }
    } else {
      // Auto-select with fallback
      result = await autoPublish(title, content, { tags, type, category, description, difficulty });
    }
    if (result.fallback) {
      console.log(`Article endpoint unavailable — fell back to showcase (truncated to ${SHOWCASE_LIMIT} chars)`);
    }
    console.log(`Published (${result.format}):`, JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`Publish failed: ${e.message}`);
    process.exit(1);
  }
}

// Only run CLI when executed directly (not imported)
const isMain = process.argv[1]?.endsWith("den-publish.mjs");
if (isMain) main();

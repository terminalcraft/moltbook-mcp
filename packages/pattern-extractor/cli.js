#!/usr/bin/env node

/**
 * pattern-extractor CLI
 *
 * Usage:
 *   pattern-extractor https://github.com/user/repo
 *   pattern-extractor https://github.com/user/repo --json
 */

import { extractFromRepo, formatExtraction } from "./index.js";

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith("-"));
const jsonMode = args.includes("--json");

if (!url) {
  console.error("Usage: pattern-extractor <github-url> [--json]");
  console.error("");
  console.error("Shallow-clones a GitHub repo and extracts documentation files");
  console.error("(README.md, CLAUDE.md, AGENTS.md, package.json, etc.)");
  console.error("");
  console.error("Options:");
  console.error("  --json    Output as JSON instead of formatted text");
  process.exit(1);
}

try {
  const result = await extractFromRepo(url);
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatExtraction(result));
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

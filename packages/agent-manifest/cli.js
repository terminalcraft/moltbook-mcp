#!/usr/bin/env node

/**
 * agent-manifest CLI
 *
 * Usage:
 *   npx @moltcraft/agent-manifest              # generate agent.json in current dir
 *   npx @moltcraft/agent-manifest --init        # also create knowledge/ dir and server snippet
 *   npx @moltcraft/agent-manifest --name mybot  # override agent name
 *   npx @moltcraft/agent-manifest --dir /path   # specify project directory
 */

import { generateManifest, generateServerSnippet } from "./index.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] || true;
}

const hasFlag = (name) => args.includes(name);

const dir = flag("--dir") || process.cwd();
const opts = {};
if (flag("--name")) opts.name = flag("--name");
if (flag("--version")) opts.version = flag("--version");
if (flag("--github")) opts.github = flag("--github");

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`agent-manifest — Generate agent.json for the knowledge exchange protocol

Usage:
  agent-manifest                  Generate agent.json from package.json
  agent-manifest --init           Also scaffold knowledge/ dir and server snippet
  agent-manifest --name <name>    Override agent name
  agent-manifest --github <url>   Override GitHub URL
  agent-manifest --dir <path>     Specify project directory
  agent-manifest --help           Show this help

Protocol: agent-knowledge-exchange-v1
  GET /agent.json          → agent manifest
  GET /knowledge/patterns  → learned patterns array
  GET /knowledge/digest    → human-readable summary

More info: https://github.com/terminalcraft/moltbook-mcp`);
  process.exit(0);
}

const manifest = generateManifest(dir, opts);

// Write agent.json
const outPath = join(dir, "agent.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Created ${outPath}`);

if (hasFlag("--init")) {
  // Create knowledge directory
  const knowledgeDir = join(dir, "knowledge");
  if (!existsSync(knowledgeDir)) {
    mkdirSync(knowledgeDir, { recursive: true });
    console.log(`Created ${knowledgeDir}/`);
  }

  // Seed empty patterns.json
  const patternsPath = join(knowledgeDir, "patterns.json");
  if (!existsSync(patternsPath)) {
    writeFileSync(patternsPath, "[]\n");
    console.log(`Created ${patternsPath}`);
  }

  // Seed digest.md
  const digestPath = join(knowledgeDir, "digest.md");
  if (!existsSync(digestPath)) {
    writeFileSync(digestPath, `# Knowledge Digest\n\nNo patterns learned yet. Add patterns to patterns.json.\n`);
    console.log(`Created ${digestPath}`);
  }

  // Write server snippet
  const snippetPath = join(dir, "exchange-routes.js");
  writeFileSync(snippetPath, generateServerSnippet(manifest));
  console.log(`Created ${snippetPath} — import and mount in your Express app`);
}

console.log(`\nManifest:`);
console.log(JSON.stringify(manifest, null, 2));

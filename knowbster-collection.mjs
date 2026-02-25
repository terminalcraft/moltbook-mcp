#!/usr/bin/env node

// knowbster-collection.mjs — Bundle related knowledge patterns into curated collection packs
//
// Usage:
//   node knowbster-collection.mjs --list                    # Show defined collections
//   node knowbster-collection.mjs --preview <collection>    # Preview a collection's contents
//   node knowbster-collection.mjs --dry-run <collection>    # Preview what would be published
//   node knowbster-collection.mjs --publish <collection>    # Publish collection to Knowbster
//   node knowbster-collection.mjs --auto                    # Auto-generate collections from patterns
//   node knowbster-collection.mjs --auto --dry-run          # Preview auto-generated collections
//
// Can also be imported:
//   import { defineCollections, buildCollectionListing, publishCollection } from './knowbster-collection.mjs'

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadPatterns } from "./providers/knowledge.js";
import {
  selectPatterns,
  formatForKnowbster,
  loadPublished,
  savePublished,
  loadKnowledgeBase,
} from "./knowbster-autopublish.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLLECTIONS_PATH = join(__dirname, "knowbster-collections.json");

// Bundle discount: collections cost less than sum of individual items
const BUNDLE_DISCOUNT = 0.20; // 20% off sum of individual prices

// Minimum/maximum patterns per collection
const MIN_PATTERNS = 3;
const MAX_PATTERNS = 10;

// Predefined collection templates — curated groupings of related patterns
const COLLECTION_TEMPLATES = {
  "agent-architecture": {
    title: "Agent Architecture Patterns",
    description:
      "Battle-tested architectural patterns for building autonomous AI agents. " +
      "Covers session management, state persistence, multi-agent orchestration, " +
      "and protocol design from 1500+ production sessions.",
    category: "Technology",
    patternFilter: { category: "architecture", minConfidence: "verified" },
    maxPatterns: 8,
  },
  "agent-tooling": {
    title: "Agent Tooling & Developer Experience",
    description:
      "Practical tooling patterns for AI agent development. Efficient file handling, " +
      "idempotent operations, permission layering, and CLI/UI dual-mode design.",
    category: "Technology",
    patternFilter: { category: "tooling", minConfidence: "observed" },
    maxPatterns: 8,
  },
  "agent-reliability": {
    title: "Agent Reliability & Security Pack",
    description:
      "Patterns for building resilient, secure AI agents. Exponential backoff, " +
      "test coverage strategies, verify-before-assert discipline, and prompt injection defense.",
    category: "Technology",
    patternFilter: {
      categories: ["reliability", "security"],
      minConfidence: "observed",
    },
    maxPatterns: 6,
  },
  "agent-prompting": {
    title: "Agent Prompting & Behavior Design",
    description:
      "Effective patterns for shaping agent behavior through prompts and configuration. " +
      "Persistent directives, slash commands, project context files, and capability manifests.",
    category: "Education",
    patternFilter: {
      categories: ["prompting", "ecosystem"],
      minConfidence: "observed",
    },
    maxPatterns: 6,
  },
};

// Load collection tracking file
export function loadCollections() {
  if (!existsSync(COLLECTIONS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(COLLECTIONS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

// Save collection tracking file
export function saveCollections(collections) {
  writeFileSync(COLLECTIONS_PATH, JSON.stringify(collections, null, 2) + "\n");
}

// Select patterns matching a collection template's filter
export function selectForCollection(patterns, filter) {
  const minIdx = ["speculative", "observed", "verified", "consensus"].indexOf(
    filter.minConfidence || "observed"
  );

  return patterns.filter((p) => {
    // Category filter — supports single or multiple categories
    if (filter.category && p.category !== filter.category) return false;
    if (
      filter.categories &&
      !filter.categories.includes(p.category)
    )
      return false;

    // Confidence gate
    const confIdx = ["speculative", "observed", "verified", "consensus"].indexOf(
      p.confidence || "speculative"
    );
    if (confIdx < minIdx) return false;

    // Skip stubs
    if ((p.description || "").length < 50) return false;

    return true;
  });
}

// Compute collection bundle price from member patterns
export function computeCollectionPrice(memberPatterns) {
  let sum = 0;
  for (const p of memberPatterns) {
    const formatted = formatForKnowbster(p);
    sum += parseFloat(formatted.price);
  }
  // Apply bundle discount, enforce minimum
  const discounted = sum * (1 - BUNDLE_DISCOUNT);
  return Math.max(0.001, discounted).toFixed(4);
}

// Build the collection listing content for Knowbster
export function buildCollectionListing(templateKey, template, memberPatterns) {
  const parts = [];
  parts.push(`# ${template.title}`);
  parts.push("");
  parts.push(`> Collection of ${memberPatterns.length} curated patterns`);
  parts.push("");
  parts.push("## About This Collection");
  parts.push("");
  parts.push(template.description);
  parts.push("");
  parts.push("## Included Patterns");
  parts.push("");

  for (const p of memberPatterns) {
    const conf = p.confidence || "observed";
    const tags = (p.tags || []).slice(0, 3).join(", ");
    parts.push(`### ${p.title}`);
    parts.push(`**ID**: ${p.id} | **Confidence**: ${conf} | **Source**: ${p.source}`);
    if (tags) parts.push(`**Tags**: ${tags}`);
    parts.push("");
    parts.push(p.description);
    parts.push("");
  }

  const individualSum = memberPatterns.reduce((s, p) => {
    return s + parseFloat(formatForKnowbster(p).price);
  }, 0);
  const bundlePrice = computeCollectionPrice(memberPatterns);

  parts.push("---");
  parts.push(`**Bundle savings**: ${(BUNDLE_DISCOUNT * 100).toFixed(0)}% off individual prices`);
  parts.push(
    `**Individual total**: ${individualSum.toFixed(4)} ETH → **Bundle price**: ${bundlePrice} ETH`
  );
  parts.push("");
  parts.push("---");
  parts.push(`Published by @moltbook | Collection: ${templateKey}`);

  return {
    title: template.title.slice(0, 100),
    description: template.description.slice(0, 497) +
      (template.description.length > 497 ? "..." : ""),
    content: parts.join("\n"),
    price: bundlePrice,
    category: template.category,
    jurisdiction: "GLOBAL",
    language: "en",
    collectionKey: templateKey,
    memberIds: memberPatterns.map((p) => p.id),
    memberCount: memberPatterns.length,
  };
}

// Auto-generate collection definitions from current knowledge base
export function defineCollections(patterns, { templateKeys = null } = {}) {
  const results = [];
  const templates = templateKeys
    ? Object.fromEntries(
        Object.entries(COLLECTION_TEMPLATES).filter(([k]) =>
          templateKeys.includes(k)
        )
      )
    : COLLECTION_TEMPLATES;

  for (const [key, template] of Object.entries(templates)) {
    const eligible = selectForCollection(patterns, template.patternFilter);
    const members = eligible.slice(0, template.maxPatterns || MAX_PATTERNS);

    if (members.length < MIN_PATTERNS) continue;

    const listing = buildCollectionListing(key, template, members);
    results.push({ key, template, members, listing });
  }

  return results;
}

// Publish a collection to Knowbster (publishes the meta-listing on-chain)
export async function publishCollection(listing) {
  // Reuse the publishOne from autopublish
  const { publishOne } = await import("./knowbster-autopublish.mjs");

  const formatted = {
    title: listing.title,
    description: listing.description,
    content: listing.content,
    price: listing.price,
    category: listing.category,
    jurisdiction: listing.jurisdiction,
    language: listing.language,
  };

  const result = await publishOne(formatted);

  // Track in collections file
  const collections = loadCollections();
  collections[listing.collectionKey] = {
    tokenId: result.tokenId,
    txHash: result.txHash,
    publishedAt: new Date().toISOString(),
    price: listing.price,
    title: listing.title,
    memberIds: listing.memberIds,
    memberCount: listing.memberCount,
  };
  saveCollections(collections);

  return result;
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log(`knowbster-collection.mjs — Bundle knowledge patterns into curated collection packs

Usage:
  node knowbster-collection.mjs --list                    # Show defined collections
  node knowbster-collection.mjs --preview <collection>    # Preview collection contents
  node knowbster-collection.mjs --dry-run [collection]    # Preview what would be published
  node knowbster-collection.mjs --publish <collection>    # Publish collection on-chain
  node knowbster-collection.mjs --auto                    # Auto-generate all collections
  node knowbster-collection.mjs --auto --dry-run          # Preview auto-generated collections
  node knowbster-collection.mjs --published               # Show published collections

Options:
  --list                Show available collection templates
  --preview <key>       Show patterns that would be included
  --dry-run [key]       Preview listing without publishing
  --publish <key>       Publish collection on-chain (costs gas)
  --auto                Process all templates at once
  --published           Show already-published collections
  --help                Show this help`);
    process.exit(0);
  }

  function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  }

  const patterns = loadKnowledgeBase();

  if (args.includes("--list")) {
    console.log("Available collection templates:\n");
    for (const [key, t] of Object.entries(COLLECTION_TEMPLATES)) {
      const eligible = selectForCollection(patterns, t.patternFilter);
      const count = Math.min(eligible.length, t.maxPatterns || MAX_PATTERNS);
      const status = count >= MIN_PATTERNS ? `${count} patterns` : "insufficient patterns";
      console.log(`  ${key}: "${t.title}" — ${status}`);
      console.log(`    ${t.description.slice(0, 80)}...`);
      console.log();
    }
    process.exit(0);
  }

  if (args.includes("--published")) {
    const collections = loadCollections();
    const entries = Object.entries(collections);
    if (!entries.length) {
      console.log("No collections published yet.");
      process.exit(0);
    }
    console.log(`Published collections (${entries.length}):\n`);
    for (const [key, info] of entries) {
      console.log(
        `  ${key}: "${info.title}" → token #${info.tokenId} (${info.price} ETH, ${info.memberCount} patterns) — ${info.publishedAt?.slice(0, 10)}`
      );
    }
    process.exit(0);
  }

  const previewKey = getArg("preview");
  if (previewKey) {
    const template = COLLECTION_TEMPLATES[previewKey];
    if (!template) {
      console.error(`Unknown collection: ${previewKey}`);
      console.error(`Available: ${Object.keys(COLLECTION_TEMPLATES).join(", ")}`);
      process.exit(1);
    }
    const eligible = selectForCollection(patterns, template.patternFilter);
    const members = eligible.slice(0, template.maxPatterns || MAX_PATTERNS);
    console.log(`Collection: "${template.title}" (${members.length} patterns)\n`);
    for (const p of members) {
      const price = formatForKnowbster(p).price;
      console.log(`  ${p.id}: "${p.title}" — ${p.confidence} (${price} ETH)`);
    }
    const bundlePrice = computeCollectionPrice(members);
    const individualSum = members.reduce(
      (s, p) => s + parseFloat(formatForKnowbster(p).price),
      0
    );
    console.log(`\n  Individual total: ${individualSum.toFixed(4)} ETH`);
    console.log(`  Bundle price: ${bundlePrice} ETH (${(BUNDLE_DISCOUNT * 100).toFixed(0)}% off)`);
    process.exit(0);
  }

  const isAuto = args.includes("--auto");
  const isDryRun = args.includes("--dry-run");
  const publishKey = getArg("publish");

  if (isAuto || isDryRun || publishKey) {
    const templateKeys = publishKey
      ? [publishKey]
      : isAuto
        ? null
        : (() => {
            // --dry-run with optional collection name
            const dryKey = getArg("dry-run");
            return dryKey && dryKey !== "true" ? [dryKey] : null;
          })();

    const collections = defineCollections(patterns, { templateKeys });

    if (!collections.length) {
      console.log("No eligible collections found. Need at least 3 patterns per collection.");
      process.exit(0);
    }

    for (const { key, members, listing } of collections) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Collection: "${listing.title}" [${key}]`);
      console.log(`Patterns: ${listing.memberCount} | Price: ${listing.price} ETH`);
      console.log(`Category: ${listing.category}`);
      console.log(`${"=".repeat(60)}`);

      for (const p of members) {
        console.log(`  ${p.id}: "${p.title}" (${p.confidence})`);
      }

      if (publishKey && !isDryRun) {
        console.log("\nPublishing on-chain...");
        try {
          const result = await publishCollection(listing);
          console.log(`  Token ID: ${result.tokenId}`);
          console.log(`  TX: https://basescan.org/tx/${result.txHash}`);
          console.log(`  Gas used: ${result.gasUsed}`);
        } catch (e) {
          console.error(`  Failed: ${e.message}`);
          if (e.message.includes("Insufficient ETH")) process.exit(1);
        }
      } else {
        console.log("\n  [DRY RUN] Would publish this collection.");
        console.log(`  Content length: ${listing.content.length} chars`);
      }
    }

    process.exit(0);
  }

  console.log("Use --list, --preview, --dry-run, --publish, or --auto. See --help.");
}

const isMain = process.argv[1]?.endsWith("knowbster-collection.mjs");
if (isMain) main();

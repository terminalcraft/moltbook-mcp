#!/usr/bin/env node

// knowbster-autopublish.mjs — Package knowledge patterns into Knowbster listings
//
// Usage:
//   node knowbster-autopublish.mjs --dry-run              # Preview what would be published
//   node knowbster-autopublish.mjs --publish               # Publish unpublished patterns
//   node knowbster-autopublish.mjs --list                  # Show already-published patterns
//   node knowbster-autopublish.mjs --publish --id p001     # Publish a specific pattern
//   node knowbster-autopublish.mjs --min-confidence verified  # Only verified+ patterns
//   node knowbster-autopublish.mjs --category architecture    # Filter by category
//   node knowbster-autopublish.mjs --max 5                 # Publish at most 5 at once
//
// Can also be imported:
//   import { selectPatterns, formatForKnowbster, batchPublish } from './knowbster-autopublish.mjs'

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadPatterns } from "./providers/knowledge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLISHED_PATH = join(__dirname, "knowbster-published.json");

// Map knowledge-base categories to Knowbster marketplace categories
const CATEGORY_MAP = {
  architecture: "Technology",
  tooling: "Technology",
  reliability: "Technology",
  prompting: "Education",
  ecosystem: "Technology",
  security: "Technology",
};

// Confidence levels ordered by strength
const CONFIDENCE_LEVELS = ["speculative", "observed", "verified", "consensus"];

// Pricing tiers based on confidence + validator count
function computePrice(pattern) {
  const conf = pattern.confidence || "observed";
  const validators = (pattern.validators || []).length;
  const tagCount = (pattern.tags || []).length;

  // Base price by confidence
  let price = 0.001;
  if (conf === "verified") price = 0.002;
  if (conf === "consensus") price = 0.003;

  // Bonus for validators
  if (validators >= 2) price += 0.001;

  // Bonus for rich metadata (many tags = well-documented)
  if (tagCount >= 4) price += 0.0005;

  return price.toFixed(4);
}

// Load knowledge base via provider
export function loadKnowledgeBase() {
  const data = loadPatterns();
  return data.patterns || [];
}

// Load published tracking file
export function loadPublished() {
  if (!existsSync(PUBLISHED_PATH)) return {};
  try {
    return JSON.parse(readFileSync(PUBLISHED_PATH, "utf-8"));
  } catch {
    return {};
  }
}

// Save published tracking file
export function savePublished(published) {
  writeFileSync(PUBLISHED_PATH, JSON.stringify(published, null, 2) + "\n");
}

// Filter patterns eligible for publishing
export function selectPatterns(patterns, {
  minConfidence = "observed",
  category = null,
  ids = null,
  excludePublished = true,
} = {}) {
  const published = loadPublished();
  const minIdx = CONFIDENCE_LEVELS.indexOf(minConfidence);

  return patterns.filter(p => {
    // ID filter
    if (ids && !ids.includes(p.id)) return false;

    // Already published
    if (excludePublished && published[p.id]) return false;

    // Confidence gate
    const confIdx = CONFIDENCE_LEVELS.indexOf(p.confidence || "speculative");
    if (confIdx < minIdx) return false;

    // Category filter
    if (category && p.category !== category) return false;

    // Skip patterns with very short descriptions (likely stubs)
    if ((p.description || "").length < 50) return false;

    return true;
  });
}

// Format a knowledge pattern into Knowbster listing parameters
export function formatForKnowbster(pattern) {
  const title = (pattern.title || "Untitled Pattern").slice(0, 100);
  const category = CATEGORY_MAP[pattern.category] || "Other";
  const price = computePrice(pattern);

  // Build rich content from pattern fields
  const parts = [];
  parts.push(`# ${title}`);
  parts.push("");
  parts.push(`**Category**: ${pattern.category} | **Confidence**: ${pattern.confidence || "observed"}`);
  parts.push(`**Source**: ${pattern.source || "unknown"}`);
  if (pattern.tags?.length) {
    parts.push(`**Tags**: ${pattern.tags.join(", ")}`);
  }
  parts.push("");
  parts.push("## Description");
  parts.push("");
  parts.push(pattern.description);

  if (pattern.validators?.length) {
    parts.push("");
    parts.push("## Validation History");
    for (const v of pattern.validators) {
      parts.push(`- Validated by ${v.agent} on ${v.at?.slice(0, 10) || "unknown"}${v.note ? ": " + v.note : ""}`);
    }
  }

  parts.push("");
  parts.push("---");
  parts.push(`Published by @moltbook | Pattern ID: ${pattern.id}`);

  const content = parts.join("\n");

  // Description is a short summary (max 500 chars for Knowbster)
  const description = (pattern.description || "").slice(0, 497);

  return {
    patternId: pattern.id,
    title,
    description: description.length < pattern.description?.length
      ? description + "..."
      : description,
    content,
    price,
    category,
    jurisdiction: "GLOBAL",
    language: "en",
  };
}

// Publish a single pattern to Knowbster (uses the MCP tool's on-chain publish)
// This is the live publish function — requires ethers + wallet
export async function publishOne(formatted) {
  // Dynamic import of the knowbster component for its publish logic
  const { createHash } = await import("crypto");
  const { ethers } = await import("ethers");

  const KNOWBSTER_CONTRACT = "0xc6854adEd027e132d146a201030bA6b5a87b01a6";
  const BASE_RPC = "https://mainnet.base.org";
  const CATEGORIES = {
    "Technology": 0, "Health": 1, "Finance": 2, "Science": 3,
    "Education": 4, "Legal": 5, "Business": 6, "Other": 7,
  };
  const ABI = [
    "function listKnowledge(uint256 price, bytes32 contentHash, uint8 category, string jurisdiction, string language) returns (uint256)"
  ];

  const walletData = JSON.parse(readFileSync(join(__dirname, "wallet.json"), "utf-8"));
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(walletData.evm.privateKey, provider);

  // Check gas
  const ethBalance = await provider.getBalance(wallet.address);
  if (ethBalance < ethers.parseEther("0.0005")) {
    throw new Error(`Insufficient ETH for gas. Balance: ${ethers.formatEther(ethBalance)} ETH`);
  }

  // Content hash
  const payload = JSON.stringify({
    title: formatted.title,
    description: formatted.description,
    content: formatted.content,
    author: wallet.address,
    timestamp: new Date().toISOString(),
  });
  const contentHash = "0x" + createHash("sha256").update(payload).digest("hex");

  // On-chain publish
  const contract = new ethers.Contract(KNOWBSTER_CONTRACT, ABI, wallet);
  const priceWei = ethers.parseEther(formatted.price);
  const categoryId = CATEGORIES[formatted.category] ?? 7;

  const tx = await contract.listKnowledge(
    priceWei, contentHash, categoryId,
    formatted.jurisdiction, formatted.language,
    { gasLimit: 400000n }
  );

  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Transaction failed. Hash: ${tx.hash}`);
  }

  // Extract tokenId from logs
  let tokenId = null;
  for (const log of receipt.logs) {
    if (log.topics?.[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") {
      tokenId = BigInt(log.topics[3]).toString();
      break;
    }
  }

  // Sync with API
  let syncStatus = "skipped";
  if (tokenId) {
    try {
      const syncRes = await fetch("https://knowbster.com/api/v2/knowledge/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenId }),
        signal: AbortSignal.timeout(15000),
      });
      syncStatus = syncRes.ok ? "synced" : `sync failed (${syncRes.status})`;
    } catch (e) {
      syncStatus = `sync error: ${e.message}`;
    }
  }

  return {
    tokenId,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    contentHash,
    syncStatus,
  };
}

// Batch publish multiple patterns
export async function batchPublish(patterns, { dryRun = false, max = 10 } = {}) {
  const published = loadPublished();
  const results = [];

  const batch = patterns.slice(0, max);
  for (const pattern of batch) {
    const formatted = formatForKnowbster(pattern);

    if (dryRun) {
      results.push({
        patternId: pattern.id,
        title: formatted.title,
        price: formatted.price,
        category: formatted.category,
        contentLength: formatted.content.length,
        status: "dry-run",
      });
      continue;
    }

    try {
      const result = await publishOne(formatted);
      published[pattern.id] = {
        tokenId: result.tokenId,
        txHash: result.txHash,
        publishedAt: new Date().toISOString(),
        price: formatted.price,
        title: formatted.title,
      };
      savePublished(published);
      results.push({
        patternId: pattern.id,
        title: formatted.title,
        status: "published",
        ...result,
      });
      console.log(`  Published: "${formatted.title}" → token #${result.tokenId}`);
    } catch (e) {
      results.push({
        patternId: pattern.id,
        title: formatted.title,
        status: "error",
        error: e.message,
      });
      console.error(`  Failed: "${formatted.title}" — ${e.message}`);
      // Stop on gas errors to avoid burning through attempts
      if (e.message.includes("Insufficient ETH")) break;
    }
  }

  return results;
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log(`knowbster-autopublish.mjs — Package knowledge patterns into Knowbster listings

Usage:
  node knowbster-autopublish.mjs --dry-run                # Preview publishable patterns
  node knowbster-autopublish.mjs --publish                 # Publish to Knowbster (on-chain)
  node knowbster-autopublish.mjs --list                    # Show already-published patterns
  node knowbster-autopublish.mjs --publish --id p001       # Publish specific pattern
  node knowbster-autopublish.mjs --stats                   # Show pattern stats

Options:
  --dry-run             Preview without publishing
  --publish             Actually publish on-chain (costs gas)
  --list                List already-published patterns
  --stats               Show pattern selection statistics
  --id <id>             Target specific pattern ID (repeatable)
  --min-confidence <c>  Minimum confidence: speculative|observed|verified|consensus (default: observed)
  --category <cat>      Filter by knowledge category
  --max <n>             Max patterns to publish (default: 5)
  --include-published   Don't skip already-published patterns`);
    process.exit(0);
  }

  function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  }

  function getAllArgs(name) {
    const values = [];
    let idx = args.indexOf(`--${name}`);
    while (idx >= 0 && idx + 1 < args.length) {
      values.push(args[idx + 1]);
      idx = args.indexOf(`--${name}`, idx + 1);
    }
    return values.length ? values : null;
  }

  const dryRun = args.includes("--dry-run");
  const publish = args.includes("--publish");
  const list = args.includes("--list");
  const stats = args.includes("--stats");
  const ids = getAllArgs("id");
  const minConfidence = getArg("min-confidence") || "observed";
  const category = getArg("category");
  const max = parseInt(getArg("max") || "5", 10);
  const includePublished = args.includes("--include-published");

  if (list) {
    const published = loadPublished();
    const entries = Object.entries(published);
    if (!entries.length) {
      console.log("No patterns published yet.");
      process.exit(0);
    }
    console.log(`Published patterns (${entries.length}):\n`);
    for (const [id, info] of entries) {
      console.log(`  ${id}: "${info.title}" → token #${info.tokenId} (${info.price} ETH) — ${info.publishedAt?.slice(0, 10)}`);
    }
    process.exit(0);
  }

  const patterns = loadKnowledgeBase();

  if (stats) {
    const published = loadPublished();
    const publishedCount = Object.keys(published).length;
    const byConf = {};
    const byCat = {};
    for (const p of patterns) {
      byConf[p.confidence || "unknown"] = (byConf[p.confidence || "unknown"] || 0) + 1;
      byCat[p.category || "unknown"] = (byCat[p.category || "unknown"] || 0) + 1;
    }
    console.log(`Knowledge base: ${patterns.length} patterns`);
    console.log(`Already published: ${publishedCount}`);
    console.log(`\nBy confidence:`);
    for (const [k, v] of Object.entries(byConf).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${v}`);
    }
    console.log(`\nBy category:`);
    for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k}: ${v}`);
    }
    process.exit(0);
  }

  const selected = selectPatterns(patterns, {
    minConfidence,
    category,
    ids,
    excludePublished: !includePublished,
  });

  if (!selected.length) {
    console.log("No eligible patterns found. Try --include-published or lower --min-confidence.");
    process.exit(0);
  }

  if (dryRun || publish) {
    console.log(`${dryRun ? "[DRY RUN]" : "[PUBLISH]"} ${selected.length} patterns selected (max ${max}):\n`);
    const results = await batchPublish(selected, { dryRun: dryRun || !publish, max });
    for (const r of results) {
      if (r.status === "dry-run") {
        console.log(`  ${r.patternId}: "${r.title}" — ${r.price} ETH (${r.category}, ${r.contentLength} chars)`);
      }
    }
    if (dryRun) {
      const totalPrice = results.reduce((s, r) => s + parseFloat(r.price || 0), 0);
      console.log(`\nTotal listing value: ${totalPrice.toFixed(4)} ETH`);
    }
    process.exit(0);
  }

  // Default: show summary
  console.log(`${selected.length} patterns eligible for publishing. Use --dry-run or --publish.`);
}

const isMain = process.argv[1]?.endsWith("knowbster-autopublish.mjs");
if (isMain) main();

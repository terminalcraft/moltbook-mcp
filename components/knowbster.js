import { z } from "zod";
import { createHash } from "crypto";

// Knowbster V2 — Decentralized AI knowledge marketplace on Base L2
// API docs: https://knowbster.com/skill.md
// Read API: no auth. Write/purchase: requires on-chain wallet (Base L2).

const API = "https://knowbster.com/api/v2";

// Knowbster contract on Base Mainnet
const KNOWBSTER_CONTRACT = "0xc6854adEd027e132d146a201030bA6b5a87b01a6";
const BASE_RPC = "https://mainnet.base.org";

// Category enum matching contract (0-7)
const CATEGORIES = {
  "Technology": 0, "Health": 1, "Finance": 2, "Science": 3,
  "Education": 4, "Legal": 5, "Business": 6, "Other": 7,
};

// Minimal ABI for listKnowledge
const KNOWBSTER_ABI = [
  "function listKnowledge(uint256 price, bytes32 contentHash, uint8 category, string jurisdiction, string language) returns (uint256)"
];

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

function hashContent(title, description, content, author) {
  const payload = JSON.stringify({ title, description, content, author, timestamp: new Date().toISOString() });
  return "0x" + createHash("sha256").update(payload).digest("hex");
}

async function loadEthersWallet() {
  const { ethers } = await import("ethers");
  const { readFileSync } = await import("fs");
  const { dirname, join } = await import("path");
  const { fileURLToPath } = await import("url");

  const mpcDir = dirname(join(fileURLToPath(import.meta.url), ".."));
  const walletData = JSON.parse(readFileSync(join(mpcDir, "wallet.json"), "utf-8"));
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(walletData.evm.privateKey, provider);
  return { wallet, provider, ethers };
}

export function register(server) {
  server.tool("knowbster_browse", "Browse knowledge listings on Knowbster marketplace", {
    category: z.string().optional().describe("Filter by category (e.g. Technology, Health, Finance)"),
    search: z.string().optional().describe("Search term to filter by"),
    limit: z.number().optional().describe("Max results (default 10, max 50)"),
  }, async ({ category, search, limit }) => {
    try {
      const params = new URLSearchParams();
      params.set("limit", String(Math.min(limit || 10, 50)));
      if (category) params.set("category", category);
      if (search) params.set("search", search);

      const data = await fetchJson(`${API}/knowledge?${params}`);
      const items = data?.knowledge || [];
      if (!items.length) return ok("No knowledge items found matching criteria.");

      const summary = items.map((k, i) => {
        const stats = k.validationStats || {};
        const validations = stats.total > 0 ? ` (${stats.positive}+ / ${stats.negative}-)` : "";
        return `${i + 1}. [#${k.tokenId}] "${k.title}" — ${k.category}\n   ${k.description}\n   Price: ${k.price} ETH · Sales: ${k.salesCount} · Author: ${k.author?.slice(0, 10)}...${validations}`;
      }).join("\n\n");

      return ok(`Knowbster marketplace — ${data.total} total items:\n\n${summary}`);
    } catch (e) {
      return err(`Knowbster error: ${e.message}`);
    }
  });

  server.tool("knowbster_detail", "Get details of a specific knowledge item", {
    token_id: z.string().describe("Token ID of the knowledge item"),
  }, async ({ token_id }) => {
    try {
      const data = await fetchJson(`${API}/knowledge/${token_id}`);
      const k = data?.knowledge || data;
      if (!k || !k.title) return err("Knowledge item not found");

      const stats = k.validationStats || {};
      let out = `"${k.title}" (#${k.tokenId})\n`;
      out += `Category: ${k.category} · Language: ${k.language} · Jurisdiction: ${k.jurisdiction}\n`;
      out += `Price: ${k.price} ETH · Sales: ${k.salesCount}\n`;
      out += `Author: ${k.author}\n`;
      out += `Content hash: ${k.contentHash}\n`;
      out += `Validations: ${stats.positive || 0} positive, ${stats.negative || 0} negative (${stats.total || 0} total)\n`;
      out += `Created: ${k.createdAt}\n`;
      if (k.contentPreview) out += `\nPreview: ${k.contentPreview}`;

      return ok(out);
    } catch (e) {
      return err(`Knowbster error: ${e.message}`);
    }
  });

  server.tool("knowbster_stats", "Get Knowbster marketplace statistics", {}, async () => {
    try {
      // Fetch first page to get total count
      const data = await fetchJson(`${API}/knowledge?limit=1`);
      const total = data?.total || 0;

      // Fetch categories by sampling
      const sample = await fetchJson(`${API}/knowledge?limit=50`);
      const items = sample?.knowledge || [];
      const categories = {};
      const authors = new Set();
      let totalSales = 0;

      for (const k of items) {
        categories[k.category] = (categories[k.category] || 0) + 1;
        authors.add(k.author);
        totalSales += k.salesCount || 0;
      }

      const catSummary = Object.entries(categories)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, count]) => `  ${cat}: ${count}`)
        .join("\n");

      let out = `Knowbster Marketplace Stats\n`;
      out += `Total listings: ${total}\n`;
      out += `Unique authors (sampled): ${authors.size}\n`;
      out += `Total sales (sampled): ${totalSales}\n`;
      out += `\nCategories (from ${items.length} sampled):\n${catSummary}`;
      out += `\nNetwork: Base Mainnet (Chain 8453)`;
      out += `\nContract: 0xc6854adEd027e132d146a201030bA6b5a87b01a6`;

      return ok(out);
    } catch (e) {
      return err(`Knowbster error: ${e.message}`);
    }
  });

  server.tool("knowbster_publish", "Publish a knowledge item on Knowbster marketplace (on-chain via Base L2)", {
    title: z.string().max(100).describe("Knowledge title (max 100 chars)"),
    description: z.string().max(500).describe("Summary of content (max 500 chars)"),
    content: z.string().describe("Full knowledge content payload"),
    price: z.string().describe("Price in ETH (e.g. '0.001'). Minimum 0.001"),
    category: z.enum(["Technology", "Health", "Finance", "Science", "Education", "Legal", "Business", "Other"]).describe("Knowledge category"),
    jurisdiction: z.string().default("GLOBAL").describe("Geographic scope (e.g. GLOBAL, US)"),
    language: z.string().default("en").describe("Language code (e.g. en, pt-BR)"),
  }, async ({ title, description, content, price, category, jurisdiction, language }) => {
    try {
      const priceNum = parseFloat(price);
      if (isNaN(priceNum) || priceNum < 0.001) {
        return err("Price must be at least 0.001 ETH");
      }

      const categoryId = CATEGORIES[category];
      if (categoryId === undefined) {
        return err(`Invalid category: ${category}. Use: ${Object.keys(CATEGORIES).join(", ")}`);
      }

      const { wallet, provider, ethers } = await loadEthersWallet();

      // Check gas balance
      const ethBalance = await provider.getBalance(wallet.address);
      if (ethBalance < ethers.parseEther("0.0005")) {
        return err(`Insufficient ETH for gas. Balance: ${ethers.formatEther(ethBalance)} ETH. Need ~0.001 ETH.`);
      }

      // Compute content hash
      const contentHash = hashContent(title, description, content, wallet.address);

      // Call on-chain listKnowledge
      const contract = new ethers.Contract(KNOWBSTER_CONTRACT, KNOWBSTER_ABI, wallet);
      const priceWei = ethers.parseEther(price);

      const tx = await contract.listKnowledge(priceWei, contentHash, categoryId, jurisdiction, language, {
        gasLimit: 400000n,
      });

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        return err(`Transaction failed. Hash: ${tx.hash}`);
      }

      // Extract tokenId from logs (Transfer event topic)
      let tokenId = null;
      for (const log of receipt.logs) {
        // ERC721 Transfer event: Transfer(address,address,uint256)
        if (log.topics?.[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") {
          tokenId = BigInt(log.topics[3]).toString();
          break;
        }
      }

      // Sync with API so it appears in listings
      let syncStatus = "skipped";
      if (tokenId) {
        try {
          const syncRes = await fetch(`${API}/knowledge/sync`, {
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

      let out = `Knowledge published on Knowbster!\n`;
      out += `Title: "${title}" · Category: ${category}\n`;
      out += `Price: ${price} ETH · Jurisdiction: ${jurisdiction} · Language: ${language}\n`;
      out += `Content hash: ${contentHash}\n`;
      out += `Transaction: https://basescan.org/tx/${tx.hash}\n`;
      out += `Block: ${receipt.blockNumber}\n`;
      out += `Token ID: ${tokenId || "unknown (check tx logs)"}\n`;
      out += `API sync: ${syncStatus}\n`;
      out += `Gas used: ${receipt.gasUsed.toString()}`;

      return ok(out);
    } catch (e) {
      return err(`Knowbster publish error: ${e.message}`);
    }
  });

  server.tool("knowbster_wallet", "Check Base L2 wallet balance for Knowbster publishing gas", {}, async () => {
    try {
      const { wallet, provider, ethers } = await loadEthersWallet();
      const ethBalance = await provider.getBalance(wallet.address);
      const formatted = ethers.formatEther(ethBalance);
      const canPublish = ethBalance >= ethers.parseEther("0.0005");

      let out = `Knowbster Wallet (Base L2)\n`;
      out += `Address: ${wallet.address}\n`;
      out += `ETH balance: ${formatted}\n`;
      out += `Can publish: ${canPublish ? "yes" : "no (need ~0.001 ETH for gas)"}\n`;
      out += `Network: Base Mainnet (Chain 8453)`;

      return ok(out);
    } catch (e) {
      return err(`Wallet check error: ${e.message}`);
    }
  });
}

#!/usr/bin/env node
// agora-portfolio.mjs — Track Agora prediction market positions and P/L
// Run: node agora-portfolio.mjs
// Fetches positions, checks resolved markets, logs P/L to agora-portfolio.json

import { readFileSync, writeFileSync } from "fs";

const AGORA_API = "https://agoramarket.ai/api";
const HANDLE = "moltbook";
const PORTFOLIO_FILE = new URL("./agora-portfolio.json", import.meta.url).pathname;

async function agoraFetch(path) {
  const resp = await fetch(`${AGORA_API}${path}`, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`${path}: ${resp.status}`);
  return resp.json();
}

function loadPortfolio() {
  try { return JSON.parse(readFileSync(PORTFOLIO_FILE, "utf8")); }
  catch { return { positions: [], resolved: [], last_check: null, total_pnl: 0 }; }
}

function savePortfolio(p) {
  writeFileSync(PORTFOLIO_FILE, JSON.stringify(p, null, 2));
}

async function run() {
  const portfolio = loadPortfolio();
  const now = new Date().toISOString();

  // 1. Fetch agent profile for balance
  let balance = null;
  try {
    const agent = await agoraFetch(`/agents/${HANDLE}`);
    balance = agent.balance;
    console.log(`Balance: ${balance} AGP`);
  } catch (e) {
    console.log(`Could not fetch agent profile: ${e.message}`);
  }

  // 2. Fetch current positions
  let positions = [];
  try {
    const data = await agoraFetch(`/agents/${HANDLE}/positions`);
    positions = data.positions || data || [];
    console.log(`Open positions: ${positions.length}`);
  } catch (e) {
    console.log(`Could not fetch positions: ${e.message}`);
  }

  // 3. Fetch trade history
  let trades = [];
  try {
    const data = await agoraFetch(`/agents/${HANDLE}/trades`);
    trades = data.trades || data || [];
    console.log(`Total trades: ${trades.length}`);
  } catch (e) {
    console.log(`Could not fetch trades: ${e.message}`);
  }

  // 4. Check each position for resolution
  const newResolved = [];
  for (const pos of positions) {
    const marketId = pos.market_id;
    if (!marketId) continue;
    try {
      const market = await agoraFetch(`/markets/${marketId}`);
      if (market.status === "resolved" || market.resolved) {
        const won = (market.resolution === pos.outcome);
        const pnl = won ? (pos.shares - (pos.cost || pos.amount || 0)) : -(pos.cost || pos.amount || 0);
        newResolved.push({
          market_id: marketId,
          question: (market.question || "").slice(0, 100),
          outcome: pos.outcome,
          shares: pos.shares,
          resolution: market.resolution,
          won,
          pnl: Math.round(pnl * 100) / 100,
          resolved_at: market.resolved_at || now,
        });
        console.log(`  Resolved: "${(market.question || "").slice(0, 40)}" → ${won ? "WIN" : "LOSS"} (${pnl > 0 ? "+" : ""}${Math.round(pnl * 100) / 100} AGP)`);
      }
    } catch {
      // Market might not exist anymore
    }
  }

  // 5. Update portfolio
  const openPositions = positions.filter(p =>
    !newResolved.some(r => r.market_id === p.market_id)
  ).map(p => ({
    market_id: p.market_id,
    question: (p.question || p.market_question || "").slice(0, 100),
    outcome: p.outcome || p.position,
    shares: p.shares,
    cost: p.cost || p.amount,
  }));

  portfolio.positions = openPositions;
  portfolio.resolved.push(...newResolved);
  // Keep last 100 resolved
  if (portfolio.resolved.length > 100) portfolio.resolved = portfolio.resolved.slice(-100);
  portfolio.total_pnl = Math.round(portfolio.resolved.reduce((s, r) => s + (r.pnl || 0), 0) * 100) / 100;
  portfolio.balance = balance;
  portfolio.last_check = now;
  portfolio.trade_count = trades.length;

  savePortfolio(portfolio);
  console.log(`\nPortfolio saved. Open: ${openPositions.length}, Resolved: ${portfolio.resolved.length}, P/L: ${portfolio.total_pnl} AGP`);
}

run().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });

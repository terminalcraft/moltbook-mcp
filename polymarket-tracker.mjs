#!/usr/bin/env node
/**
 * Polymarket Portfolio Tracker — wq-594
 *
 * Reads polybot's positions.json and balance_history.json to serve
 * a portfolio status endpoint on port 8447 (designated free port).
 *
 * Endpoints:
 *   GET /           → full portfolio status (JSON)
 *   GET /health     → liveness check
 *   GET /summary    → one-line text summary for quick glance
 *   GET /positions  → open positions only
 *   GET /history    → recent balance history (last 50 entries)
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PORT = 8447;
const POLYBOT_DIR = '/home/polybot/polymarket-agent';
const POSITIONS_PATH = resolve(POLYBOT_DIR, 'positions.json');
const BALANCE_HISTORY_PATH = resolve(POLYBOT_DIR, 'balance_history.json');

async function readJSON(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

function computePortfolio(positions, balanceHistory) {
  const allPositions = positions.positions || [];
  const open = allPositions.filter(p => p.status === 'open');
  const closed = allPositions.filter(p => p.status === 'closed');

  // Realized P/L from closed positions
  const realizedPnl = closed.reduce((sum, p) => sum + (p.realized_pnl || 0), 0);

  // Cost basis of open positions
  const openCostBasis = open.reduce((sum, p) => sum + (p.cost_basis || 0), 0);

  // Latest balance snapshot
  const latest = balanceHistory.length > 0 ? balanceHistory[balanceHistory.length - 1] : null;
  const cashBalance = latest ? latest.balance : 0;
  const unrealizedPnl = latest ? (latest.total_unrealized_pnl || 0) : 0;
  const equity = latest ? (latest.equity || cashBalance) : 0;

  // Initial capital from config
  const initialCapital = 70.0;
  const totalPnl = equity - initialCapital;
  const totalReturn = initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0;

  // Win/loss stats from closed positions with real exits
  const resolved = closed.filter(p => p.realized_pnl !== 0 && p.exit_reason !== 'phantom_position_never_filled');
  const wins = resolved.filter(p => p.realized_pnl > 0);
  const losses = resolved.filter(p => p.realized_pnl < 0);
  const winRate = resolved.length > 0 ? (wins.length / resolved.length) * 100 : 0;

  // Position details for open
  const openPositions = open.map(p => {
    const unrealized = latest?.position_unrealized?.find(u => u.id === p.id);
    return {
      id: p.id,
      market: p.market_question,
      side: p.side,
      entryPrice: p.entry_price,
      size: p.size,
      costBasis: round(p.cost_basis, 2),
      currentMid: unrealized ? unrealized.mid : null,
      unrealizedPnl: unrealized ? round(unrealized.upnl, 4) : null,
      entryDate: p.timestamp,
      expiryDate: p.market_end_date,
    };
  });

  return {
    timestamp: new Date().toISOString(),
    dataAge: latest ? timeSince(latest.timestamp) : 'unknown',
    summary: {
      equity: round(equity, 2),
      cashBalance: round(cashBalance, 2),
      openCostBasis: round(openCostBasis, 2),
      unrealizedPnl: round(unrealizedPnl, 2),
      realizedPnl: round(realizedPnl, 2),
      totalPnl: round(totalPnl, 2),
      totalReturn: round(totalReturn, 2),
      initialCapital,
    },
    positions: {
      open: open.length,
      closed: closed.length,
      total: allPositions.length,
    },
    performance: {
      winRate: round(winRate, 1),
      wins: wins.length,
      losses: losses.length,
      resolved: resolved.length,
      avgWin: wins.length > 0 ? round(wins.reduce((s, p) => s + p.realized_pnl, 0) / wins.length, 4) : 0,
      avgLoss: losses.length > 0 ? round(losses.reduce((s, p) => s + p.realized_pnl, 0) / losses.length, 4) : 0,
    },
    openPositions,
  };
}

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function timeSince(isoStr) {
  const then = new Date(isoStr);
  const now = new Date();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers for monitoring dashboards
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'polymarket-tracker', port: PORT }));
    return;
  }

  try {
    const [positions, balanceHistory] = await Promise.all([
      readJSON(POSITIONS_PATH),
      readJSON(BALANCE_HISTORY_PATH),
    ]);

    const portfolio = computePortfolio(positions, balanceHistory);

    if (url.pathname === '/summary') {
      const s = portfolio.summary;
      const line = `Equity: $${s.equity} | Cash: $${s.cashBalance} | Open: ${portfolio.positions.open} | uPnL: $${s.unrealizedPnl} | rPnL: $${s.realizedPnl} | Total: $${s.totalPnl} (${s.totalReturn}%) | Win: ${portfolio.performance.winRate}%`;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(line);
      return;
    }

    if (url.pathname === '/positions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ positions: portfolio.openPositions, count: portfolio.positions.open }, null, 2));
      return;
    }

    if (url.pathname === '/history') {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const recent = balanceHistory.slice(-Math.min(limit, 200));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries: recent.length, history: recent }, null, 2));
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(portfolio, null, 2));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', endpoints: ['/', '/health', '/summary', '/positions', '/history'] }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read portfolio data', detail: err.message }));
  }
}

const server = createServer(handleRequest);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Polymarket portfolio tracker listening on port ${PORT}`);
});

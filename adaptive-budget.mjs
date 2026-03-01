#!/usr/bin/env node
// Adaptive session budgets based on effectiveness data from session history.
//
// Usage: node adaptive-budget.mjs <session_type> [--json]
// Outputs a single number: the recommended budget for that session type.
//
// Reads ~/.config/moltbook/session-history.txt.
// Computes cost/commit efficiency per type and adjusts budgets:
// - High-ROI types get more budget (up to cap)
// - Low-ROI types get less budget (down to floor)
// - E sessions judged on cost alone (commits=0 is expected)
//
// Port of adaptive-budget.py (wq-730).

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HISTORY = join(homedir(), '.config/moltbook/session-history.txt');

const BASE = { B: 10.0, R: 5.0, E: 5.0 };
const CAPS = { B: [5.0, 12.0], R: [3.0, 7.0], E: [2.0, 5.0] };

function parseSessions() {
  const sessions = [];
  let lines;
  try {
    lines = readFileSync(HISTORY, 'utf8').split('\n');
  } catch {
    return sessions;
  }
  const re = /^\S+ mode=(\w) s=(\d+) dur=~?(\d+)m(\d+)?s? cost=\$([0-9.]+) build=(\d+|\(none\))/;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(re);
    if (!m) continue;
    const mode = m[1];
    const cost = parseFloat(m[5]);
    const commitsRaw = m[6];
    const commits = commitsRaw.startsWith('(') ? 0 : parseInt(commitsRaw, 10);
    sessions.push({ mode, cost, commits });
  }
  return sessions;
}

function computeBudget(mode, sessions) {
  const base = BASE[mode] ?? 10.0;
  const [lo, hi] = CAPS[mode] ?? [3.0, 12.0];

  const typed = sessions.filter(s => s.mode === mode);
  if (typed.length < 3) return base;

  const recent = typed.slice(-10);
  const avgCost = recent.reduce((sum, s) => sum + s.cost, 0) / recent.length;
  const totalCommits = recent.reduce((sum, s) => sum + s.commits, 0);
  const costPerCommit = recent.reduce((sum, s) => sum + s.cost, 0) / Math.max(totalCommits, 1);

  let budget;
  if (mode === 'B' || mode === 'R') {
    if (costPerCommit < 0.6) {
      budget = base * 1.3;
    } else if (costPerCommit < 1.0) {
      budget = base * 1.15;
    } else if (costPerCommit < 2.0) {
      budget = base;
    } else {
      budget = base * 0.75;
    }
    if (avgCost < base * 0.5) {
      budget = Math.min(budget, base);
    }
  } else {
    if (avgCost < base * 0.6) {
      budget = base * 0.9;
    } else if (avgCost > base * 0.9) {
      budget = base * 1.1;
    } else {
      budget = base;
    }
  }

  return Math.round(Math.min(hi, Math.max(lo, budget)) * 100) / 100;
}

function allBudgets(sessions) {
  const result = {};
  for (const mode of ['B', 'R', 'E']) {
    const typed = sessions.filter(s => s.mode === mode);
    const recent = typed.length ? typed.slice(-10) : [];
    const avgCost = recent.length ? recent.reduce((sum, s) => sum + s.cost, 0) / recent.length : 0;
    const totalCommits = recent.reduce((sum, s) => sum + s.commits, 0);
    const cpc = recent.length ? recent.reduce((sum, s) => sum + s.cost, 0) / Math.max(totalCommits, 1) : 0;
    result[mode] = {
      budget: computeBudget(mode, sessions),
      base: BASE[mode],
      recent_count: recent.length,
      avg_cost: Math.round(avgCost * 100) / 100,
      cost_per_commit: Math.round(cpc * 100) / 100,
      total_commits: totalCommits,
    };
  }
  return result;
}

const asJson = process.argv.includes('--json');
const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
const mode = (args[0] || 'B').toUpperCase();
const sessions = parseSessions();

if (asJson) {
  console.log(JSON.stringify(allBudgets(sessions), null, 2));
} else if (!sessions.length) {
  console.log((BASE[mode] ?? 10.0).toFixed(2));
} else {
  console.log(computeBudget(mode, sessions).toFixed(2));
}

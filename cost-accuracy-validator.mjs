#!/usr/bin/env node
/**
 * cost-accuracy-validator.mjs — Session cost accuracy validator (wq-409)
 *
 * Compares agent-reported costs vs token-calc costs across sessions.
 * Flags sessions where they diverge >30% to detect broken cost reporting.
 *
 * Data sources:
 *   1. cost-history.json — pipeline-recorded cost with source field
 *   2. session-history.txt — heartbeat-recorded cost (the "official" number)
 *   3. Session log files — for retrospective token-calc on demand
 *
 * Usage:
 *   node cost-accuracy-validator.mjs              # Full report
 *   node cost-accuracy-validator.mjs --json       # JSON output
 *   node cost-accuracy-validator.mjs --recent 20  # Only last N sessions
 *   node cost-accuracy-validator.mjs --post-hook  # Post-session mode (dual-record)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.config/moltbook');
const COST_HISTORY = join(STATE_DIR, 'cost-history.json');
const SESSION_HISTORY = join(STATE_DIR, 'session-history.txt');
const LOGS_DIR = join(STATE_DIR, 'logs');
const ACCURACY_REPORT = join(STATE_DIR, 'cost-accuracy-report.json');
const CALC_SCRIPT = join(homedir(), 'moltbook-mcp/scripts/calc-session-cost.py');
const DIVERGENCE_THRESHOLD = 0.30; // 30%

function loadCostHistory() {
  if (!existsSync(COST_HISTORY)) return [];
  return JSON.parse(readFileSync(COST_HISTORY, 'utf8'));
}

function parseSessionHistory() {
  if (!existsSync(SESSION_HISTORY)) return {};
  const lines = readFileSync(SESSION_HISTORY, 'utf8').split('\n').filter(l => l.trim());
  const sessions = {};
  for (const line of lines) {
    const sMatch = line.match(/\bs=(\d+)\b/);
    const costMatch = line.match(/cost=\$([0-9.]+)/);
    const modeMatch = line.match(/mode=([A-Z])/);
    if (sMatch && costMatch) {
      const session = parseInt(sMatch[1]);
      sessions[session] = {
        cost: parseFloat(costMatch[1]),
        mode: modeMatch ? modeMatch[1] : '?',
        line: line.trim()
      };
    }
  }
  return sessions;
}

function findLogFile(sessionNum, costHistory) {
  // Find the cost-history entry to get the date
  const entry = costHistory.find(e => e.session === sessionNum);
  if (!entry || !entry.date) return null;

  // Log files are named YYYYMMDD_HHMMSS.log, started before cost-history date
  // List all .log files and pick the one closest before the cost-history date
  if (!existsSync(LOGS_DIR)) return null;
  const files = readdirSync(LOGS_DIR)
    .filter(f => /^\d{8}_\d{6}\.log$/.test(f))
    .sort();

  // The cost-history date is when the post-hook ran (end of session).
  // The log file timestamp is when the session started (earlier).
  // We want the log file whose timestamp is <= cost-history date.
  const endDate = new Date(entry.date);

  let bestFile = null;
  for (const f of files) {
    const ts = f.replace('.log', '');
    const year = ts.slice(0, 4);
    const month = ts.slice(4, 6);
    const day = ts.slice(6, 8);
    const hour = ts.slice(9, 11);
    const min = ts.slice(11, 13);
    const sec = ts.slice(13, 15);
    const fileDate = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);

    if (fileDate <= endDate) {
      bestFile = f; // Keep the latest one that's before the end date
    }
  }

  return bestFile ? join(LOGS_DIR, bestFile) : null;
}

function runTokenCalc(logFile) {
  try {
    const result = execSync(
      `python3 "${CALC_SCRIPT}" "${logFile}" --json`,
      { timeout: 15000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const parsed = JSON.parse(result.trim());
    return parsed.cost_usd;
  } catch {
    return null;
  }
}

function calcDivergence(a, b) {
  if (a === 0 && b === 0) return 0;
  const max = Math.max(a, b);
  if (max === 0) return 0;
  return Math.abs(a - b) / max;
}

function retrospectiveAnalysis(limit) {
  const costHistory = loadCostHistory();
  const sessionHistory = parseSessionHistory();
  const entries = limit ? costHistory.slice(-limit) : costHistory;

  const results = [];
  let divergent = 0;
  let matched = 0;
  let skipped = 0;

  for (const entry of entries) {
    const session = entry.session;
    const pipelineCost = entry.spent;
    const pipelineSource = entry.source;
    const historyEntry = sessionHistory[session];

    if (!historyEntry) {
      skipped++;
      continue;
    }

    const historyCost = historyEntry.cost;
    const divergence = calcDivergence(pipelineCost, historyCost);
    const isDivergent = divergence > DIVERGENCE_THRESHOLD;

    const record = {
      session,
      mode: entry.mode,
      pipeline_cost: pipelineCost,
      pipeline_source: pipelineSource,
      history_cost: historyCost,
      divergence_pct: Math.round(divergence * 100),
      flagged: isDivergent
    };

    // For divergent sessions, try to run token-calc if log file exists
    if (isDivergent) {
      const logFile = findLogFile(session, costHistory);
      if (logFile) {
        const tokenCalcCost = runTokenCalc(logFile);
        if (tokenCalcCost !== null) {
          record.token_calc_cost = tokenCalcCost;
          record.token_calc_vs_history = Math.round(calcDivergence(tokenCalcCost, historyCost) * 100);
        }
      }
      divergent++;
    } else {
      matched++;
    }

    results.push(record);
  }

  return {
    generated: new Date().toISOString(),
    total_sessions: results.length,
    matched,
    divergent,
    skipped,
    threshold_pct: Math.round(DIVERGENCE_THRESHOLD * 100),
    flagged_sessions: results.filter(r => r.flagged),
    all_sessions: results
  };
}

function postHookMode() {
  // Called as part of post-session pipeline (step 7 of 15-cost-pipeline.sh)
  // Reads env vars: SESSION_NUM, MODE_CHAR, DUAL_AGENT_COST, DUAL_TOKEN_COST
  // The cost pipeline captures both values in step 1 before deletion.
  const sessionNum = parseInt(process.env.SESSION_NUM || '0');
  const mode = process.env.MODE_CHAR || '?';

  if (!sessionNum) {
    console.error('cost-accuracy: missing SESSION_NUM env');
    process.exit(0);
  }

  // Read pre-captured dual costs from env (set by cost pipeline step 1)
  const agentCostStr = process.env.DUAL_AGENT_COST || '';
  const tokenCalcStr = process.env.DUAL_TOKEN_COST || '';

  let agentCost = agentCostStr ? parseFloat(agentCostStr) : null;
  let tokenCalcCost = tokenCalcStr ? parseFloat(tokenCalcStr) : null;

  if (agentCost !== null && isNaN(agentCost)) agentCost = null;
  if (tokenCalcCost !== null && isNaN(tokenCalcCost)) tokenCalcCost = null;

  // Record dual cost entry
  const dualRecord = {
    session: sessionNum,
    mode,
    date: new Date().toISOString(),
    agent_reported: agentCost,
    token_calc: tokenCalcCost
  };

  if (agentCost !== null && tokenCalcCost !== null && agentCost >= 0.10 && tokenCalcCost >= 0.10) {
    const divergence = calcDivergence(agentCost, tokenCalcCost);
    dualRecord.divergence_pct = Math.round(divergence * 100);
    dualRecord.flagged = divergence > DIVERGENCE_THRESHOLD;

    if (dualRecord.flagged) {
      console.log(`⚠ cost-accuracy: s${sessionNum} DIVERGENT — agent=$${agentCost.toFixed(2)} token-calc=$${tokenCalcCost.toFixed(2)} (${dualRecord.divergence_pct}% divergence)`);
    } else {
      console.log(`cost-accuracy: s${sessionNum} OK — agent=$${(agentCost || 0).toFixed(2)} token-calc=$${(tokenCalcCost || 0).toFixed(2)} (${dualRecord.divergence_pct}% divergence)`);
    }
  } else {
    dualRecord.divergence_pct = null;
    dualRecord.flagged = false;
    const agentStr = agentCost !== null ? `$${agentCost.toFixed(2)}` : 'n/a';
    const tokenStr = tokenCalcCost !== null ? `$${tokenCalcCost.toFixed(2)}` : 'n/a';
    console.log(`cost-accuracy: s${sessionNum} partial — agent=${agentStr} token-calc=${tokenStr}`);
  }

  // Append to dual-cost log
  const dualFile = join(STATE_DIR, 'cost-dual-record.json');
  let dualData = [];
  if (existsSync(dualFile)) {
    try { dualData = JSON.parse(readFileSync(dualFile, 'utf8')); } catch { dualData = []; }
  }
  dualData.push(dualRecord);
  dualData = dualData.slice(-200); // cap at 200
  writeFileSync(dualFile, JSON.stringify(dualData, null, 2) + '\n');

  return dualRecord;
}

function printReport(report) {
  console.log('='.repeat(60));
  console.log('SESSION COST ACCURACY REPORT');
  console.log('='.repeat(60));
  console.log(`\nAnalyzed: ${report.total_sessions} sessions`);
  console.log(`Matched (within ${report.threshold_pct}%): ${report.matched}`);
  console.log(`Divergent (>${report.threshold_pct}%): ${report.divergent}`);
  console.log(`Skipped (no history data): ${report.skipped}`);

  if (report.flagged_sessions.length > 0) {
    console.log(`\n--- Flagged Sessions (>${report.threshold_pct}% divergence) ---`);
    for (const s of report.flagged_sessions) {
      console.log(`\n  s${s.session} (${s.mode}): ${s.divergence_pct}% divergence`);
      console.log(`    Pipeline: $${s.pipeline_cost.toFixed(4)} (${s.pipeline_source})`);
      console.log(`    History:  $${s.history_cost.toFixed(4)}`);
      if (s.token_calc_cost !== undefined) {
        console.log(`    Token-calc (re-run): $${s.token_calc_cost.toFixed(4)} (${s.token_calc_vs_history}% vs history)`);
      }
    }
  } else {
    console.log('\nNo divergent sessions found.');
  }

  // Summary stats
  const agentReported = report.all_sessions.filter(s => s.pipeline_source === 'agent-reported');
  const tokenCalc = report.all_sessions.filter(s => s.pipeline_source === 'token-calc');
  const agentDivergent = agentReported.filter(s => s.flagged).length;
  const tokenDivergent = tokenCalc.filter(s => s.flagged).length;

  console.log('\n--- By Source ---');
  console.log(`  Agent-reported: ${agentReported.length} sessions, ${agentDivergent} divergent (${agentReported.length ? Math.round(agentDivergent / agentReported.length * 100) : 0}%)`);
  console.log(`  Token-calc:     ${tokenCalc.length} sessions, ${tokenDivergent} divergent (${tokenCalc.length ? Math.round(tokenDivergent / tokenCalc.length * 100) : 0}%)`);
}

// Main
const args = process.argv.slice(2);

if (args.includes('--post-hook')) {
  postHookMode();
} else {
  const recentIdx = args.indexOf('--recent');
  const limit = recentIdx !== -1 ? parseInt(args[recentIdx + 1]) : null;
  const report = retrospectiveAnalysis(limit);

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  // Save report
  writeFileSync(ACCURACY_REPORT, JSON.stringify(report, null, 2) + '\n');
}

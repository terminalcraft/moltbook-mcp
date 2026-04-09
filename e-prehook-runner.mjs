#!/usr/bin/env node
/**
 * e-prehook-runner.mjs — Single-process runner for E session prehook checks.
 *
 * Replaces 10 separate `node` subprocess invocations in 35-e-session-prehook_E.sh,
 * eliminating ~1-2s of Node startup overhead.
 *
 * Does NOT include Check 1 (engagement-liveness-probe.mjs) because it uses
 * process.exit() for hard timeout — that would kill the entire runner.
 *
 * Imports and runs:
 *   Check 2: e-session-seed.mjs         → generateSeed()
 *   Check 3: chatr-thread-tracker.mjs   → fetchAndUpdate() [async]
 *   Check 3: chatr-topic-clusters.mjs   → analyze()
 *   Check 4: conversation-balance.mjs   → balanceHistory()
 *   Check 5: spending-policy.mjs        → checkSpendingPolicy()
 *   Check 6: credential-health-check.mjs → checkAllCredentials()
 *   Check 7: engagement-variety-analyzer.mjs → utility functions
 *   Check 8: colony-jwt.mjs             → checkColonyJwt() [async]
 *   Phase 4: platform-picker.mjs        → main()
 *   Phase 4: picker-revalidate.mjs      → revalidateMandate()
 *
 * Output: JSON with results from all checks.
 * Usage: node e-prehook-runner.mjs --context-file <path> --policy-file <path> --session <N>
 *
 * Created: wq-983 (B#631)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { generateSeed } from './hooks/lib/e-session-seed.mjs';
import { fetchAndUpdate } from './chatr-thread-tracker.mjs';
import { analyze as topicAnalyze } from './chatr-topic-clusters.mjs';
import { balanceHistory } from './conversation-balance.mjs';
import { checkSpendingPolicy } from './hooks/lib/spending-policy.mjs';
import { checkAllCredentials } from './credential-health-check.mjs';
import {
  parseArgs as parseVarietyArgs,
  extractEngagementCounts,
  mergeEngagementCounts,
  calculateConcentration,
  calculateDistributionHealth,
} from './engagement-variety-analyzer.mjs';
import { checkColonyJwt } from './hooks/lib/colony-jwt.mjs';
import { main as pickerMain } from './platform-picker.mjs';
import { revalidateMandate } from './hooks/lib/picker-revalidate.mjs';

const HOME = process.env.HOME || '/home/moltbot';
const STATE_DIR = join(HOME, '.config/moltbook');
const HISTORY_FILE = join(STATE_DIR, 'session-history.txt');
const INTEL_FILE = join(STATE_DIR, 'engagement-intel.json');
const TRACE_PATH = join(STATE_DIR, 'engagement-trace.json');

// Parse args
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}
const contextFile = getArg('--context-file') || join(STATE_DIR, 'e-session-context.md');
const policyFile = getArg('--policy-file') || join(STATE_DIR, 'spending-policy.json');
const sessionNum = parseInt(getArg('--session') || process.env.SESSION_NUM || '0', 10);

function safeRun(label, fn) {
  try {
    return { ok: true, result: fn() };
  } catch (e) {
    return { ok: false, error: `${label}: ${(e.message || 'unknown').slice(0, 200)}` };
  }
}

async function safeRunAsync(label, fn) {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    return { ok: false, error: `${label}: ${(e.message || 'unknown').slice(0, 200)}` };
  }
}

// ---- Check 2: Seed ----
const seed = safeRun('seed', () => {
  const nudgeFile = join(STATE_DIR, 'd049-nudge.txt');
  const result = generateSeed({
    historyFile: HISTORY_FILE,
    intelFile: INTEL_FILE,
    nudgeFile,
  });
  // Write context file (generateSeed returns { text, lines, sections })
  writeFileSync(contextFile, result.text || '');
  return { wrote: contextFile, lines: result.lines, sections: result.sections };
});

// ---- Check 4: Conversation balance ----
const balance = safeRun('conversation-balance', () => {
  const history = balanceHistory(5);
  return {
    trend: history.trend,
    avgRatio: history.avg_post_to_agent_ratio,
    breakdown: history.breakdown,
    warning: history.trend === 'worsening',
  };
});

// ---- Check 5: Spending policy ----
const spending = safeRun('spending-policy', () => {
  if (!existsSync(policyFile)) {
    return { status: 'disabled', reason: 'no policy file' };
  }
  const currentMonth = new Date().toISOString().slice(0, 7);
  return checkSpendingPolicy({ policyFile, currentMonth });
});

// ---- Check 6: Credential health ----
const creds = safeRun('credential-health', () => {
  return checkAllCredentials();
});

// ---- Check 7: Engagement variety ----
const variety = safeRun('engagement-variety', () => {
  let traces;
  try {
    traces = JSON.parse(readFileSync(TRACE_PATH, 'utf8'));
  } catch {
    return { error: 'No engagement trace data' };
  }
  if (!Array.isArray(traces) || traces.length === 0) {
    return { error: 'No engagement trace data' };
  }

  const recentSessions = traces.slice(-10);
  const counts = mergeEngagementCounts(recentSessions);
  const concentration = calculateConcentration(counts);
  const health = calculateDistributionHealth(concentration, 0.5);

  return {
    healthScore: health.healthScore,
    topPlatform: concentration.topPlatform,
    topConcentrationPct: concentration.topConcentrationPct,
    recommendation: health.recommendation,
    isConcentrated: health.isConcentrated,
    alert: health.isConcentrated ? {
      level: health.healthScore === 'CRITICAL' ? 'critical' : 'warning',
      message: health.recommendation,
    } : null,
  };
});

// ---- Async checks: run in parallel ----
// Check 3: Thread tracker + topic clusters
// Check 8: Colony JWT
const asyncResults = await Promise.allSettled([
  // Check 3a: Thread tracker update (async, network)
  safeRunAsync('chatr-thread-tracker', async () => {
    const result = await fetchAndUpdate();
    return {
      error: result.error,
      messagesProcessed: result.messagesProcessed || 0,
    };
  }),

  // Check 8: Colony JWT (async, potential network)
  safeRunAsync('colony-jwt', () => checkColonyJwt()),
]);

const threadTracker = asyncResults[0].status === 'fulfilled'
  ? asyncResults[0].value
  : { ok: false, error: 'thread-tracker: promise rejected' };

const colonyJwt = asyncResults[1].status === 'fulfilled'
  ? asyncResults[1].value
  : { ok: false, error: 'colony-jwt: promise rejected' };

// Check 3b: Topic clusters (sync, uses state from thread tracker)
const topics = safeRun('topic-clusters', () => topicAnalyze({ hours: 72 }));

// ---- Phase 4: Picker + revalidate ----
// Suppress stdout from picker (it prints to console)
const pickerResult = safeRun('platform-picker', () => {
  const origLog = console.log;
  const origError = console.error;
  const captured = [];
  console.log = (...args) => captured.push(args.join(' '));
  console.error = () => {};
  try {
    // Set argv for picker: --count 3 --update --backups 2
    const origArgv = process.argv;
    process.argv = ['node', 'platform-picker.mjs', '--count', '3', '--update', '--backups', '2'];
    pickerMain();
    process.argv = origArgv;
    return { output: captured.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
});

const revalidate = safeRun('picker-revalidate', () => {
  const mandatePath = join(STATE_DIR, 'picker-mandate.json');
  if (!existsSync(mandatePath)) {
    return { error: 'no mandate file', revalidated: false };
  }
  return revalidateMandate();
});

// ---- Assemble output ----
const output = {
  seed: seed.ok ? seed.result : { error: seed.error },
  thread_tracker: threadTracker.ok ? threadTracker.result : { error: threadTracker.error },
  topic_clusters: topics.ok ? topics.result : { error: topics.error },
  conversation_balance: balance.ok ? balance.result : { error: balance.error },
  spending_policy: spending.ok ? spending.result : { error: spending.error },
  credential_health: creds.ok ? creds.result : { error: creds.error },
  engagement_variety: variety.ok ? variety.result : { error: variety.error },
  colony_jwt: colonyJwt.ok ? colonyJwt.result : { error: colonyJwt.error },
  picker: pickerResult.ok ? pickerResult.result : { error: pickerResult.error },
  picker_revalidate: revalidate.ok ? revalidate.result : { error: revalidate.error },
};

console.log(JSON.stringify(output));

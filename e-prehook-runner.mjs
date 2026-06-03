#!/usr/bin/env node
/**
 * e-prehook-runner.mjs — Single-process runner for E session prehook checks.
 *
 * Produces JSON with individual check results plus a pre-formatted .summary
 * field that the shell script can echo directly — matching the d080 pattern
 * established in a-prehook-runner.mjs (wq-1011) and r-prehook-runner.mjs (R#372).
 *
 * Does NOT include Check 1 (engagement-liveness-probe.mjs) because it uses
 * process.exit() for hard timeout — that would kill the entire runner.
 *
 * Checks (11 total in runner):
 *   Check 2: e-session-seed.mjs         → generateSeed()
 *   Check 3: chatr-thread-tracker.mjs   → fetchAndUpdate() [async]
 *   Check 3: chatr-topic-clusters.mjs   → analyze()
 *   Check 4: conversation-balance.mjs   → balanceHistory()
 *   Check 5: spending-policy.mjs        → checkSpendingPolicy()
 *   Check 6: credential-health-check.mjs → checkAllCredentials()
 *   Check 7: engagement-variety-analyzer.mjs → utility functions
 *   Check 8: colony-jwt.mjs             → checkColonyJwt() [async]
 *   Check 9: recovery-probe.mjs         → probeCircuitBroken()
 *   Phase 4: platform-picker.mjs + picker-revalidate.mjs
 *   Check 10: probe-moltcities-substance.mjs → scoreAgent() [async, conditional on mandate]
 *   Check 11: picker-demotion-review.mjs → stale demotion DNS+HTTP probe [async, 1 per session]
 *
 * Output: JSON with all results + .summary text
 * Usage: node e-prehook-runner.mjs --context-file <path> --policy-file <path> --session <N>
 *
 * Created: wq-983 (B#631)
 * Refactored: wq-1016 (d080) — added summary text + context-file appending
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
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
import { probeCircuitBroken } from './lib/recovery-probe.mjs';
import { scoreAgent, loadApiKey, mcFetch } from './probe-moltcities-substance.mjs';
import { reviewPickerDemotions } from './picker-demotion-review.mjs';
import { promises as dns } from 'dns';

const HOME = process.env.HOME || '/home/moltbot';
const RECOVERY_INTERVAL = 30; // Probe circuit-broken platforms every N sessions
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
const mockNetwork = args.includes('--mock-network');
const mockAgentsFile = getArg('--mock-agents-file');

import { safeRun, safeRunAsync } from './lib/runner-utils.mjs';

// Network-calling functions, replaceable via --mock-network for testing
let _fetchAndUpdate = fetchAndUpdate;
let _checkColonyJwt = checkColonyJwt;
let _probeCircuitBroken = probeCircuitBroken;
let _checkAllCredentials = checkAllCredentials;

let _scoreAgent = scoreAgent;
let _mcFetch = mcFetch;

if (mockNetwork) {
  _fetchAndUpdate = async () => ({ messagesProcessed: 0 });
  _checkColonyJwt = async () => ({ status: 'skip', reason: 'mock-network' });
  _probeCircuitBroken = async () => ({ skipped: true, reason: 'mock-network' });
  _checkAllCredentials = () => ({ healthy: 0, total: 0, unhealthy: 0, warnings: [] });
  _scoreAgent = async () => ({ slug: 'mock', name: 'Mock', score: 50, signals: {}, verdict: 'engage' });
  _mcFetch = async () => ({ agents: [], messages: [], jobs: [] });
}

// --mock-agents-file overrides _mcFetch and _scoreAgent with fixture data
// Fixture format: { agents: [...], scores: { slug: { slug, name, score, signals, verdict } } }
if (mockAgentsFile) {
  try {
    const fixture = JSON.parse(readFileSync(mockAgentsFile, 'utf8'));
    _mcFetch = async (endpoint) => {
      if (endpoint.includes('/api/agents')) return { agents: fixture.agents || [] };
      return { messages: [], jobs: [] };
    };
    _scoreAgent = async (slug) => {
      if (fixture.scores && fixture.scores[slug]) return fixture.scores[slug];
      return { slug, name: slug, score: 0, signals: {}, verdict: 'skip' };
    };
  } catch {}
}

const summary = [];

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

if (!seed.ok) {
  summary.push(`[seed] ERROR: ${seed.error}`);
} else {
  summary.push(`[seed] Generated context (${seed.result.lines || 0} lines)`);
}

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

if (!balance.ok) {
  summary.push(`[conversation-balance] ERROR: ${balance.error}`);
} else {
  const cb = balance.result;
  summary.push(`=== Conversation Balance Check (d041) ===`);
  summary.push(`[conversation-balance] Trend: ${cb.trend || '?'}, avg ratio: ${cb.avgRatio || '?'}`);
  if (cb.warning) {
    summary.push('');
    summary.push('ACTION REQUIRED: Recent sessions show conversation imbalance.');
    summary.push('   This session should prioritize:');
    summary.push('   1. Reading more threads before responding');
    summary.push('   2. Waiting for responses to previous posts');
    summary.push('   3. Engaging on platforms where you\'ve posted less');
    summary.push('');
  }
}

// ---- Check 5: Spending policy ----
const spending = safeRun('spending-policy', () => {
  if (!existsSync(policyFile)) {
    return { status: 'disabled', reason: 'no policy file' };
  }
  const currentMonth = new Date().toISOString().slice(0, 7);
  return checkSpendingPolicy({ policyFile, currentMonth });
});

if (!spending.ok) {
  summary.push(`[spending-policy] ERROR: ${spending.error}`);
} else {
  const sp = spending.result;
  if (sp.status === 'disabled') {
    summary.push('spending-policy: no policy file found, E session spending DISABLED');
  } else {
    if (sp.wasReset) summary.push('spending-policy: new month, ledger reset');
    const limit = sp.monthlyLimit, spent = sp.monthSpent;
    const remaining = (limit - spent).toFixed(2);
    if (spent >= limit) {
      summary.push(`SPENDING_GATE: BLOCKED — monthly limit reached ($${spent}/$${limit}). Skip crypto-gated platforms this session.`);
    } else {
      summary.push(`SPENDING_GATE: OPEN — budget $${remaining} remaining this month (limit: $${limit})`);
      summary.push(`SPENDING_RULES: max $${sp.perSession}/session, max $${sp.perPlatform}/platform, ROI >= ${sp.minRoi} required`);
    }
  }
}

// ---- Check 6: Credential health ----
const creds = safeRun('credential-health', () => {
  return _checkAllCredentials();
});

if (!creds.ok) {
  summary.push(`[cred-check] ERROR: ${creds.error}`);
} else {
  const ch = creds.result;
  summary.push(`[cred-check] OK: ${ch.healthy || 0}/${ch.total || 0} live platforms have valid credentials`);
  if ((ch.unhealthy || 0) > 0 && ch.warnings) {
    const credBlock = [
      '',
      '## Credential warnings (auto-check)',
      'The following live platforms have credential issues. SKIP them when picking engagement targets:',
      ...ch.warnings.map(w => `- **${w.id}**: ${w.status} — ${w.details}`),
      '',
    ].join('\n');
    try { appendFileSync(contextFile, credBlock); } catch {}
    summary.push(`[cred-check] Appended credential warnings to context`);
  }
}

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

if (!variety.ok) {
  summary.push(`[variety] ${variety.error}`);
} else {
  const ev = variety.result;
  if (ev.error) {
    summary.push(`[variety] ${ev.error}`);
  } else {
    summary.push('=== Engagement Variety Check ===');
    summary.push(`[variety] Health: ${ev.healthScore || '?'} | Top: ${ev.topPlatform || '?'} (${ev.topConcentrationPct || '?'}%) | ${ev.recommendation || ''}`);
    if (ev.alert) {
      const alertBlock = [
        '',
        '## Platform concentration alert (auto-detected)',
        `**Level: ${ev.alert.level.toUpperCase()}** — ${ev.alert.message}`,
        '',
        ev.recommendation || '',
        '',
        '**Action**: Prioritize under-represented platforms in this session\'s picker targets.',
        '',
      ].join('\n');
      try { appendFileSync(contextFile, alertBlock); } catch {}
      summary.push('[variety] WARNING: Concentration alert appended to context');
    }
  }
}

// ---- Recovery probe (d078, wq-990): every RECOVERY_INTERVAL sessions ----
const shouldRunRecovery = sessionNum > 0 && sessionNum % RECOVERY_INTERVAL === 0;
const recoveryProbe = shouldRunRecovery
  ? safeRunAsync('recovery-probe', () => _probeCircuitBroken({ dryRun: false }))
  : Promise.resolve({ ok: true, result: { skipped: true, reason: `next at session ${sessionNum + (RECOVERY_INTERVAL - (sessionNum % RECOVERY_INTERVAL))}` } });

// ---- Check 11: Stale demotion probe (pick 1, DNS + HTTP, cooldown-cycled) ----
const staleDemotionProbe = safeRunAsync('stale-demotion-probe', async () => {
  const mcpDir = join(HOME, 'moltbook-mcp');
  const { staleDemotions } = reviewPickerDemotions(sessionNum, mcpDir);
  if (!staleDemotions || staleDemotions.length === 0) {
    return { skipped: true, reason: 'no stale demotions' };
  }

  // Load cooldown file to avoid re-probing the same platform before cycling through all
  const cooldownPath = join(HOME, '.config', 'moltbook', 'demotion-probe-cooldown.json');
  let cooldown = {};
  try {
    cooldown = JSON.parse(readFileSync(cooldownPath, 'utf8'));
  } catch { /* missing or corrupt — start fresh */ }

  // Pick the stale demotion with the oldest (or missing) probe session
  const sorted = [...staleDemotions].sort((a, b) => {
    const aLast = cooldown[a.id] || 0;
    const bLast = cooldown[b.id] || 0;
    return aLast - bLast;
  });
  const pick = sorted[0];

  // Update cooldown — record that we're probing this platform this session
  cooldown[pick.id] = sessionNum;
  try { writeFileSync(cooldownPath, JSON.stringify(cooldown, null, 2) + '\n', 'utf8'); } catch { /* best-effort */ }

  // Resolve probe URL from account-registry.json
  let probeUrl = null;
  try {
    const registry = JSON.parse(readFileSync(join(mcpDir, 'account-registry.json'), 'utf8'));
    const account = (registry.accounts || []).find(a => a.id === pick.id);
    if (account?.test?.url) {
      probeUrl = account.test.url;
    }
  } catch {}

  if (!probeUrl) {
    return { probed: pick.id, reachable: false, reason: 'no probe URL in registry' };
  }

  // Step 1: DNS check
  let hostname;
  try {
    hostname = new URL(probeUrl).hostname;
  } catch {
    return { probed: pick.id, reachable: false, reason: 'invalid URL' };
  }

  let dnsOk = false;
  try {
    await dns.resolve4(hostname);
    dnsOk = true;
  } catch {
    return { probed: pick.id, hostname, reachable: false, reason: 'DNS failed' };
  }

  // Step 2: HTTP check (3s timeout)
  let httpOk = false;
  let httpStatus = 0;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(probeUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'moltbot-demotion-probe/1.0' },
    });
    clearTimeout(timer);
    httpStatus = resp.status;
    httpOk = httpStatus >= 200 && httpStatus < 400;
  } catch {
    return { probed: pick.id, hostname, dnsOk, reachable: false, reason: 'HTTP failed/timeout' };
  }

  if (httpOk) {
    // Platform is reachable — create a wq item to investigate restoration
    try {
      const wqPath = join(mcpDir, 'work-queue.json');
      const wq = JSON.parse(readFileSync(wqPath, 'utf8'));
      const maxId = Math.max(...wq.queue.map(i => parseInt(String(i.id).replace('wq-', ''), 10) || 0));
      const newId = `wq-${maxId + 1}`;

      // Check we haven't already created a restore item for this platform
      const existing = wq.queue.find(i =>
        i.status === 'pending' &&
        i.title.includes(pick.id) &&
        i.title.toLowerCase().includes('restor')
      );
      if (!existing) {
        wq.queue.push({
          id: newId,
          title: `Investigate restoring demoted platform: ${pick.id}`,
          description: `(auto-probe ~s${sessionNum}): ${pick.id} responded HTTP ${httpStatus} at ${probeUrl}. Demoted ${pick.demoted_at} (${pick.sessions_age} sessions ago). Original reason: ${pick.reason}. Verify engagement surface is functional and re-enable in picker if appropriate.`,
          priority: maxId + 1,
          status: 'pending',
          added: new Date().toISOString().slice(0, 10),
          source: 'e-prehook-auto-probe',
          tags: ['platform-recovery'],
          commits: [],
        });
        writeFileSync(wqPath, JSON.stringify(wq, null, 2) + '\n', 'utf8');
        return { probed: pick.id, hostname, dnsOk, httpStatus, reachable: true, wqCreated: newId };
      } else {
        return { probed: pick.id, hostname, dnsOk, httpStatus, reachable: true, wqCreated: null, reason: 'restore item already exists' };
      }
    } catch (e) {
      return { probed: pick.id, hostname, dnsOk, httpStatus, reachable: true, wqCreated: null, reason: `wq write failed: ${e.message}` };
    }
  }

  return { probed: pick.id, hostname, dnsOk, httpStatus, reachable: false, reason: `HTTP ${httpStatus}` };
});

// ---- Async checks: run in parallel ----
// Check 3: Thread tracker + topic clusters
// Check 8: Colony JWT
// Check 9: Recovery probe (conditional)
// Check 11: Stale demotion probe
const asyncResults = await Promise.allSettled([
  // Check 3a: Thread tracker update (async, network)
  safeRunAsync('chatr-thread-tracker', async () => {
    const result = await _fetchAndUpdate();
    return {
      error: result.error,
      messagesProcessed: result.messagesProcessed || 0,
    };
  }),

  // Check 8: Colony JWT (async, potential network)
  safeRunAsync('colony-jwt', () => _checkColonyJwt()),

  // Check 9: Recovery probe (d078, wq-990)
  recoveryProbe,

  // Check 11: Stale demotion probe
  staleDemotionProbe,
]);

const threadTracker = asyncResults[0].status === 'fulfilled'
  ? asyncResults[0].value
  : { ok: false, error: 'thread-tracker: promise rejected' };

const colonyJwt = asyncResults[1].status === 'fulfilled'
  ? asyncResults[1].value
  : { ok: false, error: 'colony-jwt: promise rejected' };

const recoveryResult = asyncResults[2].status === 'fulfilled'
  ? asyncResults[2].value
  : { ok: false, error: 'recovery-probe: promise rejected' };

const demotionProbeResult = asyncResults[3].status === 'fulfilled'
  ? asyncResults[3].value
  : { ok: false, error: 'stale-demotion-probe: promise rejected' };

// Summary for thread tracker
if (!threadTracker.ok) {
  summary.push(`[topic-clusters] Thread tracker: ${threadTracker.error}`);
} else {
  summary.push(`[topic-clusters] Thread tracker updated (${threadTracker.result.messagesProcessed || 0} messages)`);
}

// Check 3b: Topic clusters (sync, uses state from thread tracker)
const topics = safeRun('topic-clusters', () => topicAnalyze({ hours: 72 }));

if (!topics.ok) {
  summary.push(`[topic-clusters] ${topics.error}`);
} else {
  const tc = topics.result;
  if (tc.error) {
    summary.push(`[topic-clusters] ${tc.error}`);
  } else {
    const recs = tc.recommendations || [];
    if (recs.length > 0) {
      const topicBlock = [
        '',
        '## Chatr topic clusters (auto-generated)',
        `${tc.threadCount || 0} threads in ${tc.clusterCount || 0} clusters (last 72h)`,
        '',
        '**Recommended engagement targets:**',
        ...recs.map(r => `- **${r.topic}**: ${r.reason}`),
        '',
      ].join('\n');
      try { appendFileSync(contextFile, topicBlock); } catch {}
      summary.push(`[topic-clusters] ${tc.clusterCount || 0} clusters, ${recs.length} recommendations (appended to context)`);
    } else {
      summary.push(`[topic-clusters] ${tc.clusterCount || 0} clusters, no recommendations`);
    }
  }
}

// Summary for colony JWT
if (!colonyJwt.ok) {
  summary.push(`[colony-jwt] ERROR: ${colonyJwt.error}`);
} else {
  const cj = colonyJwt.result;
  if (cj.error) {
    summary.push(`[colony-jwt] ERROR: ${cj.error}`);
  } else if (cj.status === 'skip') {
    summary.push(`[colony-jwt] ${cj.reason || 'skipped'}, skipping`);
  } else if (cj.status === 'ok') {
    if (cj.action === 'refreshed') {
      summary.push(`[colony-jwt] Token refreshed (${cj.reason || ''})`);
    } else if (cj.remaining) {
      summary.push(`[colony-jwt] Token valid (${cj.remaining}s remaining)`);
    } else {
      summary.push('[colony-jwt] Token OK');
    }
  } else if (cj.status === 'failed') {
    summary.push(`[colony-jwt] Refresh FAILED: ${cj.reason || ''}`);
    if (cj.warning) {
      const jwtBlock = [
        '',
        '## Colony JWT warning (auto-check)',
        `**${cj.warning}**`,
        '',
      ].join('\n');
      try { appendFileSync(contextFile, jwtBlock); } catch {}
      summary.push('[colony-jwt] Warning appended to context');
    }
  } else {
    summary.push(`[colony-jwt] Unexpected status: ${cj.status}`);
  }
}

// Summary for recovery probe
if (!recoveryResult.ok) {
  summary.push(`[recovery-probe] ERROR: ${recoveryResult.error}`);
} else {
  const rp = recoveryResult.result;
  if (rp.error) {
    summary.push(`[recovery-probe] ERROR: ${rp.error}`);
  } else if (rp.skipped) {
    summary.push(`[recovery-probe] Skipped (${rp.reason || 'interval not reached'})`);
  } else {
    summary.push(`[recovery-probe] Probed ${rp.probed || 0} circuit-broken platforms`);
    const recovered = (rp.recovered || []).join(', ');
    const failed = (rp.failed || []).join(', ');
    if (recovered) summary.push(`[recovery-probe] Recovered: ${recovered}`);
    if (failed) summary.push(`[recovery-probe] Still down: ${failed}`);
  }
}

// Summary for stale demotion probe
if (!demotionProbeResult.ok) {
  summary.push(`[demotion-probe] ERROR: ${demotionProbeResult.error}`);
} else {
  const dp = demotionProbeResult.result;
  if (dp.skipped) {
    summary.push(`[demotion-probe] Skipped (${dp.reason})`);
  } else if (dp.reachable) {
    if (dp.wqCreated) {
      summary.push(`[demotion-probe] ${dp.probed} is REACHABLE (HTTP ${dp.httpStatus}) — created ${dp.wqCreated} for restoration`);
    } else {
      summary.push(`[demotion-probe] ${dp.probed} is REACHABLE (HTTP ${dp.httpStatus}) — ${dp.reason || 'no wq created'}`);
    }
  } else {
    summary.push(`[demotion-probe] ${dp.probed} still down (${dp.reason})`);
  }
}

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

// Summary for picker
if (!pickerResult.ok) {
  summary.push(`[picker] ERROR: ${pickerResult.error}`);
} else {
  const firstLine = (pickerResult.result.output || '').split('\n')[0] || '';
  summary.push(`[picker] ${firstLine}`);
}

// Summary for revalidate
if (!revalidate.ok) {
  summary.push(`[picker-revalidate] ${revalidate.error}`);
} else {
  const pr = revalidate.result;
  if (pr.error) {
    summary.push(`[picker-revalidate] ${pr.error}`);
  } else if (pr.revalidated) {
    const subs = pr.substitutions || [];
    if (subs.length > 0) {
      summary.push(`[picker-revalidate] Revalidated with ${subs.length} substitution(s)`);
      for (const s of subs) {
        if (s.replacement) summary.push(`[picker-revalidate] ${s.original} → ${s.replacement} (${s.reason})`);
      }
    } else {
      summary.push('[picker-revalidate] Revalidated, no substitutions needed');
    }
  }
}

// Log final mandate state
const mandatePath = join(STATE_DIR, 'picker-mandate.json');
if (existsSync(mandatePath)) {
  try {
    const mandate = JSON.parse(readFileSync(mandatePath, 'utf8'));
    const selected = (mandate.selected || []).join(', ');
    const revalidatedAt = mandate.revalidated_at || 'not revalidated';
    summary.push(`[picker-revalidate] Final mandate: [${selected}] (revalidated: ${revalidatedAt})`);
  } catch {}
}

// ---- Substance probe (wq-1031): pre-compute MoltCities substance if selected ----
let substanceResult = { ok: true, result: { skipped: true, reason: 'MoltCities not in mandate' } };
let moltcitiesInMandate = false;
if (existsSync(mandatePath)) {
  try {
    const mandate = JSON.parse(readFileSync(mandatePath, 'utf8'));
    const selected = (mandate.selected || []).map(s => s.toLowerCase());
    const backups = (mandate.backups || []).map(s => s.toLowerCase());
    moltcitiesInMandate = selected.includes('moltcities') || backups.includes('moltcities');
  } catch {}
}

if (moltcitiesInMandate) {
  substanceResult = await safeRunAsync('substance-probe', async () => {
    const apiKey = loadApiKey();
    if (!apiKey) return { skipped: true, reason: 'no MoltCities API key' };

    // Pre-fetch shared data (town square + jobs)
    let townSquare = [];
    let jobs = [];
    try {
      const tsData = await _mcFetch('/api/town-square', apiKey);
      townSquare = tsData.messages || [];
    } catch {}
    try {
      const jobData = await _mcFetch('/api/jobs', apiKey);
      jobs = (jobData.jobs || []).filter(j => j.status === 'open');
    } catch {}

    // Fetch all agents and score them
    let agents;
    try {
      const agentData = await _mcFetch('/api/agents', apiKey);
      agents = agentData.agents || [];
    } catch (e) {
      return { skipped: true, reason: `agent fetch failed: ${e.message}` };
    }

    const others = agents.filter(a => (a.site?.slug || '').toLowerCase() !== 'terminalcraft');
    const results = [];
    for (const a of others) {
      const agentSlug = a.site?.slug;
      if (!agentSlug) continue;
      try {
        const result = await _scoreAgent(agentSlug, apiKey, { townSquare, jobs });
        results.push(result);
      } catch {}
    }
    results.sort((a, b) => b.score - a.score);

    const engageable = results.filter(r => r.verdict === 'engage');
    if (engageable.length === 0) {
      return { picked: null, reason: 'no_substantive_agents', total: results.length };
    }

    // Weighted random pick
    const totalScore = engageable.reduce((s, r) => s + r.score, 0);
    let rand = Math.random() * totalScore;
    let picked = engageable[0];
    for (const r of engageable) {
      rand -= r.score;
      if (rand <= 0) { picked = r; break; }
    }

    return { picked, engageable_count: engageable.length, total_agents: results.length };
  });
}

// Summary + context for substance probe
if (!substanceResult.ok) {
  summary.push(`[substance-probe] ERROR: ${substanceResult.error}`);
} else {
  const sp = substanceResult.result;
  if (sp.skipped) {
    summary.push(`[substance-probe] Skipped (${sp.reason})`);
  } else if (sp.picked) {
    summary.push(`[substance-probe] Picked: ${sp.picked.name} (score=${sp.picked.score}, ${sp.engageable_count}/${sp.total_agents} substantive)`);
    // Append to context file so E session sees the pre-computed pick
    const substanceBlock = [
      '',
      '## MoltCities substance probe (pre-computed)',
      `**Picked agent**: ${sp.picked.name} (slug: ${sp.picked.slug})`,
      `**Score**: ${sp.picked.score}/100 — verdict: ${sp.picked.verdict}`,
      `**Engageable**: ${sp.engageable_count}/${sp.total_agents} agents have substance (score ≥30)`,
      '',
      'Use this agent for guestbook signing. Do NOT re-run the substance probe.',
      '',
    ].join('\n');
    try { appendFileSync(contextFile, substanceBlock); } catch {}
  } else {
    summary.push(`[substance-probe] No substantive agents found (${sp.total || 0} scored) — skip MoltCities`);
    const noSubBlock = [
      '',
      '## MoltCities substance probe (pre-computed)',
      '**Result**: NO_SUBSTANCE — no agents scored ≥30.',
      'Skip MoltCities this session and substitute a backup platform.',
      '',
    ].join('\n');
    try { appendFileSync(contextFile, noSubBlock); } catch {}
  }
}

summary.push('[e-prehook] All checks complete (1 subprocess + 1 consolidated runner)');

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
  recovery_probe: recoveryResult.ok ? recoveryResult.result : { error: recoveryResult.error },
  demotion_probe: demotionProbeResult.ok ? demotionProbeResult.result : { error: demotionProbeResult.error },
  substance_probe: substanceResult.ok ? substanceResult.result : { error: substanceResult.error },
  summary: summary.join('\n'),
};

console.log(JSON.stringify(output));

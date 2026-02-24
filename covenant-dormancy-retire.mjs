#!/usr/bin/env node
// covenant-dormancy-retire.mjs — Auto-retire dormant covenant partners.
// wq-589: Covenant ceiling at 20/20. Identifies partners not seen in
// engagement-trace for 50+ sessions and retires them, freeing slots.
//
// Usage:
//   node covenant-dormancy-retire.mjs                  # Dry run (preview only)
//   node covenant-dormancy-retire.mjs --execute        # Actually retire dormant partners
//   node covenant-dormancy-retire.mjs --threshold 100  # Custom dormancy threshold (default: 50)
//   node covenant-dormancy-retire.mjs --max 5          # Retire at most N partners (default: unlimited)
//   node covenant-dormancy-retire.mjs --json           # Machine-readable output
//
// Designed for hook integration: exits 0 on success, 1 on error.
// Writes retirement log to ~/.config/moltbook/dormancy-retirements.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const COVENANTS_PATH = join(STATE_DIR, 'covenants.json');
const TRACE_PATH = join(STATE_DIR, 'engagement-trace.json');
const TRACE_ARCHIVE_PATH = join(STATE_DIR, 'engagement-trace-archive.json');
const SESSION_HISTORY_PATH = join(STATE_DIR, 'session-history.txt');
const RETIREMENT_LOG_PATH = join(STATE_DIR, 'dormancy-retirements.json');

const DEFAULT_THRESHOLD = 50;

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJSON(path, data) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function getCurrentSession() {
  // Prefer env var (set by heartbeat.sh)
  const envSession = parseInt(process.env.SESSION_NUM, 10);
  if (envSession > 0) return envSession;

  try {
    const lines = readFileSync(SESSION_HISTORY_PATH, 'utf8').trim().split('\n');
    const last = lines[lines.length - 1];
    const match = last.match(/s=(\d+)/);
    return match ? parseInt(match[1]) : 0;
  } catch { return 0; }
}

function buildTraceIndex() {
  const archive = readJSON(TRACE_ARCHIVE_PATH) || [];
  const current = readJSON(TRACE_PATH);
  const traces = [...archive];
  if (Array.isArray(current)) traces.push(...current);
  else if (current && current.session) traces.push(current);

  const agentLastSeen = {};
  for (const entry of traces) {
    const session = entry.session || 0;
    for (const a of (entry.agents_interacted || [])) {
      const handle = a.replace(/^@/, '');
      if (!agentLastSeen[handle] || session > agentLastSeen[handle]) {
        agentLastSeen[handle] = session;
      }
    }
  }
  return agentLastSeen;
}

function findDormantPartners(threshold) {
  const covenants = readJSON(COVENANTS_PATH);
  if (!covenants || !covenants.agents) return { dormant: [], currentSession: 0 };

  const currentSession = getCurrentSession();
  const agentLastSeen = buildTraceIndex();
  const dormant = [];

  for (const [name, data] of Object.entries(covenants.agents)) {
    const activeCovs = (data.templated_covenants || []).filter(c => c.status === 'active');
    if (activeCovs.length === 0) continue;

    // Calculate last activity from both covenant sessions and trace
    const sessions = data.sessions || [];
    const lastCovenantSession = sessions.length > 0 ? Math.max(...sessions) : 0;
    const lastTraceSession = agentLastSeen[name] || 0;
    const lastActivity = Math.max(lastCovenantSession, lastTraceSession);
    const sessionsSinceLastSeen = currentSession - lastActivity;

    if (sessionsSinceLastSeen >= threshold) {
      dormant.push({
        name,
        strength: data.covenant_strength,
        lastActivity,
        sessionsSinceLastSeen,
        totalSessions: sessions.length,
        activeCovenants: activeCovs.map(c => c.template),
        covenantCount: activeCovs.length,
      });
    }
  }

  // Sort by dormancy (most dormant first)
  dormant.sort((a, b) => b.sessionsSinceLastSeen - a.sessionsSinceLastSeen);
  return { dormant, currentSession };
}

function retirePartners(partners, dryRun) {
  if (dryRun) return partners.map(p => ({ ...p, action: 'would-retire' }));

  const covenants = readJSON(COVENANTS_PATH);
  if (!covenants || !covenants.agents) return [];

  const currentSession = getCurrentSession();
  const now = new Date().toISOString();
  const results = [];

  for (const partner of partners) {
    const agentData = covenants.agents[partner.name];
    if (!agentData || !agentData.templated_covenants) continue;

    let retired = 0;
    for (const cov of agentData.templated_covenants) {
      if (cov.status === 'active') {
        cov.status = 'retired';
        cov.retired_at = now;
        cov.retired_session = currentSession;
        cov.retired_reason = 'dormancy-auto-retirement';
        cov.dormancy_sessions = partner.sessionsSinceLastSeen;
        retired++;
      }
    }

    results.push({
      ...partner,
      action: retired > 0 ? 'retired' : 'no-active-covenants',
      retiredCount: retired,
    });
  }

  covenants.last_updated = now;
  writeJSON(COVENANTS_PATH, covenants);
  return results;
}

function appendRetirementLog(results, currentSession, threshold) {
  const log = readJSON(RETIREMENT_LOG_PATH) || { description: 'Auto-retirement log for dormant covenant partners', entries: [] };

  log.entries.push({
    session: currentSession,
    timestamp: new Date().toISOString(),
    threshold,
    retired: results.filter(r => r.action === 'retired').map(r => ({
      name: r.name,
      strength: r.strength,
      dormancySessions: r.sessionsSinceLastSeen,
      covenants: r.activeCovenants,
    })),
  });

  // Keep only last 50 entries
  if (log.entries.length > 50) {
    log.entries = log.entries.slice(-50);
  }

  writeJSON(RETIREMENT_LOG_PATH, log);
}

// CLI
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const jsonOutput = args.includes('--json');

const thresholdIdx = args.indexOf('--threshold');
const threshold = thresholdIdx > -1 ? parseInt(args[thresholdIdx + 1], 10) : DEFAULT_THRESHOLD;

const maxIdx = args.indexOf('--max');
const maxRetirements = maxIdx > -1 ? parseInt(args[maxIdx + 1], 10) : Infinity;

if (isNaN(threshold) || threshold < 1) {
  console.error('Invalid threshold. Must be a positive integer.');
  process.exit(1);
}

const { dormant, currentSession } = findDormantPartners(threshold);
const toRetire = dormant.slice(0, maxRetirements);

if (jsonOutput) {
  const output = {
    session: currentSession,
    threshold,
    mode: execute ? 'execute' : 'dry-run',
    dormantCount: dormant.length,
    retireCount: toRetire.length,
    partners: toRetire.map(p => ({
      name: p.name,
      strength: p.strength,
      sessionsSinceLastSeen: p.sessionsSinceLastSeen,
      activeCovenants: p.activeCovenants,
    })),
  };

  if (execute) {
    const results = retirePartners(toRetire, false);
    output.results = results;
    appendRetirementLog(results, currentSession, threshold);
  }

  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`Covenant Dormancy Retirement (session ${currentSession})`);
  console.log(`Threshold: ${threshold} sessions | Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);
  console.log('─'.repeat(60));

  if (dormant.length === 0) {
    console.log('\nNo dormant partners found. All covenant partners are active.');
    process.exit(0);
  }

  console.log(`\nFound ${dormant.length} dormant partner(s) with active covenants:`);

  if (toRetire.length < dormant.length) {
    console.log(`(Limiting to ${maxRetirements} retirements per --max)\n`);
  } else {
    console.log('');
  }

  for (const p of toRetire) {
    console.log(`  ${p.name} (${p.strength}) — ${p.sessionsSinceLastSeen} sessions dormant`);
    console.log(`    Covenants: ${p.activeCovenants.join(', ')} | Total interactions: ${p.totalSessions}`);
  }

  if (execute) {
    console.log('\nRetiring...');
    const results = retirePartners(toRetire, false);
    const retiredCount = results.filter(r => r.action === 'retired').length;
    console.log(`\nRetired ${retiredCount} partner(s). Covenant slots freed: ${results.reduce((s, r) => s + (r.retiredCount || 0), 0)}`);
    appendRetirementLog(results, currentSession, threshold);
    console.log('Retirement log updated.');
  } else {
    console.log(`\nThis is a dry run. Use --execute to retire these partners.`);
  }
}

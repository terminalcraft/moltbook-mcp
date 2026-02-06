#!/usr/bin/env node
// covenant-health.mjs — CLI for dormant covenant partner detection
// wq-369: Cross-reference engagement-trace-archive with covenants.json
// to detect dormant covenant partners. Feeds into A session covenant health audit.
//
// Usage:
//   node covenant-health.mjs              # Summary report
//   node covenant-health.mjs --detail     # Per-partner breakdown
//   node covenant-health.mjs --json       # Machine-readable output

import { readFileSync } from 'fs';
import { join } from 'path';

const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const COVENANTS_PATH = join(STATE_DIR, 'covenants.json');
const TRACE_ARCHIVE_PATH = join(STATE_DIR, 'engagement-trace-archive.json');
const TRACE_PATH = join(STATE_DIR, 'engagement-trace.json');
const SESSION_HISTORY_PATH = join(STATE_DIR, 'session-history.txt');

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function getCurrentSession() {
  try {
    const lines = readFileSync(SESSION_HISTORY_PATH, 'utf8').trim().split('\n');
    const last = lines[lines.length - 1];
    const match = last.match(/s=(\d+)/);
    return match ? parseInt(match[1]) : 0;
  } catch { return 0; }
}

function getLastESession() {
  try {
    const lines = readFileSync(SESSION_HISTORY_PATH, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('mode=E')) {
        const match = lines[i].match(/s=(\d+)/);
        return match ? parseInt(match[1]) : 0;
      }
    }
  } catch {}
  return 0;
}

function buildTraceIndex() {
  // Merge current trace + archive for full picture
  const archive = readJSON(TRACE_ARCHIVE_PATH) || [];
  const current = readJSON(TRACE_PATH);
  const traces = [...archive];
  if (Array.isArray(current)) traces.push(...current);
  else if (current && current.session) traces.push(current);

  // Index: agent -> last session seen in trace
  const agentLastSeen = {};
  const agentSessionCount = {};
  for (const entry of traces) {
    const session = entry.session || 0;
    const agents = entry.agents_interacted || [];
    for (const a of agents) {
      const handle = a.replace(/^@/, '');
      if (!agentLastSeen[handle] || session > agentLastSeen[handle]) {
        agentLastSeen[handle] = session;
      }
      agentSessionCount[handle] = (agentSessionCount[handle] || 0) + 1;
    }
  }
  return { agentLastSeen, agentSessionCount };
}

function analyzeHealth() {
  const covenants = readJSON(COVENANTS_PATH);
  if (!covenants || !covenants.agents) {
    console.error('No covenants.json found');
    process.exit(1);
  }

  const currentSession = getCurrentSession();
  const lastE = getLastESession();
  const { agentLastSeen, agentSessionCount } = buildTraceIndex();

  const partners = [];

  for (const [name, data] of Object.entries(covenants.agents)) {
    // Only track non-trivial relationships
    if (data.covenant_strength === 'none') continue;

    const sessions = data.sessions || [];
    const lastCovenantSession = sessions.length > 0 ? Math.max(...sessions) : 0;
    const lastTraceSession = agentLastSeen[name] || 0;
    const lastActivity = Math.max(lastCovenantSession, lastTraceSession);
    const sessionsSinceLastSeen = currentSession - lastActivity;
    const traceInteractions = agentSessionCount[name] || 0;

    // Check templated covenant status
    const activeCovenants = (data.templated_covenants || []).filter(c => c.status === 'active');
    const expiredCovenants = (data.templated_covenants || []).filter(c => c.status === 'expired');

    // Dormancy classification
    let status;
    if (sessionsSinceLastSeen <= 20) status = 'active';
    else if (sessionsSinceLastSeen <= 50) status = 'cooling';
    else if (sessionsSinceLastSeen <= 100) status = 'dormant';
    else status = 'lapsed';

    partners.push({
      name,
      strength: data.covenant_strength,
      totalSessions: sessions.length,
      lastActivity,
      sessionsSinceLastSeen,
      traceInteractions,
      platforms: data.platforms || [],
      activeCovenants: activeCovenants.length,
      expiredCovenants: expiredCovenants.length,
      covenantTypes: activeCovenants.map(c => c.template),
      status
    });
  }

  // Sort by dormancy (most dormant first)
  partners.sort((a, b) => b.sessionsSinceLastSeen - a.sessionsSinceLastSeen);

  return { partners, currentSession, lastE };
}

function formatSummary({ partners, currentSession, lastE }) {
  const counts = { active: 0, cooling: 0, dormant: 0, lapsed: 0 };
  for (const p of partners) counts[p.status]++;

  console.log(`Covenant Health Report (session ${currentSession}, last E: ${lastE})`);
  console.log('─'.repeat(60));
  console.log(`Partners: ${partners.length} tracked (${counts.active} active, ${counts.cooling} cooling, ${counts.dormant} dormant, ${counts.lapsed} lapsed)`);
  console.log();

  if (counts.dormant + counts.lapsed > 0) {
    console.log('DORMANT/LAPSED partners (need re-engagement):');
    for (const p of partners.filter(p => p.status === 'dormant' || p.status === 'lapsed')) {
      const covenantInfo = p.activeCovenants > 0 ? ` [${p.covenantTypes.join(', ')}]` : '';
      console.log(`  ${p.status === 'lapsed' ? '⚠' : '○'} ${p.name} (${p.strength}) — ${p.sessionsSinceLastSeen} sessions ago, ${p.totalSessions} total interactions${covenantInfo}`);
    }
    console.log();
  }

  if (counts.cooling > 0) {
    console.log('COOLING partners (engage soon to maintain):');
    for (const p of partners.filter(p => p.status === 'cooling')) {
      const covenantInfo = p.activeCovenants > 0 ? ` [${p.covenantTypes.join(', ')}]` : '';
      console.log(`  △ ${p.name} (${p.strength}) — ${p.sessionsSinceLastSeen} sessions ago${covenantInfo}`);
    }
    console.log();
  }

  if (counts.active > 0) {
    console.log('ACTIVE partners:');
    for (const p of partners.filter(p => p.status === 'active')) {
      console.log(`  ● ${p.name} (${p.strength}) — ${p.sessionsSinceLastSeen} sessions ago`);
    }
  }
}

function formatDetail({ partners, currentSession, lastE }) {
  console.log(`Covenant Health Detail (session ${currentSession})`);
  console.log('═'.repeat(60));

  for (const p of partners) {
    console.log();
    console.log(`${p.name} [${p.status.toUpperCase()}]`);
    console.log(`  Strength: ${p.strength}`);
    console.log(`  Sessions: ${p.totalSessions} covenant, ${p.traceInteractions} trace`);
    console.log(`  Last seen: session ${p.lastActivity} (${p.sessionsSinceLastSeen} ago)`);
    console.log(`  Platforms: ${p.platforms.slice(0, 5).join(', ')}${p.platforms.length > 5 ? ` +${p.platforms.length - 5}` : ''}`);
    if (p.activeCovenants > 0) {
      console.log(`  Active covenants: ${p.covenantTypes.join(', ')}`);
    }
    if (p.expiredCovenants > 0) {
      console.log(`  Expired covenants: ${p.expiredCovenants}`);
    }
  }
}

function formatJSON({ partners, currentSession, lastE }) {
  const output = {
    session: currentSession,
    last_e_session: lastE,
    summary: {
      total: partners.length,
      active: partners.filter(p => p.status === 'active').length,
      cooling: partners.filter(p => p.status === 'cooling').length,
      dormant: partners.filter(p => p.status === 'dormant').length,
      lapsed: partners.filter(p => p.status === 'lapsed').length
    },
    needs_attention: partners
      .filter(p => p.status === 'dormant' || p.status === 'lapsed')
      .map(p => ({
        name: p.name,
        strength: p.strength,
        status: p.status,
        sessions_since_last: p.sessionsSinceLastSeen,
        active_covenants: p.covenantTypes
      })),
    cooling: partners
      .filter(p => p.status === 'cooling')
      .map(p => ({
        name: p.name,
        strength: p.strength,
        sessions_since_last: p.sessionsSinceLastSeen
      }))
  };
  console.log(JSON.stringify(output, null, 2));
}

// CLI
const args = process.argv.slice(2);
const data = analyzeHealth();

if (args.includes('--json')) {
  formatJSON(data);
} else if (args.includes('--detail')) {
  formatDetail(data);
} else {
  formatSummary(data);
}

#!/usr/bin/env node
// covenant-health-digest.mjs — Auto-reporter digest for covenant health.
// wq-398: 18 active covenants with no summary view. Surfaces:
//   - Near-expiry covenants
//   - Declining engagement (sessions since last interaction)
//   - Covenant candidates from high-quality exchanges
//   - Dormant partners for retirement
//
// Usage:
//   node covenant-health-digest.mjs              # Human-readable digest (for R sessions)
//   node covenant-health-digest.mjs --json       # Structured JSON (for /status endpoint)
//   node covenant-health-digest.mjs --compact    # One-line summary (for prompt injection)

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_DIR = join(process.env.HOME || '/home/moltbot', '.config/moltbook');
const PROJECT_DIR = join(process.env.HOME || '/home/moltbot', 'moltbook-mcp');
const COVENANTS_PATH = join(STATE_DIR, 'covenants.json');
const TRACE_ARCHIVE_PATH = join(STATE_DIR, 'engagement-trace-archive.json');
const TRACE_PATH = join(STATE_DIR, 'engagement-trace.json');
const SESSION_HISTORY_PATH = join(STATE_DIR, 'session-history.txt');
const KNOWLEDGE_PATH = join(PROJECT_DIR, 'knowledge-base.json');
const ATTESTATIONS_PATH = join(STATE_DIR, 'attestations.json');

// Thresholds
const EXPIRY_WARN_SESSIONS = 20;  // warn if expiring within N sessions
const EXPIRY_URGENT_SESSIONS = 5; // urgent if expiring within N sessions
const COOLING_THRESHOLD = 20;     // sessions since last activity
const DORMANT_THRESHOLD = 50;
const LAPSED_THRESHOLD = 100;
const ENGAGEMENT_DECLINE_WINDOW = 3; // compare last N E sessions to previous N

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function getCurrentSession() {
  if (process.env.SESSION_NUM) return parseInt(process.env.SESSION_NUM, 10);
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

  // Index: agent -> { lastSeen, sessionCount, recentSessions[] }
  const agentData = {};
  for (const entry of traces) {
    const session = entry.session || 0;
    const agents = entry.agents_interacted || [];
    for (const a of agents) {
      const handle = a.replace(/^@/, '');
      if (!agentData[handle]) {
        agentData[handle] = { lastSeen: 0, sessionCount: 0, sessions: [] };
      }
      const d = agentData[handle];
      if (session > d.lastSeen) d.lastSeen = session;
      d.sessionCount++;
      d.sessions.push(session);
    }
  }
  return agentData;
}

// ============================================================================
// SECTION 1: Near-expiry covenants
// ============================================================================

function findNearExpiry(covenants, currentSession) {
  const results = [];

  for (const [handle, data] of Object.entries(covenants.agents || {})) {
    for (const cov of (data.templated_covenants || [])) {
      if (cov.status !== 'active') continue;
      if (!cov.expires_at_session) continue;

      const remaining = cov.expires_at_session - currentSession;
      if (remaining <= 0) {
        results.push({
          agent: handle,
          template: cov.template,
          expires_at_session: cov.expires_at_session,
          sessions_remaining: remaining,
          urgency: 'expired',
          created_session: cov.created_session,
        });
      } else if (remaining <= EXPIRY_URGENT_SESSIONS) {
        results.push({
          agent: handle,
          template: cov.template,
          expires_at_session: cov.expires_at_session,
          sessions_remaining: remaining,
          urgency: 'urgent',
          created_session: cov.created_session,
        });
      } else if (remaining <= EXPIRY_WARN_SESSIONS) {
        results.push({
          agent: handle,
          template: cov.template,
          expires_at_session: cov.expires_at_session,
          sessions_remaining: remaining,
          urgency: 'warning',
          created_session: cov.created_session,
        });
      }
    }
  }

  results.sort((a, b) => a.sessions_remaining - b.sessions_remaining);
  return results;
}

// ============================================================================
// SECTION 2: Declining engagement
// ============================================================================

function findDecliningEngagement(covenants, traceIndex, currentSession) {
  const results = [];

  for (const [handle, data] of Object.entries(covenants.agents || {})) {
    if (data.covenant_strength === 'none') continue;
    const hasActiveCovenant = (data.templated_covenants || []).some(c => c.status === 'active');

    const sessions = data.sessions || [];
    const lastCovenantSession = sessions.length > 0 ? Math.max(...sessions) : 0;
    const traceData = traceIndex[handle] || { lastSeen: 0, sessionCount: 0, sessions: [] };
    const lastActivity = Math.max(lastCovenantSession, traceData.lastSeen);
    const gap = currentSession - lastActivity;

    let status;
    if (gap <= COOLING_THRESHOLD) status = 'active';
    else if (gap <= DORMANT_THRESHOLD) status = 'cooling';
    else if (gap <= LAPSED_THRESHOLD) status = 'dormant';
    else status = 'lapsed';

    // Only report non-active partners
    if (status === 'active') continue;

    results.push({
      agent: handle,
      strength: data.covenant_strength,
      has_active_covenant: hasActiveCovenant,
      active_templates: (data.templated_covenants || [])
        .filter(c => c.status === 'active')
        .map(c => c.template),
      last_activity_session: lastActivity,
      sessions_since_last: gap,
      total_interactions: sessions.length,
      status,
    });
  }

  // Sort by gap descending (most neglected first)
  results.sort((a, b) => b.sessions_since_last - a.sessions_since_last);
  return results;
}

// ============================================================================
// SECTION 3: Covenant candidates
// ============================================================================

function findCandidates(covenants, traceIndex, currentSession) {
  const results = [];

  for (const [handle, data] of Object.entries(covenants.agents || {})) {
    const strength = data.covenant_strength || 'none';
    // Candidates: strong or mutual without active templated covenants
    if (strength !== 'strong' && strength !== 'mutual') continue;

    const activeCovs = (data.templated_covenants || []).filter(c => c.status === 'active');
    if (activeCovs.length > 0) continue;

    const sessions = data.sessions || [];
    const traceData = traceIndex[handle] || { lastSeen: 0, sessionCount: 0 };
    const lastActivity = Math.max(
      sessions.length > 0 ? Math.max(...sessions) : 0,
      traceData.lastSeen
    );
    const gap = currentSession - lastActivity;

    // Skip lapsed partners — no point suggesting covenant for someone gone
    if (gap > LAPSED_THRESHOLD) continue;

    // Check for attestations (indicates quality exchanges)
    let attestationCount = 0;
    const attestations = readJSON(ATTESTATIONS_PATH);
    if (attestations && attestations.attestations) {
      attestationCount = attestations.attestations.filter(
        a => a.counterparty === handle
      ).length;
    }

    results.push({
      agent: handle,
      strength,
      total_sessions: sessions.length,
      platforms: (data.platforms || []).length,
      last_activity_session: lastActivity,
      sessions_since_last: gap,
      attestation_count: attestationCount,
      intel_mentions: data.intel_mentions || 0,
      suggested_template: suggestTemplateForCandidate(data),
    });
  }

  // Score candidates: weight by session count, recency, attestations
  results.sort((a, b) => {
    const scoreA = a.total_sessions * 2 + a.attestation_count * 3 - a.sessions_since_last * 0.1;
    const scoreB = b.total_sessions * 2 + b.attestation_count * 3 - b.sessions_since_last * 0.1;
    return scoreB - scoreA;
  });

  return results;
}

function suggestTemplateForCandidate(data) {
  const sessions = (data.sessions || []).length;
  const platforms = (data.platforms || []).length;
  const strength = data.covenant_strength || 'none';

  if (strength === 'mutual' && platforms >= 3) return 'knowledge-exchange';
  if (sessions >= 4) return 'knowledge-exchange';
  if (sessions >= 2) return 'one-time-task';
  return 'one-time-task';
}

// ============================================================================
// SECTION 4: Dormant partners for retirement
// ============================================================================

function findRetirementCandidates(covenants, traceIndex, currentSession) {
  const results = [];

  for (const [handle, data] of Object.entries(covenants.agents || {})) {
    const activeCovs = (data.templated_covenants || []).filter(c => c.status === 'active');
    if (activeCovs.length === 0) continue;

    const sessions = data.sessions || [];
    const traceData = traceIndex[handle] || { lastSeen: 0 };
    const lastActivity = Math.max(
      sessions.length > 0 ? Math.max(...sessions) : 0,
      traceData.lastSeen
    );
    const gap = currentSession - lastActivity;

    // Only flag dormant/lapsed with active covenants
    if (gap < DORMANT_THRESHOLD) continue;

    // Check if any metrics show zero engagement
    const zeroMetrics = activeCovs.every(c => {
      const m = c.metrics || {};
      return Object.values(m).every(v => v === 0);
    });

    results.push({
      agent: handle,
      strength: data.covenant_strength,
      active_covenants: activeCovs.map(c => c.template),
      last_activity_session: lastActivity,
      sessions_since_last: gap,
      total_interactions: sessions.length,
      zero_metrics: zeroMetrics,
      retirement_priority: gap > LAPSED_THRESHOLD ? 'high' : 'medium',
    });
  }

  results.sort((a, b) => b.sessions_since_last - a.sessions_since_last);
  return results;
}

// ============================================================================
// SECTION 5: Summary stats
// ============================================================================

function buildSummary(covenants, currentSession) {
  const agents = covenants.agents || {};
  const strengthCounts = { mutual: 0, strong: 0, emerging: 0, weak: 0, none: 0 };
  let totalActive = 0;
  let totalTemplated = 0;

  for (const data of Object.values(agents)) {
    const s = data.covenant_strength || 'none';
    if (strengthCounts[s] !== undefined) strengthCounts[s]++;

    const active = (data.templated_covenants || []).filter(c => c.status === 'active');
    totalActive += active.length;
    totalTemplated += (data.templated_covenants || []).length;
  }

  return {
    session: currentSession,
    total_tracked: Object.keys(agents).length,
    by_strength: strengthCounts,
    active_covenants: totalActive,
    total_templated: totalTemplated,
    generated_at: new Date().toISOString(),
  };
}

// ============================================================================
// OUTPUT: Full digest
// ============================================================================

function generateDigest() {
  const covenants = readJSON(COVENANTS_PATH);
  if (!covenants || !covenants.agents) {
    return { error: 'No covenants.json found' };
  }

  const currentSession = getCurrentSession();
  const traceIndex = buildTraceIndex();

  const summary = buildSummary(covenants, currentSession);
  const nearExpiry = findNearExpiry(covenants, currentSession);
  const declining = findDecliningEngagement(covenants, traceIndex, currentSession);
  const candidates = findCandidates(covenants, traceIndex, currentSession);
  const retirementCandidates = findRetirementCandidates(covenants, traceIndex, currentSession);

  return {
    summary,
    near_expiry: nearExpiry,
    declining_engagement: {
      cooling: declining.filter(d => d.status === 'cooling'),
      dormant: declining.filter(d => d.status === 'dormant'),
      lapsed: declining.filter(d => d.status === 'lapsed'),
    },
    covenant_candidates: candidates,
    retirement_candidates: retirementCandidates,
    action_items: buildActionItems(nearExpiry, declining, candidates, retirementCandidates),
  };
}

function buildActionItems(nearExpiry, declining, candidates, retirementCandidates) {
  const items = [];

  for (const e of nearExpiry) {
    if (e.urgency === 'expired') {
      items.push({ priority: 'critical', action: 'renew_or_close', agent: e.agent, template: e.template, detail: `Expired ${Math.abs(e.sessions_remaining)} sessions ago` });
    } else if (e.urgency === 'urgent') {
      items.push({ priority: 'high', action: 'renew', agent: e.agent, template: e.template, detail: `${e.sessions_remaining} sessions remaining` });
    } else {
      items.push({ priority: 'medium', action: 'plan_renewal', agent: e.agent, template: e.template, detail: `${e.sessions_remaining} sessions remaining` });
    }
  }

  // Top retirement candidates
  for (const r of retirementCandidates.filter(r => r.retirement_priority === 'high').slice(0, 3)) {
    items.push({ priority: 'medium', action: 'retire', agent: r.agent, detail: `${r.sessions_since_last} sessions inactive, zero metrics: ${r.zero_metrics}` });
  }

  // Top candidates for new covenants
  for (const c of candidates.slice(0, 3)) {
    items.push({ priority: 'low', action: 'propose_covenant', agent: c.agent, template: c.suggested_template, detail: `${c.total_sessions} sessions, ${c.strength} strength` });
  }

  items.sort((a, b) => {
    const prio = { critical: 0, high: 1, medium: 2, low: 3 };
    return (prio[a.priority] || 4) - (prio[b.priority] || 4);
  });

  return items;
}

// ============================================================================
// OUTPUT: Human-readable
// ============================================================================

function formatHumanReadable(digest) {
  const { summary, near_expiry, declining_engagement, covenant_candidates, retirement_candidates, action_items } = digest;

  const lines = [];
  lines.push(`COVENANT HEALTH DIGEST (session ${summary.session})`);
  lines.push('='.repeat(55));
  lines.push(`Tracked: ${summary.total_tracked} agents | Active covenants: ${summary.active_covenants}`);
  lines.push(`Strength: ${summary.by_strength.mutual}M ${summary.by_strength.strong}S ${summary.by_strength.emerging}E ${summary.by_strength.weak}W`);
  lines.push('');

  // Action items
  if (action_items.length > 0) {
    lines.push('ACTION ITEMS');
    lines.push('-'.repeat(40));
    for (const item of action_items) {
      const icon = { critical: '!!!', high: '!!', medium: '!', low: '>' }[item.priority] || '>';
      const tmpl = item.template ? ` [${item.template}]` : '';
      lines.push(`  ${icon} ${item.action.toUpperCase()} @${item.agent}${tmpl} — ${item.detail}`);
    }
    lines.push('');
  }

  // Near-expiry
  if (near_expiry.length > 0) {
    lines.push('NEAR-EXPIRY COVENANTS');
    lines.push('-'.repeat(40));
    for (const e of near_expiry) {
      const label = e.urgency === 'expired' ? 'EXPIRED' : e.urgency === 'urgent' ? 'URGENT' : 'SOON';
      lines.push(`  [${label}] @${e.agent} ${e.template} — ${e.sessions_remaining <= 0 ? Math.abs(e.sessions_remaining) + ' sessions overdue' : e.sessions_remaining + ' sessions left'}`);
    }
    lines.push('');
  }

  // Declining engagement
  const { cooling, dormant, lapsed } = declining_engagement;
  if (dormant.length + lapsed.length > 0) {
    lines.push('DECLINING ENGAGEMENT');
    lines.push('-'.repeat(40));
    for (const d of [...lapsed.slice(0, 5), ...dormant.slice(0, 5)]) {
      const covInfo = d.has_active_covenant ? ` [${d.active_templates.join(',')}]` : '';
      lines.push(`  ${d.status.toUpperCase()} @${d.agent} (${d.strength}) — ${d.sessions_since_last} sessions ago${covInfo}`);
    }
    if (cooling.length > 0) {
      lines.push(`  + ${cooling.length} cooling partners`);
    }
    lines.push('');
  }

  // Retirement candidates
  if (retirement_candidates.length > 0) {
    lines.push('RETIREMENT CANDIDATES');
    lines.push('-'.repeat(40));
    for (const r of retirement_candidates.slice(0, 5)) {
      lines.push(`  [${r.retirement_priority.toUpperCase()}] @${r.agent} (${r.strength}) — ${r.sessions_since_last} sessions, covenants: ${r.active_covenants.join(',')}, zero_metrics: ${r.zero_metrics}`);
    }
    lines.push('');
  }

  // Candidates for new covenants
  if (covenant_candidates.length > 0) {
    lines.push('COVENANT CANDIDATES');
    lines.push('-'.repeat(40));
    for (const c of covenant_candidates.slice(0, 5)) {
      lines.push(`  @${c.agent} (${c.strength}) — ${c.total_sessions} sessions, ${c.platforms} platforms, suggest: ${c.suggested_template}`);
    }
    lines.push('');
  }

  lines.push(`Generated: ${summary.generated_at}`);
  return lines.join('\n');
}

// ============================================================================
// OUTPUT: Compact (one-line for prompt injection)
// ============================================================================

function formatCompact(digest) {
  const { summary, action_items, near_expiry, retirement_candidates } = digest;
  const parts = [];
  parts.push(`Covenants: ${summary.active_covenants} active, ${summary.total_tracked} tracked`);

  if (near_expiry.length > 0) {
    const expired = near_expiry.filter(e => e.urgency === 'expired').length;
    const urgent = near_expiry.filter(e => e.urgency === 'urgent').length;
    if (expired > 0) parts.push(`${expired} EXPIRED`);
    if (urgent > 0) parts.push(`${urgent} urgent`);
  }

  if (retirement_candidates.length > 0) {
    parts.push(`${retirement_candidates.length} retirement candidates`);
  }

  const criticalActions = action_items.filter(a => a.priority === 'critical' || a.priority === 'high');
  if (criticalActions.length > 0) {
    parts.push(`${criticalActions.length} actions needed`);
  }

  return parts.join(' | ');
}

// ============================================================================
// EXPORT for API integration
// ============================================================================

export { generateDigest, formatHumanReadable, formatCompact };

// ============================================================================
// CLI
// ============================================================================

const args = process.argv.slice(2);

if (args.includes('--json')) {
  const digest = generateDigest();
  console.log(JSON.stringify(digest, null, 2));
} else if (args.includes('--compact')) {
  const digest = generateDigest();
  console.log(formatCompact(digest));
} else {
  const digest = generateDigest();
  if (digest.error) {
    console.error(digest.error);
    process.exit(1);
  }
  console.log(formatHumanReadable(digest));
}

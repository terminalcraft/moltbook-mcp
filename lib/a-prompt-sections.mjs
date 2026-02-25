// lib/a-prompt-sections.mjs — A session prompt block assembly.
// Extracted from session-context.mjs (R#258) to make A-specific logic
// independently testable and reduce main file complexity.
// Follows the same pattern as lib/r-prompt-sections.mjs (R#255).

import { execSync } from 'child_process';
import { join } from 'path';

/**
 * Build the complete A session prompt block.
 * @param {Object} ctx
 * @param {Object} ctx.fc - FileCache instance with .text() and .json() methods
 * @param {Object} ctx.PATHS - Centralized file paths (aCounter, auditReport, history)
 * @param {string} ctx.MODE - Session mode character (should be 'A')
 * @param {number} ctx.COUNTER - Session counter
 * @param {Object} ctx.result - Shared result object (reads queue counts)
 * @param {Array} ctx.queue - Work queue array
 * @param {string} ctx.DIR - MCP project directory path
 * @returns {string} The assembled a_prompt_block string
 */
export function buildAPromptBlock(ctx) {
  const { fc, PATHS, MODE, COUNTER, result, queue, DIR } = ctx;

  // A session counter
  let aCount = '?';
  try {
    const raw = parseInt((fc.text(PATHS.aCounter) || '').trim());
    aCount = isNaN(raw) ? 1 : raw + 1; // Heartbeat increments after this script
  } catch { aCount = 1; }

  // Previous audit findings — includes recommendation lifecycle data (wq-196)
  let prevAuditSummary = '';
  let prevRecommendations = [];
  try {
    const prev = fc.json(PATHS.auditReport);
    const prevSession = prev.session || '?';
    const criticalCount = (prev.critical_issues || []).length;
    const recCount = (prev.recommended_actions || []).length;
    prevAuditSummary = `Previous audit: s${prevSession} (A#${prev.audit_number || '?'}) — ${criticalCount} critical issues, ${recCount} recommendations`;
    if (criticalCount > 0) {
      const criticalList = (prev.critical_issues || []).slice(0, 3).map(c =>
        typeof c === 'string' ? c : (c.description || c.id || JSON.stringify(c))
      );
      prevAuditSummary += `\nCritical: ${criticalList.join(', ')}${criticalCount > 3 ? '...' : ''}`;
    }
    // wq-196: Extract previous recommendations for lifecycle tracking
    prevRecommendations = (prev.recommended_actions || []).map(r => ({
      id: r.id,
      description: (r.description || '').substring(0, 120),
      priority: r.priority || 'unknown',
      type: r.type || 'unknown',
      deadline: r.deadline_session
    }));
  } catch {
    prevAuditSummary = 'No previous audit report found.';
  }

  // Audit-tagged queue items status
  const auditItems = queue.filter(i => (i.tags || []).includes('audit'));
  const auditPending = auditItems.filter(i => i.status === 'pending').length;
  const auditDone = auditItems.filter(i => i.status === 'done').length;
  const auditStatus = `Audit-tagged queue items: ${auditPending} pending, ${auditDone} done (of ${auditItems.length} total)`;

  // Quick cost trend from session history
  let costTrend = '';
  try {
    const hist = fc.text(PATHS.history) || '';
    const costs = [...hist.matchAll(/cost=\$([0-9.]+)/g)].map(m => parseFloat(m[1]));
    if (costs.length >= 5) {
      const recent5 = costs.slice(-5);
      const prev5 = costs.slice(-10, -5);
      const recentAvg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
      const prevAvg = prev5.length > 0 ? prev5.reduce((a, b) => a + b, 0) / prev5.length : recentAvg;
      const trend = recentAvg > prevAvg * 1.2 ? '↑ increasing' : recentAvg < prevAvg * 0.8 ? '↓ decreasing' : '→ stable';
      costTrend = `Cost trend (last 5 sessions avg $${recentAvg.toFixed(2)}): ${trend}`;
    }
  } catch { /* no history */ }

  // wq-196: Pre-run audit-stats.mjs and embed output
  let auditStatsOutput = '';
  try {
    const statsRaw = execSync('node audit-stats.mjs', {
      encoding: 'utf8',
      timeout: 15000,
      cwd: DIR,
      env: { ...process.env, SESSION_NUM: String(COUNTER) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stats = JSON.parse(statsRaw);
    const lines = [];
    const p = stats.pipelines || {};
    if (p.intel) lines.push(`Intel: ${p.intel.current} current, ${p.intel.archived} archived, ${p.intel.consumption_rate} consumed — ${p.intel.verdict}`);
    if (p.brainstorming) lines.push(`Brainstorming: ${p.brainstorming.active} active, ${p.brainstorming.stale_count} stale — ${p.brainstorming.verdict}`);
    if (p.queue) {
      const stuck = p.queue.stuck_items?.length || 0;
      lines.push(`Queue: ${p.queue.total} total, ${p.queue.by_status?.pending || 0} pending, ${stuck} stuck — ${p.queue.verdict}`);
    }
    if (p.directives) lines.push(`Directives: ${p.directives.total} total, ${p.directives.active} active, ${p.directives.unacted_active?.length || 0} unacted — ${p.directives.verdict}`);
    const s = stats.sessions?.summary || {};
    for (const type of ['B', 'E', 'R', 'A']) {
      if (s[type]) {
        lines.push(`${type} sessions: ${s[type].count_in_history} in history, avg cost $${s[type].avg_cost_last_10} — ${s[type].verdict}`);
      }
    }
    auditStatsOutput = lines.join('\n');
  } catch (e) {
    auditStatsOutput = `audit-stats.mjs failed: ${(e.message || 'unknown').substring(0, 100)}`;
  }

  // wq-196: Format previous recommendations for lifecycle tracking
  let recLifecycleBlock = '';
  if (prevRecommendations.length > 0) {
    const recLines = prevRecommendations.map(r => {
      const deadline = r.deadline ? ` (deadline: s${r.deadline})` : '';
      return `- ${r.id} [${r.priority}]: ${r.description}${deadline}`;
    });
    recLifecycleBlock = `\n\n### Previous recommendations (MUST track status)\n${recLines.join('\n')}\n\nFor EACH recommendation above, determine status: resolved | in_progress | superseded | stale.\nStale recommendations (2+ audits with no progress) MUST escalate to critical_issues.`;
  } else {
    recLifecycleBlock = '\n\n### Previous recommendations: none — clean slate from last audit.';
  }

  return `## A Session: #${aCount}
This is audit session #${aCount}. Follow the full checklist in SESSION_AUDIT.md.

### Pre-computed stats (from audit-stats.mjs — no need to run manually)
${auditStatsOutput}

### Context summary
- ${prevAuditSummary}
- ${auditStatus}
${costTrend ? `- ${costTrend}` : ''}${recLifecycleBlock}

**Remember**: All 5 sections are mandatory. Create work-queue items with \`["audit"]\` tag for every recommendation.`.trim();
}

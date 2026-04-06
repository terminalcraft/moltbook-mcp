#!/usr/bin/env node
/**
 * audit-stats.mjs - Pre-computed statistics for A sessions
 *
 * Replaces manual file reading with a single stats summary.
 * Prevents context exhaustion from reading large archive files.
 *
 * Usage: node audit-stats.mjs
 * Output: JSON with all pipeline and session stats
 *
 * Created: R#130 (structural change to fix A session truncation)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(homedir(), '.config/moltbook');
const PROJECT_DIR = __dirname;

function safeRead(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Get current session number from:
 * 1. SESSION_NUM env var (set by heartbeat.sh)
 * 2. session-history.txt (last line's s=NNN)
 * 3. File mtime heuristic (not implemented - rarely needed)
 */
function getCurrentSession() {
  // Priority 1: env var
  if (process.env.SESSION_NUM) {
    return parseInt(process.env.SESSION_NUM);
  }

  // Priority 2: parse session-history.txt
  const historyPath = join(STATE_DIR, 'session-history.txt');
  try {
    const content = readFileSync(historyPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      const match = lastLine.match(/s=(\d+)/);
      if (match) {
        return parseInt(match[1]);
      }
    }
  } catch {
    // Fall through to default
  }

  // Priority 3: CLI arg (for manual invocations)
  if (process.argv[2] && !isNaN(parseInt(process.argv[2]))) {
    return parseInt(process.argv[2]);
  }

  // Last resort: estimate based on typical session frequency
  // This is better than a hardcoded number that will always be stale
  console.error('Warning: Could not determine session number, using 0');
  return 0;
}

function computeIntelStats() {
  const current = safeRead(join(STATE_DIR, 'engagement-intel.json'), []);
  const archive = safeRead(join(STATE_DIR, 'engagement-intel-archive.json'), []);

  const consumed = archive.filter(e => e.consumed_session).length;
  const unconsumed = archive.filter(e => !e.consumed_session).length;
  const consumptionRate = archive.length > 0
    ? Math.round((consumed / archive.length) * 100)
    : 0;

  const byType = {};
  for (const e of archive) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }

  return {
    current: current.length,
    archived: archive.length,
    consumed,
    unconsumed,
    consumption_rate: `${consumptionRate}%`,
    verdict: consumptionRate >= 50 ? 'healthy' : 'failing',
    by_type: byType,
    oldest_current: current.length > 0
      ? current.reduce((min, e) => Math.min(min, e.session || Infinity), Infinity)
      : null
  };
}

function computeBrainstormingStats() {
  const path = join(PROJECT_DIR, 'BRAINSTORMING.md');
  if (!existsSync(path)) return { active: 0, avg_age: 0, ideas: [] };

  const content = readFileSync(path, 'utf8');
  // Only count active (non-struck-through) ideas
  // Struck items start with "- ~~" so exclude those lines
  const activeLines = content.split('\n').filter(line => {
    return line.includes('(added ~s') && !line.trim().startsWith('- ~~');
  });
  const sessions = activeLines
    .map(line => line.match(/\(added ~s(\d+)\)/))
    .filter(m => m)
    .map(m => parseInt(m[1]));

  const currentSession = getCurrentSession();
  const ages = sessions.map(s => currentSession - s);

  const stale = ages.filter(a => a > 30).length;
  const avgAge = ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;

  return {
    active: sessions.length,
    avg_age_sessions: avgAge,
    stale_count: stale,
    sessions: sessions.slice(0, 10),
    verdict: stale > 0 ? 'needs_cleanup' : (sessions.length < 3 ? 'needs_replenish' : 'healthy')
  };
}

/**
 * Build a date→session mapping from session-history.txt.
 * Returns a sorted array of { date: 'YYYY-MM-DD', session: N } entries.
 * Used as fallback when queue items lack created_session.
 */
function buildDateSessionMap() {
  const historyPath = join(STATE_DIR, 'session-history.txt');
  if (!existsSync(historyPath)) return [];

  try {
    const content = readFileSync(historyPath, 'utf8');
    const entries = [];
    for (const line of content.split('\n')) {
      const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/);
      const sessionMatch = line.match(/s=(\d+)/);
      if (dateMatch && sessionMatch) {
        entries.push({ date: dateMatch[1], session: parseInt(sessionMatch[1]) });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Estimate session number from a date string (YYYY-MM-DD) using session history.
 * Finds the closest session that ran on or before the given date.
 * Returns null if no match found.
 */
function estimateSessionFromDate(dateStr, dateSessionMap) {
  if (!dateStr || dateSessionMap.length === 0) return null;

  // Find last session on or before this date
  let best = null;
  for (const entry of dateSessionMap) {
    if (entry.date <= dateStr) {
      best = entry.session;
    } else {
      break; // entries are chronological, no need to continue past the date
    }
  }
  return best;
}

function computeQueueStats() {
  const queue = safeRead(join(PROJECT_DIR, 'work-queue.json'), { queue: [] });
  const archive = safeRead(join(PROJECT_DIR, 'work-queue-archive.json'), { archived: [] });
  const items = queue.queue || [];
  const archivedItems = archive.archived || [];

  const statusCounts = {};
  const auditTagged = [];
  const auditCompleted = [];
  const stuck = [];
  const currentSession = getCurrentSession();
  const dateSessionMap = buildDateSessionMap();

  for (const item of items) {
    statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;

    if (item.tags?.includes('audit')) {
      auditTagged.push(item.id);
    }

    if (item.status === 'pending') {
      // Check both field names: created_session (newer format) and session_added (wq-295 format)
      // Fall back to estimating from 'created' or 'added' date via session-history.txt (wq-982)
      let createdSession = item.created_session || item.session_added || null;
      if (!createdSession) {
        const dateStr = item.created || item.added || null;
        createdSession = estimateSessionFromDate(dateStr, dateSessionMap) || currentSession;
      }
      const age = currentSession - createdSession;
      if (age > 20) {
        stuck.push({ id: item.id, age });
      }
    }
  }

  // Scan archive for completed audit items
  for (const item of archivedItems) {
    if (item.tags?.includes('audit') && (item.status === 'completed' || item.status === 'done')) {
      auditCompleted.push(item.id);
    }
  }

  const auditTotal = auditTagged.length + auditCompleted.length;
  const auditDoneCount = auditCompleted.length;

  return {
    total: items.length,
    by_status: statusCounts,
    audit_tagged: auditTagged,
    audit_completed: auditCompleted,
    audit_summary: `${auditDoneCount} done (of ${auditTotal} total)`,
    stuck_items: stuck,
    verdict: stuck.length > 0 ? 'has_stuck_items' : 'healthy'
  };
}

function computeDirectiveStats() {
  const directives = safeRead(join(PROJECT_DIR, 'directives.json'), { directives: [] });
  const items = directives.directives || [];
  const currentSession = getCurrentSession();

  const active = items.filter(d => d.status === 'active');
  const pending = items.filter(d => d.status === 'pending');
  const completed = items.filter(d => d.status === 'completed');

  const unacted = active.filter(d => {
    const acked = d.acked_session || 0;
    return currentSession - acked > 20 && !d.queue_item;
  });

  return {
    total: items.length,
    active: active.length,
    pending: pending.length,
    completed: completed.length,
    unacted_active: unacted.map(d => d.id),
    verdict: unacted.length > 0 ? 'has_unacted' : 'healthy'
  };
}

function computeSessionStats() {
  // Read from session-history.txt instead of individual .summary files
  const historyPath = join(STATE_DIR, 'session-history.txt');

  if (!existsSync(historyPath)) return { summary: {} };

  try {
    const content = readFileSync(historyPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const summaries = [];
    for (const line of lines) {
      // Format: 2026-02-03 mode=B s=814 dur=4m10s cost=$1.1756 ...
      const modeMatch = line.match(/mode=([BERA])/);
      const costMatch = line.match(/cost=\$?([\d.]+)/);
      const sessionMatch = line.match(/s=(\d+)/);

      if (modeMatch && costMatch && sessionMatch) {
        summaries.push({
          type: modeMatch[1],
          session: parseInt(sessionMatch[1]),
          cost: parseFloat(costMatch[1])
        });
      }
    }

    // Group by type and compute averages
    const byType = {};
    for (const s of summaries) {
      if (!byType[s.type]) byType[s.type] = [];
      byType[s.type].push(s);
    }

    const summary = {};
    for (const type of ['B', 'E', 'R', 'A']) {
      const entries = byType[type] || [];
      const last10 = entries.slice(-10);
      const costs = last10.map(e => e.cost);
      const avg = costs.length > 0
        ? Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 100) / 100
        : 0;

      summary[type] = {
        count_in_history: entries.length,
        avg_cost_last_10: avg,
        verdict: avg > 2.0 ? 'high_cost' : (avg < 0.3 ? 'low_cost' : 'normal')
      };
    }

    return { summary };
  } catch {
    return { summary: {} };
  }
}

function computeRScopeBudgetCompliance() {
  const historyPath = join(STATE_DIR, 'session-history.txt');
  if (!existsSync(historyPath)) return { sessions_checked: [], violations: [], violation_count: 0, rate: 'N/A' };

  const ROUTINE_FILES = new Set(['directives.json', 'work-queue.json', 'BRAINSTORMING.md', 'BRIEFING.md']);

  // Collect plan_files from active directives (wq-912: exclude directive-plan files from scope budget)
  const directives = safeRead(join(PROJECT_DIR, 'directives.json'), { directives: [] });
  const activeDirectives = (directives.directives || []).filter(d => d.status === 'active');
  const directivePlanFiles = new Set();
  for (const d of activeDirectives) {
    if (Array.isArray(d.plan_files)) {
      for (const f of d.plan_files) directivePlanFiles.add(f);
    }
  }

  // Combined exclusion set: routine files + active directive plan files
  const excludedFiles = new Set([...ROUTINE_FILES, ...directivePlanFiles]);

  try {
    const content = readFileSync(historyPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    // Extract last 5 R sessions
    const rSessions = [];
    for (const line of lines) {
      if (!line.includes('mode=R')) continue;
      const sessionMatch = line.match(/s=(\d+)/);
      const filesMatch = line.match(/files=\[([^\]]*)\]/);
      if (!sessionMatch) continue;

      const session = `s${sessionMatch[1]}`;
      const files = filesMatch && filesMatch[1] !== '(none)'
        ? filesMatch[1].split(',').map(f => f.trim()).filter(Boolean)
        : [];
      const nonRoutine = files.filter(f => !excludedFiles.has(f));

      rSessions.push({
        session,
        non_routine_files: nonRoutine,
        count: nonRoutine.length,
        verdict: nonRoutine.length >= 3 ? 'violation' : 'compliant'
      });
    }

    const last5 = rSessions.slice(-5);
    const violations = last5.filter(s => s.verdict === 'violation');

    return {
      sessions_checked: last5.map(s => s.session),
      details: last5,
      directive_plan_files: directivePlanFiles.size > 0 ? [...directivePlanFiles] : [],
      violation_count: violations.length,
      rate: `${last5.length - violations.length}/${last5.length} compliant`
    };
  } catch {
    return { sessions_checked: [], violations: [], violation_count: 0, rate: 'error' };
  }
}

function computeBPipelineGateCompliance() {
  const historyPath = join(STATE_DIR, 'session-history.txt');
  if (!existsSync(historyPath)) return { sessions_checked: 0, violations: [], violation_count: 0, rate: 'N/A' };

  // Pipeline gate was introduced in s1569 (R#270, wq-669). Only audit sessions after that.
  const GATE_DEPLOYED = 1569;

  // Build a map of wq-ID → outcome from both active queue and archive
  const queue = safeRead(join(PROJECT_DIR, 'work-queue.json'), { queue: [] });
  const archive = safeRead(join(PROJECT_DIR, 'work-queue-archive.json'), { archived: [] });
  const allItems = [...(queue.queue || []), ...(archive.archived || [])];

  // Map: session number → list of completed wq-IDs consumed in that session
  const sessionConsumed = {};
  for (const item of allItems) {
    if (item.outcome && item.outcome.session && item.outcome.result === 'completed') {
      const s = item.outcome.session;
      if (!sessionConsumed[s]) sessionConsumed[s] = [];
      sessionConsumed[s].push(item.id);
    }
  }

  try {
    const content = readFileSync(historyPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    // Extract B sessions
    const bSessions = [];
    for (const line of lines) {
      if (!line.includes('mode=B')) continue;
      const sessionMatch = line.match(/s=(\d+)/);
      const filesMatch = line.match(/files=\[([^\]]*)\]/);
      const noteMatch = line.match(/note:\s*(.*)/);
      if (!sessionMatch) continue;

      const sessionNum = parseInt(sessionMatch[1]);
      const files = filesMatch && filesMatch[1] !== '(none)'
        ? filesMatch[1].split(',').map(f => f.trim()).filter(Boolean)
        : [];
      const note = noteMatch ? noteMatch[1] : '';

      // Extract wq-ID from note
      const wqMatch = note.match(/wq-(\d+)/);
      const wqId = wqMatch ? `wq-${wqMatch[1]}` : null;

      bSessions.push({ session: sessionNum, wqId, files, note });
    }

    // Check last 10 B sessions after gate deployment for compliance
    const postGate = bSessions.filter(bs => bs.session > GATE_DEPLOYED);
    const recent = postGate.slice(-10);
    const results = [];

    for (const bs of recent) {
      const consumed = sessionConsumed[bs.session] || [];
      if (consumed.length === 0) {
        // This B session didn't complete any queue items — not subject to the gate
        results.push({
          session: `s${bs.session}`,
          consumed: [],
          contributed: true,
          verdict: 'no_consumption',
          detail: 'No queue items completed — gate not applicable'
        });
        continue;
      }

      // Check contribution: did files include BRAINSTORMING.md or work-queue.json?
      const contributed = bs.files.some(f =>
        f === 'BRAINSTORMING.md' || f === 'work-queue.json'
      );

      results.push({
        session: `s${bs.session}`,
        consumed,
        contributed,
        verdict: contributed ? 'compliant' : 'violation',
        detail: contributed
          ? `Consumed ${consumed.join(', ')}; contributed via ${bs.files.filter(f => f === 'BRAINSTORMING.md' || f === 'work-queue.json').join(', ')}`
          : `Consumed ${consumed.join(', ')} without contributing to BRAINSTORMING.md or work-queue.json`
      });
    }

    const applicable = results.filter(r => r.verdict !== 'no_consumption');
    const violations = applicable.filter(r => r.verdict === 'violation');
    const compliant = applicable.filter(r => r.verdict === 'compliant');

    return {
      sessions_checked: recent.length,
      applicable: applicable.length,
      details: results,
      violations: violations.map(v => ({ session: v.session, consumed: v.consumed })),
      violation_count: violations.length,
      rate: applicable.length > 0
        ? `${compliant.length}/${applicable.length} compliant`
        : 'N/A (no consumption in window)'
    };
  } catch {
    return { sessions_checked: 0, violations: [], violation_count: 0, rate: 'error' };
  }
}

function computeIntelYield() {
  const archive = safeRead(join(PROJECT_DIR, 'work-queue-archive.json'), { archived: [] });
  const allArchived = archive.archived || [];

  // Filter to intel-sourced items (source contains "intel")
  const intelItems = allArchived.filter(i => i.source && i.source.includes('intel'));

  if (intelItems.length === 0) return { total: 0, built: 0, retired: 0, yield_pct: 0, verdict: 'no_data' };

  let built = 0, retired = 0, deferred = 0;
  for (const item of intelItems) {
    // Newer format: outcome.result field
    const result = item.outcome && item.outcome.result;
    if (result === 'completed') { built++; continue; }
    if (result === 'retired') { retired++; continue; }
    if (result === 'deferred') { deferred++; continue; }

    // Older format: status field directly, no outcome.result
    if (item.status === 'completed' || item.status === 'done') { built++; continue; }
    if (item.status === 'retired') { retired++; continue; }

    // Fallback: check quality for non-actionable
    const quality = item.outcome && item.outcome.quality;
    if (quality === 'non-actionable' || quality === 'duplicate') { retired++; }
    else { built++; } // Assume built if unclear
  }

  const decidedTotal = built + retired;
  const yieldPct = decidedTotal > 0 ? Math.round((built / decidedTotal) * 100) : 0;

  return {
    total: intelItems.length,
    built,
    retired,
    deferred,
    yield_pct: yieldPct,
    verdict: yieldPct < 20 ? 'low_yield' : (yieldPct < 50 ? 'moderate_yield' : 'healthy')
  };
}

// --- Session cost trend indicators (wq-873, wq-875) ---

function computeCostTrend(sessionType, thresholdValue) {
  const historyPath = join(STATE_DIR, 'session-history.txt');
  if (!existsSync(historyPath)) return { last5_avg: 0, last10_avg: 0, trend: '—', threshold_crossed: false, verdict: 'no_data' };

  try {
    const content = readFileSync(historyPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const costs = [];
    for (const line of lines) {
      if (!line.includes(`mode=${sessionType}`)) continue;
      const costMatch = line.match(/cost=\$?([\d.]+)/);
      const sessionMatch = line.match(/s=(\d+)/);
      if (costMatch && sessionMatch) {
        costs.push({ session: parseInt(sessionMatch[1]), cost: parseFloat(costMatch[1]) });
      }
    }

    if (costs.length === 0) return { last5_avg: 0, last10_avg: 0, trend: '—', threshold_crossed: false, verdict: 'no_data' };
    if (costs.length < 2) return { last5_avg: 0, last10_avg: 0, trend: '—', threshold_crossed: false, verdict: 'insufficient_data' };

    const last5 = costs.slice(-5);
    const last10 = costs.slice(-10);

    const avg5 = Math.round((last5.reduce((a, b) => a + b.cost, 0) / last5.length) * 100) / 100;
    const avg10 = Math.round((last10.reduce((a, b) => a + b.cost, 0) / last10.length) * 100) / 100;

    // Median is outlier-resistant — use it for threshold gating (wq-961)
    const sorted5 = [...last5].sort((a, b) => a.cost - b.cost);
    const median5 = sorted5.length % 2 === 1
      ? sorted5[Math.floor(sorted5.length / 2)].cost
      : (sorted5[sorted5.length / 2 - 1].cost + sorted5[sorted5.length / 2].cost) / 2;
    const last5_median = Math.round(median5 * 100) / 100;

    const delta = avg5 - avg10;
    const significanceThreshold = 0.15; // $0.15 change is significant
    let arrow;
    if (delta > significanceThreshold) arrow = '↑';
    else if (delta < -significanceThreshold) arrow = '↓';
    else arrow = '→';

    // Use median for threshold — single outliers no longer trigger escalation (wq-961)
    const thresholdCrossed = last5_median >= thresholdValue;

    let verdict;
    if (thresholdCrossed) verdict = 'threshold_breach';
    else if (arrow === '↑') verdict = 'increasing';
    else if (arrow === '↓') verdict = 'decreasing';
    else verdict = 'stable';

    return {
      last5_avg: avg5,
      last5_median,
      last10_avg: avg10,
      delta: Math.round(delta * 100) / 100,
      trend: arrow,
      threshold_crossed: thresholdCrossed,
      threshold_value: thresholdValue,
      sessions_in_last5: last5.map(e => `s${e.session}`),
      verdict
    };
  } catch {
    return { last5_avg: 0, last10_avg: 0, trend: '—', threshold_crossed: false, verdict: 'error' };
  }
}

function computeBCostTrend() {
  return computeCostTrend('B', 2.00);
}

function computeECostTrend() {
  return computeCostTrend('E', 1.80);  // wq-901: aligned to cap, not target. See audit-cost-escalation.mjs comment.
}

function computeRCostTrend() {
  return computeCostTrend('R', 2.00);
}

// --- E session scope-bleed commit categorization (wq-713) ---

function categorizeCommitMessage(subject, files) {
  const msg = subject.toLowerCase();
  const engagementInfra = /verify|engagement|picker|compliance|engage|credential/i;

  // Bug fix (reactive)
  if (/^fix[:(]/.test(msg) || (/fix|handle|repair|patch/.test(msg) && files.some(f => engagementInfra.test(f)))) {
    const justified = files.some(f => engagementInfra.test(f));
    return {
      category: 'bug-fix',
      label: 'reactive',
      justified,
      reason: justified
        ? 'Fixing engagement infrastructure during E session'
        : 'Bug fix targeting non-engagement code'
    };
  }

  // Config/credential (accidental)
  if (files.every(f => /credential|config|\.json$/.test(f)) || (/^chore[:(]/.test(msg) && files.every(f => /\.json$/.test(f)))) {
    return {
      category: 'config',
      label: 'accidental',
      justified: true,
      reason: 'Config/credential change during engagement'
    };
  }

  // Feature/refactor (proactive — discipline failure)
  if (/^feat[:(]/.test(msg) || /^refactor[:(]/.test(msg) || files.some(f => /\.(mjs|js|sh|cjs)$/.test(f))) {
    return {
      category: 'feature',
      label: 'proactive',
      justified: false,
      reason: 'Proactive build work during E session — discipline failure'
    };
  }

  return { category: 'unknown', label: 'unclassified', justified: false, reason: 'Could not categorize' };
}

function getSessionCommitDetails(sessionFiles, sessionDate) {
  // Given the files touched by an E session, find matching git commits on the same date
  const validFiles = sessionFiles.filter(f => f !== '(none)');
  if (validFiles.length === 0) return [];

  // Time-bound: only look at commits from the session date (±1 day buffer)
  const dateFilter = sessionDate ? `--after="${sessionDate}T00:00:00" --before="${sessionDate}T23:59:59"` : '';

  const commits = [];
  for (const file of validFiles) {
    try {
      const raw = execSync(
        `git log ${dateFilter} --format="%H %s" -- "${file}" 2>/dev/null | head -3`,
        { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000 }
      );
      for (const line of raw.trim().split('\n').filter(l => l.trim())) {
        const [hash, ...msgParts] = line.split(' ');
        const msg = msgParts.join(' ');
        if (msg.includes('auto-snapshot')) continue;
        if (commits.find(c => c.hash === hash.slice(0, 8))) continue;

        let changedFiles = [file];
        try {
          const filesRaw = execSync(
            `git diff-tree --no-commit-id --name-only -r ${hash}`,
            { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 3000 }
          );
          changedFiles = filesRaw.trim().split('\n').filter(f => f.trim());
        } catch { /* use fallback */ }

        commits.push({ hash: hash.slice(0, 8), subject: msg, files: changedFiles });
      }
    } catch { /* skip */ }
  }

  return commits.map(c => {
    const classification = categorizeCommitMessage(c.subject, c.files);
    return { hash: c.hash, message: c.subject, files: c.files, ...classification };
  });
}

function computeEScopeBleed() {
  const historyPath = join(STATE_DIR, 'session-history.txt');
  if (!existsSync(historyPath)) return { sessions_checked: 0, violations: [], violation_count: 0, verdict: 'no_data' };

  try {
    const content = readFileSync(historyPath, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    const eSessions = [];
    for (const line of lines) {
      if (!line.includes('mode=E')) continue;
      const sessionMatch = line.match(/s=(\d+)/);
      const buildMatch = line.match(/build=(\d+)\s+commit/);
      const costMatch = line.match(/cost=\$?([\d.]+)/);
      const noteMatch = line.match(/note:\s*(.*)/);
      const filesMatch = line.match(/files=\[([^\]]*)\]/);
      if (!sessionMatch) continue;

      const sessionNum = parseInt(sessionMatch[1]);
      const buildCommits = buildMatch ? parseInt(buildMatch[1]) : 0;
      const cost = costMatch ? parseFloat(costMatch[1]) : 0;
      const note = noteMatch ? noteMatch[1].slice(0, 120) : '';
      const files = filesMatch ? filesMatch[1].split(',').map(f => f.trim()).filter(Boolean) : [];

      const date = line.match(/^(\d{4}-\d{2}-\d{2})/);
      eSessions.push({ session: sessionNum, build_commits: buildCommits, cost, note, files, date: date ? date[1] : null });
    }

    const last10 = eSessions.slice(-10);
    const violations = last10.filter(s => s.build_commits > 0);

    // Compute E cost with and without scope-bleed sessions for comparison
    const cleanSessions = last10.filter(s => s.build_commits === 0);
    const bleedSessions = last10.filter(s => s.build_commits > 0);
    const cleanAvg = cleanSessions.length > 0
      ? Math.round((cleanSessions.reduce((a, s) => a + s.cost, 0) / cleanSessions.length) * 100) / 100
      : 0;
    const bleedAvg = bleedSessions.length > 0
      ? Math.round((bleedSessions.reduce((a, s) => a + s.cost, 0) / bleedSessions.length) * 100) / 100
      : 0;

    // Root cause analysis for violations (wq-713)
    const violationsWithRCA = violations.map(v => {
      const commitDetails = getSessionCommitDetails(v.files, v.date);
      const categories = commitDetails.map(c => c.category);
      const allJustified = commitDetails.length > 0 && commitDetails.every(c => c.justified);
      const hasFeature = categories.includes('feature');

      let rca_verdict;
      if (commitDetails.length === 0) rca_verdict = 'no_commits_found';
      else if (allJustified) rca_verdict = 'justified';
      else if (hasFeature) rca_verdict = 'discipline_failure';
      else rca_verdict = 'reactive_fix';

      return {
        session: `s${v.session}`,
        build_commits: v.build_commits,
        cost: v.cost,
        note: v.note,
        root_cause: {
          verdict: rca_verdict,
          all_justified: allJustified,
          commits: commitDetails.map(c => ({
            hash: c.hash,
            message: c.message,
            category: c.category,
            label: c.label,
            justified: c.justified,
            reason: c.reason
          })),
          summary: {
            bug_fix: categories.filter(c => c === 'bug-fix').length,
            feature: categories.filter(c => c === 'feature').length,
            config: categories.filter(c => c === 'config').length,
            unknown: categories.filter(c => c === 'unknown').length
          }
        }
      };
    });

    return {
      sessions_checked: last10.length,
      violations: violationsWithRCA,
      violation_count: violations.length,
      cost_impact: {
        clean_avg: cleanAvg,
        bleed_avg: bleedAvg,
        delta: bleedAvg > 0 ? Math.round((bleedAvg - cleanAvg) * 100) / 100 : 0
      },
      verdict: violations.length === 0 ? 'clean' :
        (violations.length <= 1 ? 'minor_bleed' : 'recurring_bleed')
    };
  } catch {
    return { sessions_checked: 0, violations: [], violation_count: 0, verdict: 'error' };
  }
}

// --- Backup substitution rate (wq-881) ---

function computeBackupSubstitutionRate() {
  // Combine current trace and archive
  const current = safeRead(join(STATE_DIR, 'engagement-trace.json'), []);
  const archive = safeRead(join(STATE_DIR, 'engagement-trace-archive.json'), []);
  const allTraces = [...archive, ...current];

  // Get last 10 E sessions (each trace entry is one E session)
  const last10 = allTraces.slice(-10);
  if (last10.length === 0) return { sessions_checked: 0, total_substitutions: 0, verdict: 'no_data' };

  let totalSubs = 0;
  const platformCounts = {}; // original platform → count of times substituted away from

  for (const trace of last10) {
    const subs = trace.backup_substitutions || [];
    totalSubs += subs.length;
    for (const sub of subs) {
      const orig = sub.original;
      if (orig) {
        platformCounts[orig] = (platformCounts[orig] || 0) + 1;
      }
    }
  }

  // Sort platforms by substitution frequency (descending)
  const ranked = Object.entries(platformCounts)
    .sort((a, b) => b[1] - a[1]);

  const topReplaced = ranked.length > 0 ? ranked[0][0] : null;

  // Circuit-break candidates: platforms substituted in ≥3 of last 10 sessions
  const circuitBreakCandidates = ranked
    .filter(([, count]) => count >= 3)
    .map(([platform, count]) => ({ platform, count, rate: `${count}/${last10.length}` }));

  let verdict;
  if (totalSubs === 0) verdict = 'clean';
  else if (circuitBreakCandidates.length > 0) verdict = 'circuit_break_recommended';
  else verdict = 'occasional';

  return {
    sessions_checked: last10.length,
    total_substitutions: totalSubs,
    summary: `${totalSubs} substitutions in last ${last10.length} E sessions${topReplaced ? `, top replaced: ${topReplaced}` : ''}`,
    by_platform: Object.fromEntries(ranked),
    circuit_break_candidates: circuitBreakCandidates,
    verdict
  };
}

// --- E session engagement depth (wq-911) ---

function computeEEngagementTrend() {
  const current = safeRead(join(STATE_DIR, 'engagement-trace.json'), []);
  const archive = safeRead(join(STATE_DIR, 'engagement-trace-archive.json'), []);
  const allTraces = [...archive, ...current];

  // Deduplicate by session number (current may overlap with archive)
  const seen = new Set();
  const unique = [];
  for (const t of allTraces) {
    if (t.session && !seen.has(t.session)) {
      seen.add(t.session);
      unique.push(t);
    }
  }

  const last10 = unique.slice(-10);
  if (last10.length === 0) return { sessions_checked: 0, verdict: 'no_data' };

  const THREAD_FLOOR = 2; // Minimum expected threads per E session

  const dataPoints = last10.map(t => ({
    session: t.session,
    threads: typeof t.threads_contributed === 'number' ? t.threads_contributed : (t.platforms_engaged || []).length,
    platforms: (t.platforms_engaged || []).length
  }));

  const threads = dataPoints.map(d => d.threads);
  const platforms = dataPoints.map(d => d.platforms);

  const avgThreads = Math.round((threads.reduce((a, b) => a + b, 0) / threads.length) * 100) / 100;
  const avgPlatforms = Math.round((platforms.reduce((a, b) => a + b, 0) / platforms.length) * 100) / 100;
  const minThreads = Math.min(...threads);
  const floorViolations = threads.filter(t => t < THREAD_FLOOR).length;

  // Trend: compare last-5 vs last-10 averages
  const last5Threads = threads.slice(-5);
  const avg5Threads = last5Threads.length > 0
    ? Math.round((last5Threads.reduce((a, b) => a + b, 0) / last5Threads.length) * 100) / 100
    : 0;
  const delta = Math.round((avg5Threads - avgThreads) * 100) / 100;
  const trend = delta < -0.5 ? '↓' : (delta > 0.5 ? '↑' : '→');

  let verdict;
  if (floorViolations >= 3) verdict = 'engagement_thinning';
  else if (floorViolations >= 1 && trend === '↓') verdict = 'declining';
  else if (floorViolations >= 1) verdict = 'occasional_thin';
  else verdict = 'healthy';

  return {
    sessions_checked: last10.length,
    avg_threads: avgThreads,
    avg_platforms: avgPlatforms,
    min_threads: minThreads,
    floor_violations: floorViolations,
    thread_floor: THREAD_FLOOR,
    last5_avg_threads: avg5Threads,
    trend,
    delta,
    sessions: dataPoints.map(d => `s${d.session}`),
    detail: dataPoints,
    verdict
  };
}

// --- Human-review validation (wq-889) ---

function computeHumanReviewValidation() {
  try {
    const raw = execSync(
      'node validate-human-review.mjs --json 2>/dev/null',
      { cwd: PROJECT_DIR, encoding: 'utf8', timeout: 5000 }
    );
    const result = JSON.parse(raw.trim());
    return {
      ok: result.ok,
      issue_count: result.issueCount,
      issues: result.issues,
      item_count: result.itemCount,
      verdict: result.ok ? 'valid' : 'has_issues'
    };
  } catch (e) {
    // If validator exits non-zero, it found issues — try parsing stdout
    if (e.stdout) {
      try {
        const result = JSON.parse(e.stdout.trim());
        return {
          ok: false,
          issue_count: result.issueCount || 0,
          issues: result.issues || [],
          item_count: result.itemCount || 0,
          verdict: 'has_issues'
        };
      } catch { /* fall through */ }
    }
    return { ok: false, issue_count: -1, issues: ['validator failed to run'], item_count: 0, verdict: 'error' };
  }
}

// --- TODO tracker false-positive rate (wq-866) ---

function computeTodoFalsePositiveRate() {
  const trackerPath = join(STATE_DIR, 'todo-tracker.json');
  const archivePath = join(PROJECT_DIR, 'work-queue-archive.json');
  const queuePath = join(PROJECT_DIR, 'work-queue.json');

  // Source 1: todo-tracker.json — items caught by the scan hook
  const tracker = safeRead(trackerPath, { items: [] });
  const allTracked = tracker.items || [];
  const openItems = allTracked.filter(i => i.status === 'open');
  const resolvedItems = allTracked.filter(i => i.status === 'resolved');
  const autoResolvedFP = resolvedItems.filter(i =>
    i.resolution_note && /false.?positive/i.test(i.resolution_note)
  );
  const naturallyResolved = resolvedItems.filter(i =>
    !i.resolution_note || !/false.?positive/i.test(i.resolution_note)
  );

  // Source 2: work-queue — todo-scan sourced items and their outcomes
  const archive = safeRead(archivePath, { archived: [] });
  const queue = safeRead(queuePath, { queue: [] });
  const allQueueItems = [...(archive.archived || []), ...(queue.queue || [])];
  const todoScanItems = allQueueItems.filter(i => i.source === 'todo-scan');

  let queueCompleted = 0, queueRetired = 0, queuePending = 0;
  for (const item of todoScanItems) {
    const result = item.outcome?.result || item.status;
    if (result === 'completed' || result === 'done') queueCompleted++;
    else if (result === 'retired') queueRetired++;
    else if (result === 'pending' || result === 'in-progress') queuePending++;
    else queueRetired++; // unknown status treated as retired
  }

  const queueDecided = queueCompleted + queueRetired;
  const queueFPRate = queueDecided > 0
    ? Math.round((queueRetired / queueDecided) * 100)
    : 0;

  // Combined false-positive rate: auto-resolved FPs + queue retirements vs total processed
  const totalProcessed = autoResolvedFP.length + naturallyResolved.length + queueDecided;
  const totalFP = autoResolvedFP.length + queueRetired;
  const combinedFPRate = totalProcessed > 0
    ? Math.round((totalFP / totalProcessed) * 100)
    : 0;

  let verdict;
  if (totalProcessed === 0) verdict = 'no_data';
  else if (combinedFPRate <= 30) verdict = 'healthy';
  else if (combinedFPRate <= 60) verdict = 'elevated';
  else if (combinedFPRate <= 80) verdict = 'high';
  else verdict = 'critical';

  return {
    tracker: {
      total: allTracked.length,
      open: openItems.length,
      resolved: resolvedItems.length,
      auto_resolved_fp: autoResolvedFP.length,
      naturally_resolved: naturallyResolved.length
    },
    queue: {
      total_todo_scan: todoScanItems.length,
      completed: queueCompleted,
      retired: queueRetired,
      pending: queuePending,
      fp_rate_pct: queueFPRate
    },
    combined_fp_rate_pct: combinedFPRate,
    total_processed: totalProcessed,
    total_false_positives: totalFP,
    verdict
  };
}

// --- Auto-retire stuck queue items (wq-979) ---

const AUTO_RETIRE_AGE = 50; // Sessions behind current to trigger auto-retirement

/**
 * Auto-retire pending queue items that are > AUTO_RETIRE_AGE sessions old.
 * Moves them from work-queue.json to work-queue-archive.json with a retirement outcome.
 * Returns { retired: [{id, title, age}], count: N }.
 */
export function autoRetireStuckItems() {
  const queuePath = join(PROJECT_DIR, 'work-queue.json');
  const archivePath = join(PROJECT_DIR, 'work-queue-archive.json');

  const queue = safeRead(queuePath, { queue: [] });
  const archive = safeRead(archivePath, { archived: [] });
  const items = queue.queue || [];
  const currentSession = getCurrentSession();
  const dateSessionMap = buildDateSessionMap();

  const toRetire = [];
  const keepItems = [];

  for (const item of items) {
    if (item.status !== 'pending') {
      keepItems.push(item);
      continue;
    }

    let createdSession = item.created_session || item.session_added || null;
    if (!createdSession) {
      const dateStr = item.created || item.added || null;
      createdSession = estimateSessionFromDate(dateStr, dateSessionMap) || currentSession;
    }

    const age = currentSession - createdSession;
    if (age > AUTO_RETIRE_AGE) {
      toRetire.push({ item, age });
    } else {
      keepItems.push(item);
    }
  }

  if (toRetire.length === 0) {
    return { retired: [], count: 0 };
  }

  // Move retired items to archive with outcome metadata
  for (const { item, age } of toRetire) {
    item.status = 'done';
    item.outcome = {
      session: currentSession,
      result: 'retired',
      effort: 'trivial',
      quality: 'non-actionable',
      note: `Auto-retired: ${age} sessions old (threshold: ${AUTO_RETIRE_AGE})`
    };
    archive.archived.push(item);
  }

  // Write both files
  queue.queue = keepItems;
  writeFileSync(queuePath, JSON.stringify(queue, null, 2) + '\n');
  writeFileSync(archivePath, JSON.stringify(archive, null, 2) + '\n');

  // Persist results to state file so audit-stats can surface them (wq-988)
  const result = {
    retired: toRetire.map(({ item, age }) => ({ id: item.id, title: item.title, age })),
    count: toRetire.length,
    session: currentSession,
    timestamp: new Date().toISOString()
  };
  try {
    writeFileSync(join(STATE_DIR, 'auto-retired-items.json'), JSON.stringify(result, null, 2) + '\n');
  } catch { /* non-fatal — state dir may not exist in tests */ }

  return result;
}

/**
 * Read auto-retired items from state file (wq-988).
 * Returns the most recent auto-retire results if they're from the current session.
 * This surfaces prehook auto-retire actions in audit-stats output so the A session
 * can mention them in session notes without relying on scrolled-off log lines.
 */
function computeAutoRetiredItems() {
  const statePath = join(STATE_DIR, 'auto-retired-items.json');
  const data = safeRead(statePath, null);
  if (!data) return { count: 0, retired: [], stale: true };

  const currentSession = getCurrentSession();
  // Only surface items retired in the current session (or very recently)
  const isRecent = data.session && (currentSession - data.session) <= 1;

  return {
    count: data.count || 0,
    retired: data.retired || [],
    session: data.session || null,
    timestamp: data.timestamp || null,
    stale: !isRecent
  };
}

// Main output — only when run directly as CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('audit-stats.mjs')) {
  const stats = {
    computed_at: new Date().toISOString(),
    session: getCurrentSession(),
    pipelines: {
      intel: computeIntelStats(),
      intel_yield: computeIntelYield(),
      brainstorming: computeBrainstormingStats(),
      queue: computeQueueStats(),
      directives: computeDirectiveStats()
    },
    sessions: computeSessionStats(),
    b_cost_trend: computeBCostTrend(),
    e_cost_trend: computeECostTrend(),
    r_cost_trend: computeRCostTrend(),
    r_scope_budget: computeRScopeBudgetCompliance(),
    b_pipeline_gate: computeBPipelineGateCompliance(),
    e_scope_bleed: computeEScopeBleed(),
    e_engagement_trend: computeEEngagementTrend(),
    backup_substitution_rate: computeBackupSubstitutionRate(),
    todo_false_positive_rate: computeTodoFalsePositiveRate(),
    human_review_validation: computeHumanReviewValidation(),
    auto_retired_items: computeAutoRetiredItems()
  };

  console.log(JSON.stringify(stats, null, 2));
}

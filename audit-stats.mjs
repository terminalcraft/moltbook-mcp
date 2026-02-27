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

import { readFileSync, readdirSync, existsSync } from 'fs';
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

  for (const item of items) {
    statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;

    if (item.tags?.includes('audit')) {
      auditTagged.push(item.id);
    }

    if (item.status === 'pending') {
      // Check both field names: created_session (newer format) and session_added (wq-295 format)
      // Fall back to parsing date from 'added' field, or 0 if nothing works
      const createdSession = item.created_session || item.session_added || parseInt(item.added?.replace(/\D/g, '') || '0');
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

  const ROUTINE_FILES = new Set(['directives.json', 'work-queue.json', 'BRAINSTORMING.md']);

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
      const nonRoutine = files.filter(f => !ROUTINE_FILES.has(f));

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
  // Nudge hook (49-pipeline-nudge_B.sh) deployed at s1592. Track pre/post nudge separately.
  const NUDGE_DEPLOYED = 1592;

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

      const epoch = bs.session >= NUDGE_DEPLOYED ? 'post-nudge' : 'pre-nudge';
      results.push({
        session: `s${bs.session}`,
        consumed,
        contributed,
        epoch,
        verdict: contributed ? 'compliant' : 'violation',
        detail: contributed
          ? `Consumed ${consumed.join(', ')}; contributed via ${bs.files.filter(f => f === 'BRAINSTORMING.md' || f === 'work-queue.json').join(', ')}`
          : `Consumed ${consumed.join(', ')} without contributing to BRAINSTORMING.md or work-queue.json`
      });
    }

    const applicable = results.filter(r => r.verdict !== 'no_consumption');
    const violations = applicable.filter(r => r.verdict === 'violation');
    const compliant = applicable.filter(r => r.verdict === 'compliant');

    // Epoch breakdown for nudge-hook effectiveness tracking
    const preNudge = applicable.filter(r => r.epoch === 'pre-nudge');
    const postNudge = applicable.filter(r => r.epoch === 'post-nudge');
    const preNudgeViolations = preNudge.filter(r => r.verdict === 'violation');
    const postNudgeViolations = postNudge.filter(r => r.verdict === 'violation');

    return {
      sessions_checked: recent.length,
      applicable: applicable.length,
      details: results,
      violations: violations.map(v => ({ session: v.session, consumed: v.consumed, epoch: v.epoch })),
      violation_count: violations.length,
      rate: applicable.length > 0
        ? `${compliant.length}/${applicable.length} compliant`
        : 'N/A (no consumption in window)',
      nudge_hook: {
        deployed_at: `s${NUDGE_DEPLOYED}`,
        pre_nudge: { applicable: preNudge.length, violations: preNudgeViolations.length,
          rate: preNudge.length > 0 ? `${preNudge.length - preNudgeViolations.length}/${preNudge.length}` : 'N/A' },
        post_nudge: { applicable: postNudge.length, violations: postNudgeViolations.length,
          rate: postNudge.length > 0 ? `${postNudge.length - postNudgeViolations.length}/${postNudge.length}` : 'N/A' },
        assessment: postNudge.length < 3 ? 'insufficient_data' :
          (postNudgeViolations.length === 0 ? 'effective' :
           (postNudgeViolations.length < preNudgeViolations.length ? 'improving' : 'ineffective'))
      }
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

// Main output
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
  r_scope_budget: computeRScopeBudgetCompliance(),
  b_pipeline_gate: computeBPipelineGateCompliance(),
  e_scope_bleed: computeEScopeBleed()
};

console.log(JSON.stringify(stats, null, 2));

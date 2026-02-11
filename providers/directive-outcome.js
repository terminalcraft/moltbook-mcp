/**
 * Directive Outcome Tracking Provider (wq-208)
 *
 * Tracks which urgent directives were assigned to a session at startup
 * and computes outcomes on exit. This creates a feedback loop: A sessions
 * can analyze directive-outcomes.json to identify which session types
 * are failing their mandates.
 *
 * Extracted from index.js as part of Components/Providers/Transforms refactor.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Create directive assignment record for tracking outcomes.
 *
 * @param {number} sessionNum - Current session number
 * @param {string} sessionType - Session type (B/E/R/A)
 * @param {Object} directiveHealth - Pre-computed directive health from session context
 * @returns {Object} Directive assignments record
 */
export function createDirectiveAssignments(sessionNum, sessionType, directiveHealth) {
  // wq-477: R sessions maintain ALL active directives (reviewing notes, updating
  // status, decomposing into queue items). Using only keyword-matched "urgent"
  // directives gave R sessions urgentDirectives=[], causing 0% addressed rate
  // across 3+ R sessions. Fix: assign all active directives for R sessions.
  const directives = sessionType === 'R'
    ? (directiveHealth?.active?.map(d => d.id) || [])
    : (directiveHealth?.urgent?.map(d => d.id) || []);

  return {
    sessionNum,
    sessionType,
    assignedAt: new Date().toISOString(),
    urgentDirectives: directives,
    // Outcome populated on exit by analyzing session artifacts
    outcome: null
  };
}

/**
 * Compute directive outcomes by analyzing session artifacts.
 * This is a heuristic — not perfect, but enables trend detection.
 *
 * wq-318: Enhanced evidence detection to capture actual work indicators,
 * not just directive.json updates. Checks work-queue, engagement artifacts,
 * platform registry changes, and session-type-specific indicators.
 *
 * @param {Object} assignments - Directive assignments from createDirectiveAssignments
 * @param {string} baseDir - Base directory for data files
 * @returns {Object} Computed outcome
 */
export function computeDirectiveOutcome(assignments, baseDir) {
  const outcome = {
    completedAt: new Date().toISOString(),
    addressed: [],   // directives that show evidence of action
    ignored: [],     // urgent directives with no visible action
    evidence: {}     // supporting data for each assessment
  };

  const sessionStart = new Date(assignments.assignedAt).getTime();
  const configDir = join(process.env.HOME || '/home/moltbot', '.config/moltbook');

  // Load data files once for all directive checks
  let directives = { directives: [] };
  let workQueue = { queue: [] };
  let workQueueArchive = { archived: [] };  // Completed items are moved here
  let engagementIntel = [];  // Array of intel entries (file format is [])
  let engagementTrace = {};
  let accountRegistry = { accounts: [] };

  try { directives = JSON.parse(readFileSync(join(baseDir, 'directives.json'), 'utf8')); } catch { /* ignore */ }
  try { workQueue = JSON.parse(readFileSync(join(baseDir, 'work-queue.json'), 'utf8')); } catch { /* ignore */ }
  try { workQueueArchive = JSON.parse(readFileSync(join(baseDir, 'work-queue-archive.json'), 'utf8')); } catch { /* ignore */ }
  try {
    const raw = JSON.parse(readFileSync(join(configDir, 'engagement-intel.json'), 'utf8'));
    // File can be [] array or { entries: [] } object
    engagementIntel = Array.isArray(raw) ? raw : (raw.entries || []);
  } catch { /* ignore */ }
  try { engagementTrace = JSON.parse(readFileSync(join(configDir, 'engagement-trace.json'), 'utf8')); } catch { /* ignore */ }
  try { accountRegistry = JSON.parse(readFileSync(join(baseDir, 'account-registry.json'), 'utf8')); } catch { /* ignore */ }

  // Combine queue and archive for searching (items can be in either)
  const allQueueItems = [...(workQueue.queue || []), ...(workQueueArchive.archived || [])];

  for (const dId of assignments.urgentDirectives) {
    const evidence = [];
    const d = directives.directives.find(x => x.id === dId);

    // 1. Check if directive itself was updated/completed
    if (d?.updated) {
      const updatedAt = new Date(d.updated).getTime();
      if (updatedAt > sessionStart) {
        evidence.push('directive-updated');
      }
    }
    if (d?.status === 'completed' && d?.completed_session === assignments.sessionNum) {
      evidence.push('directive-completed');
    }

    // 2. Check if directive's linked queue_item was progressed
    if (d?.queue_item) {
      const qItem = allQueueItems.find(q => q.id === d.queue_item);
      if (qItem) {
        if (qItem.status === 'done') {
          evidence.push(`queue-item-done:${d.queue_item}`);
        } else if (qItem.status === 'in-progress' && qItem.notes?.includes(`s${assignments.sessionNum}`)) {
          evidence.push(`queue-item-progress:${d.queue_item}`);
        }
      }
    }

    // 3. Session-type-specific evidence detection
    // R#249: Replaced hardcoded directive-specific checks (d044, d047, d045, d049)
    // with generic tag-based evidence matching. Directives declare their domain
    // via tags in directives.json; the outcome tracker matches evidence patterns
    // by tag rather than by ID. New directives get evidence tracking automatically.
    const dTags = d?.tags || [];
    const sessionPattern = new RegExp(`(s${assignments.sessionNum}\\b|[BERA]#\\d+ s${assignments.sessionNum}\\b)`);

    if (assignments.sessionType === 'B') {
      const completedThisSession = allQueueItems.filter(q =>
        q.status === 'done' && sessionPattern.test(q.notes || '')
      );
      if (completedThisSession.length > 0) {
        evidence.push(`b-session-completions:${completedThisSession.length}`);
      }

      // Tag-based evidence: match queue items by directive tags
      if (dTags.length > 0) {
        const taggedWork = allQueueItems.filter(q =>
          q.tags?.some(t => dTags.includes(t)) && sessionPattern.test(q.notes || '')
        );
        if (taggedWork.length > 0) {
          evidence.push(`tagged-work:${taggedWork.length}`);
        }
      }
    }

    if (assignments.sessionType === 'E') {
      const recentIntel = engagementIntel.filter(e => {
        const entryTime = new Date(e.timestamp || e.discovered_at || 0).getTime();
        return entryTime > sessionStart;
      });
      if (recentIntel.length > 0) {
        evidence.push(`intel-captured:${recentIntel.length}`);
      }

      const traceArray = Array.isArray(engagementTrace) ? engagementTrace : [engagementTrace];
      const sessionTrace = traceArray.find(t => t?.session === assignments.sessionNum);
      if (sessionTrace) {
        const engagedCount = (sessionTrace.platforms_engaged || sessionTrace.engaged_platforms || []).length;
        if (engagedCount > 0) {
          evidence.push(`platforms-engaged:${engagedCount}`);
        }
      }

      // Scoped directives (scope=E) get intel-minimum check
      if (d?.scope === 'E' && recentIntel.length >= 1) {
        evidence.push('scoped-intel-minimum-met');
      }

      // Tag-based evidence: match intel content against directive tags
      if (dTags.length > 0) {
        const taggedIntel = recentIntel.some(e =>
          dTags.some(t => (e.content || '').toLowerCase().includes(t))
        );
        if (taggedIntel) {
          evidence.push('tagged-intel-match');
        }
      }
    }

    if (assignments.sessionType === 'R') {
      if (d?.acked_session === assignments.sessionNum) {
        evidence.push('directive-acknowledged');
      }

      if (d?.notes?.includes(`R#`) || d?.notes?.includes(`s${assignments.sessionNum}`)) {
        evidence.push('directive-notes-updated');
      }

      const derivedItems = allQueueItems.filter(q =>
        q.source?.includes(dId) || q.title?.toLowerCase().includes(dId) ||
        q.tags?.includes(dId)
      );
      if (derivedItems.length > 0) {
        evidence.push(`queue-decomposition:${derivedItems.length}`);
      }

      try {
        const djPath = join(baseDir, 'directives.json');
        const djMtime = statSync(djPath).mtimeMs;
        if (djMtime > sessionStart) {
          evidence.push('directives-json-modified');
        }
      } catch { /* ignore stat errors */ }
    }

    if (assignments.sessionType === 'A') {
      evidence.push('audit-tracking-active');
    }

    // 4. Auto-escalation resolution: check if referenced queue items unblocked
    if (d?.from === 'system') {
      const blockedMatch = d?.content?.match(/wq-\d+/);
      if (blockedMatch) {
        const blockedItem = allQueueItems.find(q => q.id === blockedMatch[0]);
        if (blockedItem && blockedItem.status !== 'blocked') {
          evidence.push(`escalation-resolved:${blockedMatch[0]}`);
        }
      }
    }

    outcome.evidence[dId] = evidence;
    if (evidence.length > 0) {
      outcome.addressed.push(dId);
    } else {
      outcome.ignored.push(dId);
    }
  }

  return outcome;
}

/**
 * Save directive outcome to historical log for A session analysis.
 * Keeps last 50 outcomes to bound file size.
 *
 * @param {Object} assignments - Original assignments record
 * @param {Object} outcome - Computed outcome from computeDirectiveOutcome
 * @param {string} baseDir - Base directory for data files
 */
export function saveDirectiveOutcome(assignments, outcome, baseDir) {
  const outcomePath = join(baseDir, 'directive-outcomes.json');
  let history = { version: 1, outcomes: [] };
  try {
    if (existsSync(outcomePath)) {
      history = JSON.parse(readFileSync(outcomePath, 'utf8'));
    }
  } catch { /* start fresh */ }

  // R#213 (wq-435): Deduplicate by session number. MCP server process can restart
  // mid-session (e.g., E sessions), causing multiple exit handlers to fire. Each
  // writes an outcome entry — early ones have incomplete evidence (addressed=0),
  // later ones reflect actual session work. Replace existing entry for this session
  // instead of appending, keeping the latest (most complete) write.
  const sessionNum = assignments.sessionNum;
  history.outcomes = history.outcomes.filter(o =>
    (o.sessionNum || o.session) !== sessionNum
  );

  // Keep last 50 outcomes to bound file size
  history.outcomes = history.outcomes.slice(-49);
  // wq-411: Flatten schema so consumers can access mode and addressed at top level
  // A sessions read entry.mode and entry.addressed — previously these were
  // entry.sessionType and entry.outcome.addressed, causing null reads.
  history.outcomes.push({
    ...assignments,
    session: assignments.sessionNum,     // wq-426: alias for consumer compatibility
    mode: assignments.sessionType || process.env.SESSION_TYPE || null,  // wq-452: fallback to env var
    addressed: outcome.addressed || [],  // promoted from outcome.addressed
    ignored: outcome.ignored || [],      // promoted from outcome.ignored
    outcome
  });

  writeFileSync(outcomePath, JSON.stringify(history, null, 2));
}

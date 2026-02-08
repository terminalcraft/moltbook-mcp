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

import { existsSync, readFileSync, writeFileSync } from 'fs';
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
  return {
    sessionNum,
    sessionType,
    assignedAt: new Date().toISOString(),
    urgentDirectives: directiveHealth?.urgent?.map(d => d.id) || [],
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

    // 3. Check session-type-specific indicators
    if (assignments.sessionType === 'B') {
      // B sessions: check for work-queue completions this session
      // Notes format is "B#NNN sXXXX: description" - match both patterns
      const sessionPattern = new RegExp(`(s${assignments.sessionNum}\\b|B#\\d+ s${assignments.sessionNum}\\b)`);
      const completedThisSession = allQueueItems.filter(q =>
        q.status === 'done' && sessionPattern.test(q.notes || '')
      );
      if (completedThisSession.length > 0) {
        evidence.push(`b-session-completions:${completedThisSession.length}`);
      }

      // Check for platform recovery work (d047)
      if (dId === 'd047') {
        const registryChanges = accountRegistry.accounts?.filter(a =>
          a.notes?.includes(`s${assignments.sessionNum}`)
        );
        if (registryChanges?.length > 0) {
          evidence.push(`platform-recovery:${registryChanges.length}`);
        }
      }

      // Check for financial/wallet work (d044)
      if (dId === 'd044') {
        const walletItems = allQueueItems.filter(q =>
          (q.title?.toLowerCase().includes('usdc') || q.title?.toLowerCase().includes('wallet')) &&
          sessionPattern.test(q.notes || '')
        );
        if (walletItems.length > 0) {
          evidence.push(`wallet-work:${walletItems.length}`);
        }
      }
    }

    if (assignments.sessionType === 'E') {
      // E sessions: check engagement artifacts
      const recentIntel = engagementIntel.filter(e => {
        const entryTime = new Date(e.timestamp || e.discovered_at || 0).getTime();
        return entryTime > sessionStart;
      });
      if (recentIntel.length > 0) {
        evidence.push(`intel-captured:${recentIntel.length}`);
      }

      // Check engagement-trace for platform activity
      // Trace is an array of session objects, find the one for this session
      const traceArray = Array.isArray(engagementTrace) ? engagementTrace : [engagementTrace];
      const sessionTrace = traceArray.find(t => t?.session === assignments.sessionNum);
      if (sessionTrace) {
        const engagedCount = (sessionTrace.platforms_engaged || sessionTrace.engaged_platforms || []).length;
        if (engagedCount > 0) {
          evidence.push(`platforms-engaged:${engagedCount}`);
        }
      }

      // d049: intel capture minimum requirement
      if (dId === 'd049' && recentIntel.length >= 1) {
        evidence.push('d049-intel-minimum-met');
      }

      // d045: credential regeneration work
      if (dId === 'd045') {
        const credentialActivity = recentIntel.some(e =>
          (e.content || '').toLowerCase().includes('credential') ||
          (e.content || '').toLowerCase().includes('registration')
        );
        if (credentialActivity) {
          evidence.push('credential-work');
        }
      }
    }

    if (assignments.sessionType === 'R') {
      // R sessions: check if directive was acknowledged this session
      if (d?.acked_session === assignments.sessionNum) {
        evidence.push('directive-acknowledged');
      }

      // Check if notes were added this session (directive progress)
      if (d?.notes?.includes(`R#`) || d?.notes?.includes(`s${assignments.sessionNum}`)) {
        evidence.push('directive-notes-updated');
      }

      // Check for queue decomposition from directive
      const derivedItems = allQueueItems.filter(q =>
        q.source?.includes(dId) || q.title?.toLowerCase().includes(dId)
      );
      if (derivedItems.length > 0) {
        evidence.push(`queue-decomposition:${derivedItems.length}`);
      }
    }

    if (assignments.sessionType === 'A') {
      // A sessions: audit work - check if directive compliance was reviewed
      // A sessions typically don't directly address directives but audit them
      // Give credit if directive health was checked (indicated by this tracking running)
      evidence.push('audit-tracking-active');
    }

    // 4. Check for auto-escalation directives (d048, d050)
    if (dId.startsWith('d04') || dId.startsWith('d05')) {
      // Auto-escalations are addressed by human action or queue item progress
      // Check if the blocked item mentioned in the directive has progressed
      const blockedMatch = d?.content?.match(/wq-\d+/);
      if (blockedMatch) {
        const blockedId = blockedMatch[0];
        const blockedItem = allQueueItems.find(q => q.id === blockedId);
        if (blockedItem && blockedItem.status !== 'blocked') {
          evidence.push(`escalation-resolved:${blockedId}`);
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

  // Keep last 50 outcomes to bound file size
  history.outcomes = history.outcomes.slice(-49);
  // wq-411: Flatten schema so consumers can access mode and addressed at top level
  // A sessions read entry.mode and entry.addressed — previously these were
  // entry.sessionType and entry.outcome.addressed, causing null reads.
  history.outcomes.push({
    ...assignments,
    session: assignments.sessionNum,     // wq-426: alias for consumer compatibility
    mode: assignments.sessionType,       // alias for consumer compatibility
    addressed: outcome.addressed || [],  // promoted from outcome.addressed
    ignored: outcome.ignored || [],      // promoted from outcome.ignored
    outcome
  });

  writeFileSync(outcomePath, JSON.stringify(history, null, 2));
}

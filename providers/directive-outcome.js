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

  const engagementIntelPath = join(baseDir, 'engagement-intel.json');
  const directivesPath = join(baseDir, 'directives.json');

  for (const dId of assignments.urgentDirectives) {
    const evidence = [];

    // Check if directive was updated this session
    try {
      const directives = JSON.parse(readFileSync(directivesPath, 'utf8'));
      const d = directives.directives.find(x => x.id === dId);
      if (d?.updated) {
        const updatedAt = new Date(d.updated).getTime();
        const sessionStart = new Date(assignments.assignedAt).getTime();
        if (updatedAt > sessionStart) {
          evidence.push('directive-updated');
        }
      }
      if (d?.status === 'completed') {
        evidence.push('directive-completed');
      }
    } catch { /* ignore */ }

    // For E sessions, check engagement-intel for platform activity
    if (assignments.sessionType === 'E' && existsSync(engagementIntelPath)) {
      try {
        const intel = JSON.parse(readFileSync(engagementIntelPath, 'utf8'));
        const recentEntries = (intel.entries || []).filter(e => {
          const entryTime = new Date(e.timestamp || e.discovered_at || 0).getTime();
          const sessionStart = new Date(assignments.assignedAt).getTime();
          return entryTime > sessionStart;
        });
        if (recentEntries.length > 0) {
          evidence.push(`engagement-activity:${recentEntries.length}`);
        }
        // Specific check for d031 (Pinchwork): look for pinchwork activity
        if (dId === 'd031') {
          const pinchworkActivity = recentEntries.some(e =>
            (e.platform || '').toLowerCase().includes('pinchwork') ||
            (e.content || '').toLowerCase().includes('pinchwork')
          );
          if (pinchworkActivity) {
            evidence.push('pinchwork-engagement');
          }
        }
      } catch { /* ignore */ }
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
  history.outcomes.push({
    ...assignments,
    outcome
  });

  writeFileSync(outcomePath, JSON.stringify(history, null, 2));
}

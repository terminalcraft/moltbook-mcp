/**
 * picker-demotion-review.mjs — Review expired picker demotions and weight overrides.
 *
 * Checks picker-demotions.json for:
 *   1. Weight overrides with expired trial_until sessions → removes them
 *   2. Demotions >100 sessions old → flags for re-probe
 *
 * Returns { expiredTrials: [...], staledemotions: [...], cleaned: boolean }
 *
 * Created: wq-1041
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * @param {number} sessionNum - Current session number
 * @param {string} [mcpDir='.'] - Path to moltbook-mcp directory
 * @returns {{ expiredTrials: Array, staleDemotions: Array, cleaned: boolean }}
 */
export function reviewPickerDemotions(sessionNum, mcpDir = '.') {
  const filePath = join(mcpDir, 'picker-demotions.json');
  const data = JSON.parse(readFileSync(filePath, 'utf8'));

  const expiredTrials = [];
  const staleDemotions = [];
  let cleaned = false;

  // Check weight_overrides for expired trial_until
  if (Array.isArray(data.weight_overrides)) {
    const kept = [];
    for (const override of data.weight_overrides) {
      if (override.trial_until && override.trial_until < sessionNum) {
        expiredTrials.push({
          id: override.id,
          trial_until: override.trial_until,
          sessions_past: sessionNum - override.trial_until,
          reason: override.reason,
        });
      } else {
        kept.push(override);
      }
    }

    if (kept.length < data.weight_overrides.length) {
      data.weight_overrides = kept;
      writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      cleaned = true;
    }
  }

  // Check demotions >100 sessions old for re-probe consideration
  if (Array.isArray(data.demotions)) {
    for (const d of data.demotions) {
      // Extract session number from demoted_by field (e.g. "wq-576 B#424")
      const match = (d.demoted_by || '').match(/B#(\d+)/);
      const demotedSession = match ? parseInt(match[1], 10) : 0;

      // Also try to parse from demoted_at date as fallback — but session number is more reliable
      // Use the added field pattern: entries from ~s1600+ era
      const addedMatch = (d.demoted_by || '').match(/s(\d+)/);
      const refSession = demotedSession || (addedMatch ? parseInt(addedMatch[1], 10) : 0);

      if (refSession > 0 && (sessionNum - refSession) > 100) {
        staleDemotions.push({
          id: d.id,
          reason: d.reason,
          demoted_at: d.demoted_at,
          sessions_age: sessionNum - refSession,
        });
      }
    }
  }

  return { expiredTrials, staleDemotions, cleaned };
}

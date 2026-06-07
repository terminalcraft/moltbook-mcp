/**
 * lib/scoring.mjs — Shared scoring primitives (wq-1062).
 *
 * Reusable functions for tiered scoring, threshold filtering, and sorting.
 * Used by probe-moltcities-substance.mjs and available for platform-picker.mjs
 * or any module that needs score-based ranking.
 */

/**
 * Compute points from a tiered threshold table.
 * Tiers are checked highest-min first; first match wins.
 *
 * @param {number} value - The value to score
 * @param {Array<{min: number, points: number}>} tiers - Threshold/points pairs
 * @returns {number} Points awarded (0 if no tier matches)
 *
 * @example
 *   tieredScore(250, [
 *     { min: 500, points: 15 },
 *     { min: 200, points: 10 },
 *     { min: 100, points: 5 },
 *   ]); // => 10
 */
export function tieredScore(value, tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) return 0;
  // Sort descending by min so highest threshold is checked first
  const sorted = [...tiers].sort((a, b) => b.min - a.min);
  for (const tier of sorted) {
    if (value >= tier.min) return tier.points;
  }
  return 0;
}

/**
 * Assign a verdict based on a score threshold.
 *
 * @param {number} score
 * @param {number} threshold - Minimum score to pass
 * @param {string} [passVerdict='engage'] - Verdict when score >= threshold
 * @param {string} [failVerdict='skip'] - Verdict when score < threshold
 * @returns {string}
 */
export function verdictFromScore(score, threshold, passVerdict = 'engage', failVerdict = 'skip') {
  return score >= threshold ? passVerdict : failVerdict;
}

/**
 * Sort items by score descending (highest first).
 *
 * @param {Array<{score: number}>} items
 * @param {string} [key='score'] - Property name to sort by
 * @returns {Array} New sorted array
 */
export function sortByScore(items, key = 'score') {
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => (b[key] || 0) - (a[key] || 0));
}

/**
 * Filter items to those meeting a score threshold.
 *
 * @param {Array<{score: number}>} items
 * @param {number} threshold
 * @param {string} [key='score'] - Property name to check
 * @returns {Array} Items with score >= threshold
 */
export function filterByThreshold(items, threshold, key = 'score') {
  if (!Array.isArray(items)) return [];
  return items.filter(item => (item[key] || 0) >= threshold);
}

/**
 * Boolean signal scoring — award points if a condition is truthy.
 *
 * @param {*} value - Truthy check
 * @param {number} points - Points to award if truthy
 * @returns {number}
 */
export function booleanScore(value, points) {
  return value ? points : 0;
}

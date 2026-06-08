/**
 * Weighted random selection from an array of items.
 *
 * @param {Array} items - Array of objects to pick from
 * @param {function} weightFn - Function that returns the weight for an item (default: item => item.score)
 * @returns {*} The selected item, or null if no valid selection possible
 */
/**
 * Weighted random selection of N items without replacement.
 *
 * @param {Array} items - Array of objects to pick from
 * @param {number} count - Number of items to select
 * @param {function} weightFn - Function that returns the weight for an item (default: item => item.score)
 * @returns {Array} Array of selected items (may be shorter than count if not enough items)
 */
export function weightedPickN(items, count, weightFn = item => item.score) {
  if (!Array.isArray(items) || items.length === 0 || count <= 0) return [];

  const selected = [];
  const remaining = [...items];

  while (selected.length < count && remaining.length > 0) {
    const pick = weightedPick(remaining, weightFn);
    if (!pick) break;

    selected.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }

  return selected;
}

export function weightedPick(items, weightFn = item => item.score) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const weights = items.map(item => Math.max(0, weightFn(item)));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return items[0]; // fallback to first item if all weights are zero/negative

  let rand = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return items[i];
  }
  return items[items.length - 1]; // floating-point safety
}

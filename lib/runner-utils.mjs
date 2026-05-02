/**
 * runner-utils.mjs — Shared error-wrapper utilities for prehook runners.
 *
 * Eliminates duplicated safeRun/safeRunAsync across a-prehook-runner.mjs,
 * e-prehook-runner.mjs, r-prehook-runner.mjs, and b-prehook-runner.mjs.
 *
 * Created: wq-1001
 */

/**
 * Run a synchronous function with error wrapping.
 * @param {string} label - Human-readable label for error messages
 * @param {function} fn - Synchronous function to execute
 * @returns {{ ok: boolean, result?: any, error?: string }}
 */
export function safeRun(label, fn) {
  try {
    return { ok: true, result: fn() };
  } catch (e) {
    return { ok: false, error: `${label}: ${(e.message || 'unknown').slice(0, 200)}` };
  }
}

/**
 * Run an async function with error wrapping.
 * @param {string} label - Human-readable label for error messages
 * @param {function} fn - Async function to execute
 * @returns {Promise<{ ok: boolean, result?: any, error?: string }>}
 */
export async function safeRunAsync(label, fn) {
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    return { ok: false, error: `${label}: ${(e.message || 'unknown').slice(0, 200)}` };
  }
}

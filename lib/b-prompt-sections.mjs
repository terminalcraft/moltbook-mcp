// lib/b-prompt-sections.mjs — B session prompt block assembly.
// Extracted from heartbeat.sh (R#261) to complete the symmetric pattern:
// all 4 session types (R/A/E/B) now have JS-based prompt block builders.
// Previously B was the only mode with prompt assembly in bash (~50 lines).

import { join } from 'path';

/**
 * Build the complete B session prompt block.
 * @param {Object} ctx
 * @param {Object} ctx.fc - FileCache instance with .text() and .json() methods
 * @param {Object} ctx.PATHS - Centralized file paths (bCounter)
 * @param {Object} ctx.result - Shared result object with computed B session data
 * @returns {string} The assembled b_prompt_block string
 */
export function buildBPromptBlock(ctx) {
  const { fc, PATHS, result } = ctx;

  // B session counter (heartbeat.sh increments after session-context.mjs runs)
  let bCount = '?';
  try {
    const raw = parseInt((fc.text(PATHS.bCounter) || '').trim());
    bCount = isNaN(raw) ? 1 : raw + 1;
  } catch { bCount = 1; }

  // Capability line
  let capLine = '';
  if (result.capability_summary) {
    capLine = `\nCapabilities: ${result.capability_summary}. Live: ${result.live_platforms || 'none'}.`;
    if (result.cred_missing) {
      capLine += `\nWARN: Missing credential files: ${result.cred_missing}`;
    }
  }

  // EVM wallet line
  let evmLine = '';
  if (result.evm_balance_summary) {
    evmLine = `\nEVM wallet (Base): ${result.evm_balance_summary}. Onchain tasks: ${result.onchain_items || 'none'}.`;
  } else if (result.evm_balance_error) {
    evmLine = `\nEVM balance check failed: ${result.evm_balance_error}`;
  }

  // Task assignment block
  let wqBlock = '';
  const depth = result.pending_count || 0;
  const wqWarning = depth <= 1
    ? `\nWARNING: Work queue is nearly empty (${depth} items). After completing your task, consider adding new items from BRAINSTORMING.md or generating new ideas.`
    : '';

  if (result.wq_item && result.wq_fallback) {
    wqBlock = `

## YOUR ASSIGNED TASK (from brainstorming fallback — queue was empty):
${result.wq_item}

The work queue is empty. This idea was pulled from BRAINSTORMING.md. First, create a proper work-queue item for it (node work-queue.js add), then build it. Also add 2+ more queue items from brainstorming or new ideas to prevent future starvation.`;
  } else if (result.wq_item) {
    wqBlock = `

## YOUR ASSIGNED TASK (from work queue):
${result.wq_item}

This is your primary task for this session. Complete it before picking up anything else. If blocked, explain why in your session log.${wqWarning}`;
  }

  return `## B Session: #${bCount}${capLine}${evmLine}${wqBlock}`;
}

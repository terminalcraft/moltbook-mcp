#!/usr/bin/env node
/**
 * inline-intel-capture.mjs — Low-friction intel capture for E sessions
 *
 * WHY THIS EXISTS (wq-430):
 * d049 compliance dropped 80%→67%→50% because intel capture was deferred to
 * Phase 3b (post-engagement). Sessions that truncated or ran long never reached
 * Phase 3b. This script enables INLINE intel capture during Phase 2 — one call
 * per platform, immediately after engagement.
 *
 * DESIGN PRINCIPLES:
 * - 3 args, no JSON editing, no file reading required by the agent
 * - Appends to engagement-intel.json automatically
 * - "skip" keyword for platforms with no intel (satisfies gate without pollution)
 * - --count flag for the Phase 2 exit gate
 *
 * Usage:
 *   node inline-intel-capture.mjs <platform> "<summary>" "<actionable>"
 *   node inline-intel-capture.mjs <platform> "<summary>" "skip"
 *   node inline-intel-capture.mjs --count
 *
 * Examples:
 *   node inline-intel-capture.mjs chatr "Agent @Mo shared task routing API" "Evaluate api.mo.dev/tasks for integration"
 *   node inline-intel-capture.mjs 4claw "No new content" "skip"
 *   node inline-intel-capture.mjs --count
 *     → "Intel count: 3 (2 real, 1 skip)"
 *
 * Created: B#363 (wq-430) — inline gated intel capture redesign
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.config', 'moltbook');
const INTEL_FILE = join(CONFIG_DIR, 'engagement-intel.json');
const SESSION_NUM = process.env.SESSION_NUM || 'unknown';

function loadIntel() {
  try {
    const data = JSON.parse(readFileSync(INTEL_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveIntel(entries) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(INTEL_FILE, JSON.stringify(entries, null, 2) + '\n');
}

function showCount() {
  const entries = loadIntel();
  const real = entries.filter(e => !e.skip);
  const skips = entries.filter(e => e.skip);
  console.log(`Intel count: ${entries.length} (${real.length} real, ${skips.length} skip)`);
  if (real.length >= 1) {
    console.log('Phase 2 exit gate: PASS');
  } else if (entries.length > 0) {
    console.log('Phase 2 exit gate: WARN (only skip entries — try to capture real intel)');
  } else {
    console.log('Phase 2 exit gate: BLOCKED (0 entries — capture intel before proceeding)');
  }
  // Exit code: 0 if at least 1 entry, 1 if empty
  process.exit(entries.length > 0 ? 0 : 1);
}

function captureIntel(platform, summary, actionable) {
  const entries = loadIntel();

  if (actionable === 'skip') {
    // Skip entry — platform had nothing noteworthy
    entries.push({
      type: 'observation',
      source: platform,
      summary: summary,
      actionable: '',
      session: parseInt(SESSION_NUM) || 0,
      skip: true,
      inline: true
    });
    saveIntel(entries);
    console.log(`intel-inline: skip entry for ${platform} (s${SESSION_NUM})`);
    return;
  }

  // Validate actionable starts with imperative verb
  const imperativeVerbs = /^(Build|Create|Evaluate|Integrate|Test|Add|Implement|Deploy|Configure|Investigate|Review|Probe|Check|Monitor|Extend|Update|Fix|Port|Write|Run|Enable|Set up|Extract)/i;
  if (!imperativeVerbs.test(actionable)) {
    console.log(`WARNING: actionable should start with an imperative verb (Build, Evaluate, Integrate, etc.)`);
    console.log(`  Got: "${actionable.substring(0, 50)}..."`);
    console.log(`  Capturing anyway — enrich in Phase 3b if needed.`);
  }

  // Determine type based on actionable keywords
  let type = 'pattern';
  if (/integrat|endpoint|api|connect/i.test(actionable)) type = 'integration_target';
  if (/collaborat|partner|work with/i.test(actionable)) type = 'collaboration';
  if (/build|creat|implement|add/i.test(actionable)) type = 'tool_idea';

  entries.push({
    type,
    source: platform,
    summary: summary,
    actionable: actionable,
    session: parseInt(SESSION_NUM) || 0,
    inline: true
  });

  saveIntel(entries);
  const total = entries.filter(e => !e.skip).length;
  console.log(`intel-inline: captured ${type} from ${platform} (s${SESSION_NUM}, ${total} real entries total)`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage:');
    console.log('  node inline-intel-capture.mjs <platform> "<summary>" "<actionable>"');
    console.log('  node inline-intel-capture.mjs <platform> "<summary>" "skip"');
    console.log('  node inline-intel-capture.mjs --count');
    console.log('');
    console.log('Examples:');
    console.log('  node inline-intel-capture.mjs chatr "Mo shared API" "Evaluate api.mo.dev/tasks"');
    console.log('  node inline-intel-capture.mjs 4claw "No content" "skip"');
    process.exit(1);
  }

  if (args[0] === '--count') {
    showCount();
    return;
  }

  const [platform, summary, ...actionableParts] = args;
  const actionable = actionableParts.join(' ');

  if (!platform || !summary) {
    console.error('Error: platform and summary are required');
    console.error('Usage: node inline-intel-capture.mjs <platform> "<summary>" "<actionable>"');
    process.exit(1);
  }

  if (!actionable) {
    console.error('Error: actionable is required (use "skip" for empty platforms)');
    process.exit(1);
  }

  captureIntel(platform, summary, actionable);
}

main();

#!/usr/bin/env node
/**
 * e-intel-checkpoint.mjs — Write a minimal intel entry during Phase 2
 *
 * WHY THIS EXISTS (wq-399):
 * s1178 (E#100) was truncated during Phase 2 with 0 intel entries.
 * Intel is normally written in Phase 3b, after all engagement completes.
 * If a session truncates during Phase 2, intel is lost entirely.
 *
 * This script writes a minimal checkpoint intel entry DURING Phase 2,
 * after the first platform interaction. It only writes if engagement-intel.json
 * is empty ([] or missing). If intel already exists, it's a no-op.
 *
 * Usage:
 *   node e-intel-checkpoint.mjs <platform> <summary>
 *
 * Example:
 *   node e-intel-checkpoint.mjs chatr "Discussed agent coordination patterns with @Mo"
 *
 * The checkpoint entry uses type "pattern" and a generic actionable.
 * Phase 3b should replace or supplement this with higher-quality entries.
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

function main() {
  const [platform, ...summaryParts] = process.argv.slice(2);

  if (!platform) {
    console.log('Usage: node e-intel-checkpoint.mjs <platform> <summary>');
    console.log('Writes a minimal intel entry if engagement-intel.json is empty.');
    process.exit(1);
  }

  const existing = loadIntel();
  if (existing.length > 0) {
    console.log(`intel-checkpoint: skipped (${existing.length} entries already exist)`);
    return;
  }

  const summary = summaryParts.join(' ') || `Engagement on ${platform} (checkpoint — session may have truncated before Phase 3b)`;

  const entry = {
    type: 'pattern',
    source: `${platform} (Phase 2 checkpoint)`,
    summary,
    actionable: `Review ${platform} engagement from s${SESSION_NUM} and capture detailed intel in next E session`,
    session: parseInt(SESSION_NUM) || 0,
    checkpoint: true
  };

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(INTEL_FILE, JSON.stringify([entry], null, 2) + '\n');
  console.log(`intel-checkpoint: wrote minimal entry for ${platform} (s${SESSION_NUM})`);
}

main();

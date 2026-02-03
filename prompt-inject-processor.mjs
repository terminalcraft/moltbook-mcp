#!/usr/bin/env node
/**
 * Prompt inject processor — handles manifest-driven prompt injection.
 * Extracts ~160 lines of bash/python from heartbeat.sh into testable JS.
 *
 * Usage:
 *   node prompt-inject-processor.mjs <mode> <session_num>
 *
 * Output: JSON object with:
 *   - blocks: concatenated inject content to append to prompt
 *   - applied: array of {file, action} for tracking
 *   - skipped_session: files skipped due to session type mismatch
 *   - skipped_missing: files skipped because not found
 *   - skipped_requires: files skipped due to unmet dependencies
 *
 * R#120: Extracted from heartbeat.sh for maintainability and testability.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = join(homedir(), '.config', 'moltbook');
const PROJECT_DIR = process.env.PROJECT_DIR || join(homedir(), 'moltbook-mcp');
const MANIFEST_FILE = join(PROJECT_DIR, 'prompt-inject.json');
const USAGE_FILE = join(STATE_DIR, 'logs', 'inject-usage.json');

function loadManifest() {
  if (!existsSync(MANIFEST_FILE)) {
    return { injections: [] };
  }
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, 'utf-8'));
  } catch (e) {
    console.error(`prompt-inject-processor: failed to parse manifest: ${e.message}`);
    return { injections: [] };
  }
}

function processInjections(mode, sessionNum) {
  const manifest = loadManifest();
  const injections = manifest.injections || [];

  // Sort by priority
  const sorted = [...injections].sort((a, b) => (a.priority || 999) - (b.priority || 999));

  const result = {
    blocks: '',
    applied: [],
    skipped_session: [],
    skipped_missing: [],
    skipped_requires: []
  };

  // Pass 1: Identify candidates (file exists + session matches)
  const candidates = new Map(); // file -> {action, requires}
  for (const inj of sorted) {
    const { file, action = 'keep', sessions = '', requires } = inj;

    // Session type filter
    if (sessions && !sessions.includes(mode)) {
      result.skipped_session.push(file);
      continue;
    }

    // File existence check
    const fpath = join(STATE_DIR, file);
    if (!existsSync(fpath)) {
      result.skipped_missing.push(file);
      continue;
    }

    // Normalize requires to array
    let reqArray = [];
    if (requires) {
      reqArray = Array.isArray(requires) ? requires : requires.split(',').map(s => s.trim()).filter(Boolean);
    }

    candidates.set(file, { action, requires: reqArray, path: fpath });
  }

  // Pass 2: Apply in priority order, checking dependencies
  const appliedSet = new Set();

  for (const inj of sorted) {
    const { file } = inj;
    const candidate = candidates.get(file);
    if (!candidate) continue; // Already skipped in pass 1

    // Check requires: all required injects must already be applied
    const { action, requires, path } = candidate;
    if (requires.length > 0) {
      const unmet = requires.filter(req => !appliedSet.has(req));
      if (unmet.length > 0) {
        result.skipped_requires.push(file);
        continue;
      }
    }

    // Apply inject
    try {
      const content = readFileSync(path, 'utf-8');
      result.blocks += '\n\n' + content;
      result.applied.push({ file, action });
      appliedSet.add(file);

      // Consume action: delete file after reading
      if (action === 'consume') {
        unlinkSync(path);
      }
    } catch (e) {
      console.error(`prompt-inject-processor: failed to read ${file}: ${e.message}`);
      result.skipped_missing.push(file);
    }
  }

  return result;
}

function writeUsageLog(mode, sessionNum, result) {
  const entry = {
    session: sessionNum,
    mode,
    ts: new Date().toISOString(),
    applied: result.applied,
    skipped_session: result.skipped_session,
    skipped_missing: result.skipped_missing,
    skipped_requires: result.skipped_requires
  };

  // Append to usage log
  try {
    let lines = [];
    if (existsSync(USAGE_FILE)) {
      lines = readFileSync(USAGE_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    }
    lines.push(JSON.stringify(entry));
    // Keep last 200 entries
    if (lines.length > 200) {
      lines = lines.slice(-200);
    }
    writeFileSync(USAGE_FILE, lines.join('\n') + '\n');
  } catch (e) {
    // Non-fatal
    console.error(`prompt-inject-processor: usage log write failed: ${e.message}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || 'B';
  const sessionNum = parseInt(args[1], 10) || 0;

  const result = processInjections(mode, sessionNum);
  writeUsageLog(mode, sessionNum, result);

  // Output JSON for heartbeat.sh to consume
  console.log(JSON.stringify(result));
}

main();

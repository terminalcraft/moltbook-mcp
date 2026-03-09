#!/usr/bin/env node
// session-snapshots.mjs — Snapshot ecosystem state + pattern metrics to JSONL
// Extracted from 22-session-snapshots.sh, now absorbed into 10-session-logging.sh (R#327→R#334, d074)
//
// Usage: node session-snapshots.mjs <base_dir> <session_num> [--eco-only|--pat-only]
// Env: PATTERNS_JSON — pre-fetched pattern data (skips curl if set)

import { readFileSync, appendFileSync } from 'fs';
import { join } from 'path';

function loadJSON(filepath) {
  try { return JSON.parse(readFileSync(filepath, 'utf-8')); } catch { return null; }
}

function ecosystemSnapshot(baseDir, session, outFile) {
  const services = loadJSON(join(baseDir, 'services.json'));
  const registry = loadJSON(join(baseDir, 'account-registry.json'));
  const ecomap = loadJSON(join(baseDir, 'ecosystem-map.json'));

  const svcList = services?.services || [];
  const accounts = Array.isArray(registry) ? registry : (registry?.accounts || []);
  const agents = ecomap?.agents || [];
  const molty = agents.find(a =>
    a.name === 'molty' || a.name === 'terminalcraft' || (a.url && a.url.includes('terminalcraft'))
  );

  const snap = {
    session,
    ts: new Date().toISOString(),
    platforms_known: svcList.length,
    platforms_evaluated: svcList.filter(s => s.status && s.status !== 'discovered').length,
    platforms_rejected: svcList.filter(s => s.status === 'rejected').length,
    platforms_with_creds: accounts.filter(a =>
      a.last_status === 'live' || a.last_status === 'creds_ok' || a.last_status === 'degraded'
    ).length,
    platforms_no_creds: accounts.filter(a => a.last_status === 'no_creds').length,
    agents_total: agents.length,
    agents_online: agents.filter(a => a.online).length,
    molty_rank: molty?.rank || null
  };

  appendFileSync(outFile, JSON.stringify(snap) + '\n');
  return snap;
}

function patternSnapshot(session, patternsJSON, outFile) {
  if (!patternsJSON) return null;

  let patterns;
  try {
    patterns = typeof patternsJSON === 'string' ? JSON.parse(patternsJSON) : patternsJSON;
  } catch { return null; }

  const snap = {
    session,
    ts: new Date().toISOString(),
    friction_signal: patterns.patterns?.hot_files?.friction_signal || 0,
    hot_files_count: patterns.patterns?.hot_files?.count || 0,
    build_stalls: patterns.patterns?.build_stalls?.recent_5_stalls || 0,
    repeated_tasks: patterns.patterns?.repeated_tasks?.count || 0,
    friction_items: (patterns.friction_signals || []).map(s => s.suggestion).slice(0, 3)
  };

  appendFileSync(outFile, JSON.stringify(snap) + '\n');
  return snap;
}

// CLI entry point
const args = process.argv.slice(2);
const baseDir = args[0];
const session = parseInt(args[1]) || 0;
const mode = args[2]; // --eco-only or --pat-only

if (!baseDir) {
  console.error('Usage: node session-snapshots.mjs <base_dir> <session_num> [--eco-only|--pat-only]');
  process.exit(1);
}

const stateDir = join(process.env.HOME || '/home/moltbot', '.config/moltbook');
const ecoOut = join(stateDir, 'ecosystem-snapshots.jsonl');
const patOut = join(stateDir, 'patterns-history.jsonl');

if (mode !== '--pat-only') {
  ecosystemSnapshot(baseDir, session, ecoOut);
}

if (mode !== '--eco-only') {
  const patternsJSON = process.env.PATTERNS_JSON || null;
  if (patternsJSON) {
    patternSnapshot(session, patternsJSON, patOut);
  }
}

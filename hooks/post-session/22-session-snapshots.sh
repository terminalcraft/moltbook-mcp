#!/bin/bash
# 22-session-snapshots.sh — Snapshot ecosystem state + pattern metrics to JSONL
#
# Consolidated from 22-ecosystem-snapshot.sh + 23-pattern-snapshot.sh
# Both append one JSONL line per session. Combined for d070 hook reduction.
#
# Expects env: SESSION_NUM
# Created: B#493 (wq-744, d070)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
ECO_OUT="$HOME/.config/moltbook/ecosystem-snapshots.jsonl"
PAT_OUT="$HOME/.config/moltbook/patterns-history.jsonl"

# --- Ecosystem snapshot ---
node -e "
const fs = require('fs');
const path = require('path');
const base = process.argv[1];
const session = parseInt(process.argv[2]) || 0;
const outFile = process.argv[3];

function loadJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return null; }
}

const services = loadJSON(path.join(base, 'services.json'));
const registry = loadJSON(path.join(base, 'account-registry.json'));
const ecomap = loadJSON(path.join(base, 'ecosystem-map.json'));

const svcList = services?.services || [];
const platforms_known = svcList.length;
const platforms_evaluated = svcList.filter(s => s.status && s.status !== 'discovered').length;
const platforms_rejected = svcList.filter(s => s.status === 'rejected').length;

const accounts = Array.isArray(registry) ? registry : (registry?.accounts || []);
const platforms_with_creds = accounts.filter(a => a.last_status === 'live' || a.last_status === 'creds_ok' || a.last_status === 'degraded').length;
const platforms_no_creds = accounts.filter(a => a.last_status === 'no_creds').length;

const agents = ecomap?.agents || [];
const agents_total = agents.length;
const agents_online = agents.filter(a => a.online).length;
const molty = agents.find(a => a.name === 'molty' || a.name === 'terminalcraft' || (a.url && a.url.includes('terminalcraft')));
const molty_rank = molty?.rank || null;

const snap = {
  session,
  ts: new Date().toISOString(),
  platforms_known,
  platforms_evaluated,
  platforms_rejected,
  platforms_with_creds,
  platforms_no_creds,
  agents_total,
  agents_online,
  molty_rank
};

fs.appendFileSync(outFile, JSON.stringify(snap) + '\n');
" "$DIR" "${SESSION_NUM:-0}" "$ECO_OUT"

# --- Pattern snapshot ---
PATTERNS=$(curl -s --max-time 5 http://localhost:3847/status/patterns 2>/dev/null) || true
if [ -n "$PATTERNS" ]; then
  node -e "
const session = parseInt(process.argv[1]) || 0;
const out = process.argv[2];
const patterns = JSON.parse(process.argv[3]);

const snap = {
  session,
  ts: new Date().toISOString(),
  friction_signal: patterns.patterns?.hot_files?.friction_signal || 0,
  hot_files_count: patterns.patterns?.hot_files?.count || 0,
  build_stalls: patterns.patterns?.build_stalls?.recent_5_stalls || 0,
  repeated_tasks: patterns.patterns?.repeated_tasks?.count || 0,
  friction_items: (patterns.friction_signals || []).map(s => s.suggestion).slice(0, 3)
};

require('fs').appendFileSync(out, JSON.stringify(snap) + '\n');
" "${SESSION_NUM:-0}" "$PAT_OUT" "$PATTERNS"
fi

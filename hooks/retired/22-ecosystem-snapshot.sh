#!/bin/bash
# Post-session hook: snapshot ecosystem state for timeline tracking.
# Appends one JSONL line per session with platform/agent counts.
# Expects env: SESSION_NUM

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="/home/moltbot/.config/moltbook/ecosystem-snapshots.jsonl"

node -e "
const fs = require('fs');
const path = require('path');
const base = process.argv[1];
const session = process.argv[2];
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
  session: parseInt(session) || 0,
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
" "$DIR" "${SESSION_NUM:-0}" "$OUT"

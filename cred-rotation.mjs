#!/usr/bin/env node
// cred-rotation.mjs — Credential rotation management CLI
// Usage: node cred-rotation.mjs [status|mark-rotated <id>|stale]
//
// Reads account-registry.json for platform list, cred-rotation.json for state.
// Provides credential health overview and rotation tracking.

import { readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HOME = homedir();
const MCP_DIR = join(HOME, 'moltbook-mcp');
const STATE_DIR = join(HOME, '.config', 'moltbook');
const ROTATION_FILE = join(STATE_DIR, 'cred-rotation.json');
const REGISTRY_FILE = join(MCP_DIR, 'account-registry.json');
const MAX_AGE_DAYS = 90;

function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function expandPath(p) {
  return p.replace(/^~/, HOME);
}

function daysSince(isoOrEpoch) {
  const d = typeof isoOrEpoch === 'number' ? new Date(isoOrEpoch * 1000) : new Date(isoOrEpoch);
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function getRotationData() {
  const rot = loadJSON(ROTATION_FILE) || { credentials: {} };
  const registry = loadJSON(REGISTRY_FILE) || { accounts: [] };

  // Sync registry accounts into rotation tracking
  for (const acct of registry.accounts) {
    const id = acct.id;
    const credPath = expandPath(acct.cred_file || '');
    if (!rot.credentials[id]) {
      rot.credentials[id] = { path: credPath, last_rotated: null, first_seen: null };
    } else {
      rot.credentials[id].path = credPath;
    }
  }

  return rot;
}

function getCredStatus(info) {
  const path = expandPath(info.path || '');
  if (!existsSync(path)) return { status: 'missing', age: null };

  let rotDate;
  if (info.last_rotated) {
    rotDate = new Date(info.last_rotated);
  } else {
    const stat = statSync(path);
    rotDate = stat.mtime;
  }

  const age = Math.floor((Date.now() - rotDate.getTime()) / 86400000);
  const status = age > MAX_AGE_DAYS ? 'stale' : 'ok';
  return { status, age, rotDate: rotDate.toISOString().split('T')[0] };
}

function cmdStatus() {
  const rot = getRotationData();
  const entries = Object.entries(rot.credentials);

  console.log(`Credential rotation status (${entries.length} tracked, max ${MAX_AGE_DAYS}d)\n`);
  console.log('ID'.padEnd(16) + 'STATUS'.padEnd(10) + 'AGE'.padEnd(8) + 'LAST ROTATED');
  console.log('-'.repeat(50));

  let staleCount = 0, okCount = 0, missingCount = 0;
  for (const [id, info] of entries) {
    const { status, age, rotDate } = getCredStatus(info);
    const ageStr = age !== null && age !== undefined ? `${age}d` : '-';
    const dateStr = rotDate || '-';
    const flag = status === 'stale' ? '⚠' : status === 'missing' ? '?' : '✓';
    console.log(`${flag} ${id.padEnd(14)} ${status.padEnd(10)} ${ageStr.padEnd(8)} ${dateStr}`);
    if (status === 'stale') staleCount++;
    else if (status === 'missing') missingCount++;
    else okCount++;
  }

  console.log(`\nSummary: ${okCount} ok, ${staleCount} stale, ${missingCount} missing`);
  return { staleCount, okCount, missingCount, total: entries.length };
}

function verifyCredential(id) {
  const registry = loadJSON(REGISTRY_FILE);
  if (!registry) { console.log('  ⚠ No account-registry.json — skipping verification'); return null; }
  const account = registry.accounts.find(a => a.id === id);
  if (!account) { console.log(`  ⚠ No registry entry for "${id}" — skipping verification`); return null; }

  console.log(`  Testing ${id} credential...`);
  try {
    const out = execSync(`node "${join(__dirname, 'account-manager.mjs')}" json`, {
      timeout: 15000, encoding: 'utf8'
    });
    const results = JSON.parse(out);
    const result = results.find(r => r.id === id);
    if (!result) { console.log('  ⚠ Account not found in test results'); return null; }

    if (result.status === 'live' || result.status === 'creds_ok') {
      console.log(`  ✓ Credential verified: ${result.status}${result.http ? ` (HTTP ${result.http})` : ''}`);
      return true;
    } else {
      console.error(`  ✗ Credential FAILED: ${result.status}${result.http ? ` (HTTP ${result.http})` : ''}${result.error ? ` — ${result.error}` : ''}`);
      return false;
    }
  } catch (e) {
    console.error(`  ⚠ Verification error: ${e.message?.slice(0, 100)}`);
    return null;
  }
}

function cmdMarkRotated(id) {
  const rot = getRotationData();
  if (!rot.credentials[id]) {
    console.error(`Unknown credential: ${id}`);
    console.error(`Known: ${Object.keys(rot.credentials).join(', ')}`);
    process.exit(1);
  }
  const now = new Date().toISOString();
  rot.credentials[id].last_rotated = now;

  // Auto-verify the credential works
  const verified = verifyCredential(id);
  rot.credentials[id].last_verified = verified === true ? now : null;
  rot.credentials[id].last_verify_status = verified === true ? 'ok' : verified === false ? 'failed' : 'skipped';

  writeFileSync(ROTATION_FILE, JSON.stringify(rot, null, 2) + '\n');
  console.log(`Marked ${id} as rotated at ${now}`);
  if (verified === false) {
    console.error('WARNING: Credential was marked rotated but verification FAILED. Check the credential.');
    process.exit(2);
  }
}

function cmdStale() {
  const rot = getRotationData();
  const stale = [];
  for (const [id, info] of Object.entries(rot.credentials)) {
    const { status, age } = getCredStatus(info);
    if (status === 'stale') stale.push({ id, age });
  }
  if (stale.length === 0) {
    console.log('No stale credentials.');
  } else {
    console.log(`${stale.length} stale credential(s):`);
    for (const s of stale) console.log(`  - ${s.id}: ${s.age}d old`);
  }
  return stale;
}

// JSON output for MCP tool consumption
function cmdJSON() {
  const rot = getRotationData();
  const result = { max_age_days: MAX_AGE_DAYS, credentials: [] };
  for (const [id, info] of Object.entries(rot.credentials)) {
    const { status, age, rotDate } = getCredStatus(info);
    result.credentials.push({ id, status, age_days: age, last_rotated: rotDate || null });
  }
  result.summary = {
    total: result.credentials.length,
    ok: result.credentials.filter(c => c.status === 'ok').length,
    stale: result.credentials.filter(c => c.status === 'stale').length,
    missing: result.credentials.filter(c => c.status === 'missing').length,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'mark-rotated': cmdMarkRotated(args[0]); break;
  case 'stale': cmdStale(); break;
  case 'json': cmdJSON(); break;
  case 'status': default: cmdStatus(); break;
}

#!/usr/bin/env node
// cred-reconcile.mjs — Reconcile credential files with account-registry.json
//
// Extracted from 21-cred-reconcile.sh (R#325).
// Finds *-credentials.json files with no matching registry entry and adds them.
//
// Usage (CLI):
//   node cred-reconcile.mjs <base-dir> <session-num>
//
// Usage (import):
//   import { reconcile } from './cred-reconcile.mjs';
//   reconcile({ baseDir, session, deps });

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function reconcile({ baseDir, session, deps = {} }) {
  const _readFileSync = deps.readFileSync || readFileSync;
  const _writeFileSync = deps.writeFileSync || writeFileSync;
  const _readdirSync = deps.readdirSync || readdirSync;

  const regPath = join(baseDir, 'account-registry.json');
  let reg;
  try { reg = JSON.parse(_readFileSync(regPath, 'utf-8')); } catch { return { added: 0 }; }
  if (!reg.accounts) return { added: 0 };

  // Build set of known cred_file basenames
  const knownFiles = new Set();
  for (const a of reg.accounts) {
    const cf = (a.cred_file || '').replace('~/', '').replace('moltbook-mcp/', '');
    if (cf) knownFiles.add(cf);
    knownFiles.add(normalize(a.platform) + '-credentials.json');
    if (a.id) knownFiles.add(a.id.toLowerCase() + '-credentials.json');
  }

  // Scan for credential files
  const credFiles = _readdirSync(baseDir).filter(f => f.endsWith('-credentials.json'));
  let added = 0;
  const newEntries = [];

  for (const cf of credFiles) {
    const name = cf.replace('-credentials.json', '');
    const nameNorm = normalize(name);

    // Check if already tracked
    let found = false;
    for (const a of reg.accounts) {
      if (normalize(a.platform) === nameNorm || normalize(a.id) === nameNorm) { found = true; break; }
      if ((a.cred_file || '').includes(cf)) { found = true; break; }
    }
    if (found) continue;

    // Read cred file to extract handle
    let creds;
    try { creds = JSON.parse(_readFileSync(join(baseDir, cf), 'utf-8')); } catch { continue; }
    const handle = creds.handle || creds.username || creds.name || creds.agent_id || 'moltbook';
    const apiKey = creds.api_key || creds.apiKey || creds.token || creds.private_key_b64;

    // Determine platform name from cred file or creds
    const platform = creds.platform || name.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

    const entry = {
      id: name,
      platform,
      tier: 3,
      auth_type: apiKey ? 'api_key' : 'unknown',
      cred_file: '~/moltbook-mcp/' + cf,
      cred_key: creds.api_key ? 'api_key' : creds.apiKey ? 'apiKey' : creds.token ? 'token' : 'api_key',
      test: { method: 'file_exists', expect: 'cred_file_present' },
      handle: String(handle),
      notes: 'Auto-added by cred-reconcile hook s' + session,
      last_status: 'untested',
      last_tested: null,
    };

    reg.accounts.push(entry);
    newEntries.push(entry);
    added++;
  }

  if (added > 0) {
    _writeFileSync(regPath, JSON.stringify(reg, null, 2));
  }

  return { added, newEntries };
}

// CLI mode
const args = process.argv.slice(2);
if (args.length >= 1) {
  const baseDir = args[0];
  const session = args[1] || '0';
  const result = reconcile({ baseDir, session });
  if (result.added > 0) {
    console.log(`cred-reconcile: added ${result.added} new registry entries`);
  }
}

#!/bin/bash
# Post-session hook: reconcile credential files with account-registry.json.
# Finds *-credentials.json files that have no matching registry entry and adds them.
# Expects env: SESSION_NUM

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"

node -e "
const fs = require('fs');
const path = require('path');
const base = process.argv[1];
const session = process.argv[2];

const regPath = path.join(base, 'account-registry.json');
let reg;
try { reg = JSON.parse(fs.readFileSync(regPath, 'utf-8')); } catch { process.exit(0); }
if (!reg.accounts) process.exit(0);

// Build set of known cred_file basenames
const knownFiles = new Set();
for (const a of reg.accounts) {
  const cf = (a.cred_file || '').replace('~/', '').replace('moltbook-mcp/', '');
  if (cf) knownFiles.add(cf);
  // also add by platform name pattern
  knownFiles.add(a.platform.toLowerCase().replace(/[^a-z0-9]/g, '') + '-credentials.json');
  if (a.id) knownFiles.add(a.id.toLowerCase() + '-credentials.json');
}

// Scan for credential files
const credFiles = fs.readdirSync(base).filter(f => f.endsWith('-credentials.json'));
let added = 0;

for (const cf of credFiles) {
  const name = cf.replace('-credentials.json', '');

  // Check if already tracked
  const nameNorm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  let found = false;
  for (const a of reg.accounts) {
    const platNorm = a.platform.toLowerCase().replace(/[^a-z0-9]/g, '');
    const idNorm = (a.id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (platNorm === nameNorm || idNorm === nameNorm) { found = true; break; }
    // Check if cred_file matches
    if ((a.cred_file || '').includes(cf)) { found = true; break; }
  }
  if (found) continue;

  // Read cred file to extract handle
  let creds;
  try { creds = JSON.parse(fs.readFileSync(path.join(base, cf), 'utf-8')); } catch { continue; }
  const handle = creds.handle || creds.username || creds.name || creds.agent_id || 'moltbook';
  const apiKey = creds.api_key || creds.apiKey || creds.token || creds.private_key_b64;

  // Determine platform name from cred file or creds
  const platform = creds.platform || name.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

  const entry = {
    id: name,
    platform: platform,
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
  added++;
}

if (added > 0) {
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  console.log('cred-reconcile: added ' + added + ' new registry entries');
}
" "$DIR" "${SESSION_NUM:-0}"

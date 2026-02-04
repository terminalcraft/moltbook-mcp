#!/usr/bin/env node
/**
 * cred-audit.mjs — Credential path audit tool
 *
 * Shows expected vs actual credential paths per platform,
 * highlighting mismatches between account-registry.json and
 * providers/credentials.js hardcoded paths.
 *
 * Usage:
 *   node cred-audit.mjs              # Full audit report
 *   node cred-audit.mjs json         # Machine-readable JSON
 *   node cred-audit.mjs --fix        # Show suggested fixes for mismatches
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const MCP_DIR = join(HOME, 'moltbook-mcp');

function expandPath(p) {
  if (!p) return null;
  return p.replace(/^~/, HOME);
}

function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Registry: what account-registry.json says
function getRegistryPaths() {
  const reg = loadJSON(join(MCP_DIR, 'account-registry.json'));
  if (!reg) return [];
  return reg.accounts.map(a => ({
    id: a.id,
    platform: a.platform,
    cred_file: a.cred_file,
    cred_key: a.cred_key,
    auth_type: a.auth_type,
    expanded: expandPath(a.cred_file),
  }));
}

// Provider: what credentials.js actually resolves
// IDs must match account-registry.json IDs for proper matching
function getProviderPaths() {
  const home = HOME;
  return [
    { id: 'ctxly', fn: 'getCtxlyKey', env: 'CTXLY_API_KEY', path: join(home, 'moltbook-mcp', 'ctxly.json'), key: 'api_key' },
    { id: 'chatr', fn: 'getChatrCredentials', env: null, path: join(home, 'moltbook-mcp', 'chatr-credentials.json'), key: null },
    { id: '4claw', fn: 'getFourclawCredentials', env: null, path: join(home, 'moltbook-mcp', 'fourclaw-credentials.json'), key: null },
    { id: 'lobchan', fn: 'getLobchanKey', env: null, path: join(home, 'moltbook-mcp', '.lobchan-key'), key: null },
    { id: 'moltbotden', fn: 'getMoltbotdenKey', env: 'MOLTBOTDEN_API_KEY', path: join(home, 'moltbook-mcp', '.moltbotden-key'), key: null },
  ];
}

// Rotation state: what cred-rotation.json tracks
function getRotationPaths() {
  const rot = loadJSON(join(HOME, '.config', 'moltbook', 'cred-rotation.json'));
  if (!rot || !rot.credentials) return {};
  const result = {};
  for (const [id, info] of Object.entries(rot.credentials)) {
    result[id] = { path: info.path ? expandPath(info.path) : null };
  }
  return result;
}

function fileInfo(path) {
  if (!path || !existsSync(path)) return { exists: false };
  try {
    const stat = statSync(path);
    return { exists: true, size: stat.size, mtime: stat.mtime.toISOString().split('T')[0] };
  } catch { return { exists: false }; }
}

function audit() {
  const registry = getRegistryPaths();
  const providers = getProviderPaths();
  const rotation = getRotationPaths();

  const results = [];

  // Audit each registry entry
  for (const reg of registry) {
    const entry = {
      id: reg.id,
      platform: reg.platform,
      auth_type: reg.auth_type,
      registry_path: reg.cred_file,
      registry_expanded: reg.expanded,
      registry_key: reg.cred_key,
      provider_path: null,
      provider_key: null,
      provider_env: null,
      rotation_path: null,
      file: fileInfo(reg.expanded),
      issues: [],
    };

    // Find matching provider entry
    const prov = providers.find(p => p.id === reg.id);
    if (prov) {
      entry.provider_path = prov.path;
      entry.provider_key = prov.key;
      entry.provider_env = prov.env;

      // Check path mismatch
      if (prov.path !== reg.expanded) {
        entry.issues.push(`PATH_MISMATCH: registry=${reg.expanded} provider=${prov.path}`);
      }
      // Check key mismatch
      if (prov.key && reg.cred_key && prov.key !== reg.cred_key) {
        entry.issues.push(`KEY_MISMATCH: registry=${reg.cred_key} provider=${prov.key}`);
      }
    }

    // Check rotation tracking
    const rot = rotation[reg.id];
    if (rot) {
      entry.rotation_path = rot.path;
      if (rot.path && rot.path !== reg.expanded) {
        entry.issues.push(`ROTATION_DRIFT: rotation=${rot.path} registry=${reg.expanded}`);
      }
    }

    // File issues
    if (!entry.file.exists) {
      entry.issues.push('FILE_MISSING');
    }

    results.push(entry);
  }

  // Check for provider entries with no registry match
  for (const prov of providers) {
    if (!registry.find(r => r.id === prov.id)) {
      results.push({
        id: prov.id,
        platform: `(provider only: ${prov.fn})`,
        auth_type: null,
        registry_path: null,
        registry_expanded: null,
        provider_path: prov.path,
        provider_key: prov.key,
        provider_env: prov.env,
        rotation_path: null,
        file: fileInfo(prov.path),
        issues: ['NO_REGISTRY_ENTRY'],
      });
    }
  }

  return results;
}

function printReport(results) {
  const totalIssues = results.reduce((n, r) => n + r.issues.length, 0);
  console.log(`Credential Audit — ${results.length} platforms, ${totalIssues} issue(s)\n`);

  for (const r of results) {
    const icon = r.issues.length === 0 ? '✓' : '⚠';
    console.log(`${icon} ${r.id} (${r.platform})`);
    console.log(`    Registry:  ${r.registry_path || '(none)'}`);
    if (r.provider_path) {
      console.log(`    Provider:  ${r.provider_path}`);
    }
    if (r.provider_env) {
      const envSet = process.env[r.provider_env] ? 'SET' : 'unset';
      console.log(`    Env var:   ${r.provider_env} [${envSet}]`);
    }
    if (r.rotation_path && r.rotation_path !== r.registry_expanded) {
      console.log(`    Rotation:  ${r.rotation_path}`);
    }
    console.log(`    File:      ${r.file.exists ? `exists (${r.file.size}b, ${r.file.mtime})` : 'MISSING'}`);
    for (const issue of r.issues) {
      console.log(`    ❌ ${issue}`);
    }
    console.log();
  }

  if (totalIssues === 0) {
    console.log('All credential paths consistent.');
  } else {
    console.log(`${totalIssues} issue(s) found. Run with --fix for suggestions.`);
  }
}

function printFixes(results) {
  const issues = results.filter(r => r.issues.length > 0);
  if (issues.length === 0) {
    console.log('No issues to fix.');
    return;
  }
  console.log('Suggested fixes:\n');
  for (const r of issues) {
    for (const issue of r.issues) {
      if (issue.startsWith('PATH_MISMATCH')) {
        console.log(`[${r.id}] Update providers/credentials.js to use path from registry:`);
        console.log(`  Expected: ${r.registry_expanded}`);
        console.log(`  Actual:   ${r.provider_path}\n`);
      } else if (issue.startsWith('KEY_MISMATCH')) {
        console.log(`[${r.id}] Credential key differs between registry and provider:`);
        console.log(`  Registry: ${r.registry_key}  Provider: ${r.provider_key}\n`);
      } else if (issue === 'FILE_MISSING') {
        console.log(`[${r.id}] Credential file not found: ${r.registry_expanded || r.provider_path}`);
        console.log(`  Create the file or update the path in account-registry.json\n`);
      } else if (issue === 'NO_REGISTRY_ENTRY') {
        console.log(`[${r.id}] Provider function ${r.platform} has no account-registry.json entry.`);
        console.log(`  Add an entry or remove the dead provider function.\n`);
      } else if (issue.startsWith('ROTATION_DRIFT')) {
        console.log(`[${r.id}] Rotation tracking path differs from registry.`);
        console.log(`  Run: node cred-rotation.mjs status (auto-syncs from registry)\n`);
      }
    }
  }
}

const cmd = process.argv[2];
const results = audit();

if (cmd === 'json') {
  console.log(JSON.stringify(results, null, 2));
} else if (cmd === '--fix') {
  printFixes(results);
} else {
  printReport(results);
}

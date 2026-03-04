#!/usr/bin/env node
// credential-health-check.mjs — Validate platform credentials for E session prehook (d072)
//
// Reads account-registry.json, checks each live platform's credential file for:
//   1. File existence
//   2. Valid JSON with required key field
//   3. No placeholder values
//   4. JWT expiry (for bearer/jwt auth types)
//
// Usage: node credential-health-check.mjs [--json] [--platform <id>]
// Import: import { checkAllCredentials } from './credential-health-check.mjs'

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const HOME = process.env.HOME || '/home/moltbot';
const BASE = resolve(HOME, 'moltbook-mcp');
const REGISTRY = resolve(BASE, 'account-registry.json');

const PLACEHOLDER_PATTERNS = [
  'test-api-key', 'YOUR_API_KEY', 'placeholder', 'changeme',
  'xxx', 'TODO', 'REPLACE_ME'
];

function resolveCredPath(credFile) {
  if (!credFile) return null;
  return credFile.replace(/^~/, HOME);
}

function decodeJwtExpiry(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    const data = JSON.parse(payload);
    return data.exp || null;
  } catch {
    return null;
  }
}

function checkCredential(account) {
  const result = {
    id: account.id,
    status: 'unknown',
    auth_type: account.auth_type || 'unknown',
    details: null
  };

  // No credentials needed
  if (account.auth_type === 'none' || !account.cred_file) {
    result.status = 'ok';
    result.details = 'no credentials required';
    return result;
  }

  const credPath = resolveCredPath(account.cred_file);
  if (!credPath) {
    result.status = 'error';
    result.details = 'no credential file configured';
    return result;
  }

  // File existence
  if (!existsSync(credPath)) {
    result.status = 'missing';
    result.details = `credential file not found: ${account.cred_file}`;
    return result;
  }

  // Read and parse
  let content, parsed;
  try {
    content = readFileSync(credPath, 'utf8').trim();
  } catch (e) {
    result.status = 'error';
    result.details = `read error: ${e.message.slice(0, 80)}`;
    return result;
  }

  // Check for placeholders in raw content
  const lowerContent = content.toLowerCase();
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (lowerContent.includes(pattern.toLowerCase())) {
      result.status = 'placeholder';
      result.details = `contains placeholder value matching '${pattern}'`;
      return result;
    }
  }

  // For non-JSON files (bearer token files like .moltchan-key)
  if (!credPath.endsWith('.json')) {
    if (content.length < 8) {
      result.status = 'suspicious';
      result.details = 'credential value too short (<8 chars)';
      return result;
    }
    // Check JWT expiry for bearer tokens
    const exp = decodeJwtExpiry(content);
    if (exp) {
      const now = Math.floor(Date.now() / 1000);
      const remaining = exp - now;
      if (remaining < 0) {
        result.status = 'expired';
        result.details = `JWT expired ${Math.abs(remaining)}s ago`;
        return result;
      }
      if (remaining < 3600) {
        result.status = 'expiring';
        result.details = `JWT expires in ${remaining}s (<1h)`;
        return result;
      }
      result.details = `JWT valid (${remaining}s remaining)`;
    } else {
      result.details = 'bearer token present';
    }
    result.status = 'ok';
    return result;
  }

  // Parse JSON credential files
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    result.status = 'error';
    result.details = `JSON parse error: ${e.message.slice(0, 80)}`;
    return result;
  }

  // Check required key field
  if (account.cred_key) {
    const val = parsed[account.cred_key];
    if (!val || val === '') {
      result.status = 'empty';
      result.details = `required field '${account.cred_key}' is empty`;
      return result;
    }
  }

  // Check for JWT fields in JSON credentials
  const jwtFields = ['jwt', 'token', 'access_token'];
  for (const field of jwtFields) {
    if (parsed[field]) {
      const exp = decodeJwtExpiry(parsed[field]);
      if (exp) {
        const now = Math.floor(Date.now() / 1000);
        const remaining = exp - now;
        if (remaining < 0) {
          result.status = 'expired';
          result.details = `${field} expired ${Math.abs(remaining)}s ago`;
          return result;
        }
        if (remaining < 3600) {
          result.status = 'expiring';
          result.details = `${field} expires in ${remaining}s (<1h)`;
          return result;
        }
        result.details = `${field} valid (${remaining}s remaining)`;
        result.status = 'ok';
        return result;
      }
    }
  }

  result.status = 'ok';
  result.details = 'credentials present and valid';
  return result;
}

export function checkAllCredentials({ registryPath, platformFilter } = {}) {
  const regPath = registryPath || REGISTRY;
  if (!existsSync(regPath)) {
    return { error: 'account-registry.json not found', results: [] };
  }

  const registry = JSON.parse(readFileSync(regPath, 'utf8'));
  let accounts = registry.accounts.filter(a => a.status === 'live' || a.status === 'active');

  if (platformFilter) {
    accounts = accounts.filter(a => a.id === platformFilter);
  }

  const results = accounts.map(checkCredential);
  const healthy = results.filter(r => r.status === 'ok').length;
  const warnings = results.filter(r => r.status !== 'ok');

  return {
    total: results.length,
    healthy,
    unhealthy: warnings.length,
    results,
    warnings: warnings.length > 0 ? warnings : null
  };
}

// CLI mode
if (process.argv[1]?.endsWith('credential-health-check.mjs')) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const platformIdx = args.indexOf('--platform');
  const platformFilter = platformIdx >= 0 ? args[platformIdx + 1] : undefined;

  const report = checkAllCredentials({ platformFilter });

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Credential health: ${report.healthy}/${report.total} platforms OK`);
    if (report.warnings) {
      console.log('\nWarnings:');
      for (const w of report.warnings) {
        console.log(`  ${w.id}: [${w.status}] ${w.details}`);
      }
    }
  }
}

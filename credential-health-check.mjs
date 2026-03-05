#!/usr/bin/env node
// credential-health-check.mjs — Validate platform credentials for E session prehook (d072)
//
// Reads account-registry.json, checks each live platform's credential file for:
//   1. File existence
//   2. Valid JSON with required key field
//   3. No placeholder values
//   4. JWT expiry (for bearer/jwt auth types)
//
// Usage: node credential-health-check.mjs [--json] [--platform <id>] [--live]
// Import: import { checkAllCredentials, checkAllCredentialsLive } from './credential-health-check.mjs'

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { safeFetch } from './lib/safe-fetch.mjs';

const HOME = process.env.HOME || '/home/moltbot';
const BASE = resolve(HOME, 'moltbook-mcp');
const REGISTRY = resolve(BASE, 'account-registry.json');

const PLACEHOLDER_PATTERNS = [
  'test-api-key', 'YOUR_API_KEY', 'placeholder', 'changeme',
  'xxx', 'TODO', 'REPLACE_ME'
];

const CONSECUTIVE_FAILURE_THRESHOLD = 2;
const STATE_PATH = resolve(HOME, '.config/moltbook/credential-health-state.json');

function loadFailureState(statePath) {
  try { return JSON.parse(readFileSync(statePath || STATE_PATH, 'utf8')); }
  catch { return {}; }
}

function saveFailureState(state, statePath) {
  writeFileSync(statePath || STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

export function updateFailureState(platformId, failed, state, session) {
  if (!state[platformId]) state[platformId] = { consecutive_failures: 0, last_session: null };
  const entry = state[platformId];
  if (failed) {
    // Only increment if this is a different session than last recorded
    if (entry.last_session !== session) {
      entry.consecutive_failures++;
      entry.last_session = session;
    }
  } else {
    entry.consecutive_failures = 0;
    entry.last_session = session;
  }
  return entry;
}

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

function readCredValue(account) {
  const credPath = resolveCredPath(account.cred_file);
  if (!credPath || !existsSync(credPath)) return null;
  try {
    const raw = readFileSync(credPath, 'utf8').trim();
    if (account.cred_key) {
      return JSON.parse(raw)[account.cred_key];
    }
    try { return JSON.parse(raw); } catch { return raw; }
  } catch { return null; }
}

function getAuthHeaders(account, cred) {
  if (!cred) return {};
  const token = typeof cred === 'string' ? cred : cred.token || cred.api_key || cred.apiKey || null;
  if (!token || !account.test?.auth) return {};
  if (account.test.auth === 'raw_header') return { Authorization: token };
  if (account.test.auth === 'bearer') return { Authorization: `Bearer ${token}` };
  if (account.test.auth === 'x-api-key') return { 'x-api-key': token };
  return {};
}

async function checkLiveAuth(account, deps = {}) {
  const fetch = deps.safeFetch || safeFetch;
  const result = {
    id: account.id,
    live_status: 'skipped',
    http_status: null,
    elapsed_ms: null,
    details: null
  };

  // Skip MCP-only platforms (no HTTP test endpoint)
  if (!account.test || account.test.method === 'mcp') {
    result.details = 'MCP-only, no HTTP endpoint';
    return result;
  }

  // Skip platforms without test URL
  if (!account.test.url) {
    result.details = 'no test URL configured';
    return result;
  }

  // Build request
  const cred = readCredValue(account);
  const headers = getAuthHeaders(account, cred);
  const url = account.test.url;

  try {
    const resp = await fetch(url, {
      method: account.test.http_method || 'GET',
      headers,
      timeout: 8000,
    });

    result.http_status = resp.status;
    result.elapsed_ms = resp.elapsed;

    if (resp.error) {
      result.live_status = 'timeout';
      result.details = resp.error;
    } else if (resp.status >= 200 && resp.status < 300) {
      result.live_status = 'ok';
      result.details = `HTTP ${resp.status}`;
    } else if (resp.status === 401 || resp.status === 403) {
      result.live_status = 'auth_fail';
      result.details = `HTTP ${resp.status} — credentials rejected`;
    } else if (resp.status >= 500) {
      result.live_status = 'server_error';
      result.details = `HTTP ${resp.status}`;
    } else {
      result.live_status = 'unexpected';
      result.details = `HTTP ${resp.status}`;
    }
  } catch (e) {
    result.live_status = 'timeout';
    result.details = e.message?.slice(0, 80) || 'unknown error';
  }

  return result;
}

export async function checkAllCredentialsLive({ registryPath, platformFilter, safeFetch: fetchOverride } = {}) {
  const regPath = registryPath || REGISTRY;
  if (!existsSync(regPath)) {
    return { error: 'account-registry.json not found', results: [] };
  }

  const registry = JSON.parse(readFileSync(regPath, 'utf8'));
  let accounts = registry.accounts.filter(a => a.status === 'live' || a.status === 'active');

  if (platformFilter) {
    accounts = accounts.filter(a => a.id === platformFilter);
  }

  // Filter to HTTP-testable accounts only
  const httpAccounts = accounts.filter(a => a.test?.method === 'http' && a.test?.url);
  const deps = fetchOverride ? { safeFetch: fetchOverride } : {};

  // Sequential with 1s delay for rate limiting
  const results = [];
  for (let i = 0; i < httpAccounts.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000));
    results.push(await checkLiveAuth(httpAccounts[i], deps));
  }

  const ok = results.filter(r => r.live_status === 'ok').length;
  const authFail = results.filter(r => r.live_status === 'auth_fail').length;
  const serverErr = results.filter(r => r.live_status === 'server_error').length;
  const timeouts = results.filter(r => r.live_status === 'timeout').length;

  return {
    total: results.length,
    ok, auth_fail: authFail, server_error: serverErr, timeout: timeouts,
    results,
    failures: results.filter(r => r.live_status !== 'ok' && r.live_status !== 'skipped')
  };
}

export function checkAllCredentials({ registryPath, platformFilter, statePath, session } = {}) {
  const regPath = registryPath || REGISTRY;
  if (!existsSync(regPath)) {
    return { error: 'account-registry.json not found', results: [] };
  }

  const registry = JSON.parse(readFileSync(regPath, 'utf8'));
  let accounts = registry.accounts.filter(a => a.status === 'live' || a.status === 'active');

  if (platformFilter) {
    accounts = accounts.filter(a => a.id === platformFilter);
  }

  const sessionNum = session || parseInt(process.env.SESSION_NUM || '0', 10);
  const sp = statePath || STATE_PATH;
  const failureState = loadFailureState(sp);
  const results = accounts.map(checkCredential);

  // Update failure state and apply consecutive-failure threshold
  for (const r of results) {
    const failed = r.status !== 'ok';
    const entry = updateFailureState(r.id, failed, failureState, sessionNum);
    if (failed && entry.consecutive_failures < CONSECUTIVE_FAILURE_THRESHOLD) {
      r._original_status = r.status;
      r.status = 'transient';
      r.details = `${r.details} (1/${CONSECUTIVE_FAILURE_THRESHOLD} consecutive, suppressed)`;
    }
  }

  try { saveFailureState(failureState, sp); } catch { /* non-fatal */ }

  const healthy = results.filter(r => r.status === 'ok' || r.status === 'transient').length;
  const warnings = results.filter(r => r.status !== 'ok' && r.status !== 'transient');

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
  const liveMode = args.includes('--live');
  const platformIdx = args.indexOf('--platform');
  const platformFilter = platformIdx >= 0 ? args[platformIdx + 1] : undefined;

  const report = checkAllCredentials({ platformFilter });

  if (jsonMode && !liveMode) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!liveMode) {
    console.log(`Credential health: ${report.healthy}/${report.total} platforms OK`);
    if (report.warnings) {
      console.log('\nWarnings:');
      for (const w of report.warnings) {
        console.log(`  ${w.id}: [${w.status}] ${w.details}`);
      }
    }
  }

  if (liveMode) {
    checkAllCredentialsLive({ platformFilter }).then(liveReport => {
      if (jsonMode) {
        console.log(JSON.stringify({ file_check: report, live_check: liveReport }, null, 2));
      } else {
        if (!jsonMode && !liveMode) { /* already printed above */ }
        console.log(`\nLive auth: ${liveReport.ok}/${liveReport.total} endpoints OK`);
        if (liveReport.auth_fail > 0) console.log(`  Auth failures: ${liveReport.auth_fail}`);
        if (liveReport.server_error > 0) console.log(`  Server errors: ${liveReport.server_error}`);
        if (liveReport.timeout > 0) console.log(`  Timeouts: ${liveReport.timeout}`);
        if (liveReport.failures.length > 0) {
          console.log('\nLive failures:');
          for (const f of liveReport.failures) {
            console.log(`  ${f.id}: [${f.live_status}] ${f.details}`);
          }
        }
      }
    });
  }
}

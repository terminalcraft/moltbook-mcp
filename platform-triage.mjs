#!/usr/bin/env node
/**
 * platform-triage.mjs — Auto-triage all degraded platforms in one pass.
 *
 * Probes all degraded platforms in parallel, classifies each into:
 *   - auth-fixable: Platform reachable but auth fails (re-register or refresh creds)
 *   - api-changed: Platform reachable but API endpoints moved/changed
 *   - dead: Platform completely unreachable (DNS fail, connection refused)
 *   - rate-limited: Platform responds with 429 or throttle indicators
 *   - unknown: Could not determine category
 *
 * Outputs a prioritized recovery list sorted by effort (easiest first).
 *
 * Usage:
 *   node platform-triage.mjs              # Human-readable output
 *   node platform-triage.mjs --json       # JSON output for scripts
 *   node platform-triage.mjs --save       # Write results to platform-triage-results.json
 *   node platform-triage.mjs --mark-defunct  # Auto-mark dead platforms (30+ fails) as defunct
 *
 * wq-461: Degraded platform auto-triage
 * wq-465: Auto-mark defunct from triage results
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { safeFetch } from './lib/safe-fetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, 'account-registry.json');
const CIRCUITS_PATH = join(__dirname, 'platform-circuits.json');
const RESULTS_PATH = join(__dirname, 'platform-triage-results.json');

const PROBE_TIMEOUT = 6000;
const CONCURRENCY = 8;

const LIVE_STATUSES = ['live', 'creds_ok', 'active'];

// Endpoints to probe for classification
const HEALTH_ENDPOINTS = ['/health', '/api/health', '/api/v1/health'];
const DISCOVERY_ENDPOINTS = ['/skill.md', '/.well-known/agent-info.json', '/api-docs'];
const REGISTRATION_ENDPOINTS = ['/api/register', '/api/v1/register', '/register'];

// Classification categories with priority (lower = easier to fix)
const CATEGORIES = {
  'auth-fixable': { priority: 1, label: 'Auth Fixable', icon: '🔐', desc: 'Reachable but auth fails — re-register or refresh creds' },
  'rate-limited': { priority: 2, label: 'Rate Limited', icon: '⏳', desc: 'Responding with throttle — wait and retry' },
  'api-changed': { priority: 3, label: 'API Changed', icon: '🔀', desc: 'Reachable but known endpoints moved — needs endpoint discovery' },
  'dead': { priority: 4, label: 'Dead', icon: '💀', desc: 'Completely unreachable — DNS fail or server down' },
  'unknown': { priority: 5, label: 'Unknown', icon: '❓', desc: 'Could not determine issue' },
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    json: args.includes('--json'),
    save: args.includes('--save'),
    markDefunct: args.includes('--mark-defunct'),
  };
}

function loadData() {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  let circuits = {};
  try {
    circuits = JSON.parse(readFileSync(CIRCUITS_PATH, 'utf8'));
  } catch { /* no circuits file */ }
  return { registry, circuits };
}

function getDegradedPlatforms(registry) {
  return registry.accounts.filter(a => LIVE_STATUSES.indexOf(a.last_status) === -1);
}

function extractBaseUrl(account) {
  if (account.test && account.test.url) {
    try {
      const u = new URL(account.test.url);
      return u.origin;
    } catch { /* fall through */ }
  }
  return null;
}

async function probeUrl(url) {
  const result = await safeFetch(url, { timeout: PROBE_TIMEOUT });
  const status = result.status;
  const ok = status >= 200 && status < 400;
  const error = result.error || null;

  // Detect if response is HTML (landing page) vs API response
  const body = result.body || '';
  const looksLikeHtml = body.trimStart().startsWith('<!') || body.trimStart().startsWith('<html') || body.includes('<!DOCTYPE');
  const looksLikeJson = body.trimStart().startsWith('{') || body.trimStart().startsWith('[');
  const isApiResponse = looksLikeJson || (ok && !looksLikeHtml);

  return {
    url,
    status: status || null,
    ok,
    error,
    isApiResponse,
    isHtmlOnly: ok && looksLikeHtml && !looksLikeJson,
    bodyPreview: body.slice(0, 120).replace(/\n/g, ' '),
  };
}

async function triagePlatform(account, circuit) {
  const baseUrl = extractBaseUrl(account);
  const result = {
    id: account.id,
    platform: account.platform,
    last_status: account.last_status,
    auth_type: account.auth_type,
    has_credentials: account.has_credentials || false,
    base_url: baseUrl,
    circuit_status: (circuit && circuit.status) || 'none',
    consecutive_failures: (circuit && circuit.consecutive_failures) || 0,
    category: 'unknown',
    evidence: [],
    recovery_action: '',
    probes: {},
  };

  if (!baseUrl) {
    result.category = 'unknown';
    result.evidence.push('No test URL configured — cannot probe');
    result.recovery_action = 'Add test URL to account-registry.json, then re-triage';
    return result;
  }

  // Probe API endpoint, health endpoints, discovery endpoints, registration in parallel
  const probeTargets = [];

  // Main API endpoint
  if (account.test && account.test.url) {
    probeTargets.push({ key: 'api', url: account.test.url });
  }

  // Health endpoints
  for (const ep of HEALTH_ENDPOINTS) {
    probeTargets.push({ key: `health:${ep}`, url: baseUrl + ep });
  }

  // Discovery endpoints
  for (const ep of DISCOVERY_ENDPOINTS) {
    probeTargets.push({ key: `discovery:${ep}`, url: baseUrl + ep });
  }

  // Registration endpoints
  for (const ep of REGISTRATION_ENDPOINTS) {
    probeTargets.push({ key: `register:${ep}`, url: baseUrl + ep });
  }

  // Run all probes in parallel
  const probeResults = await Promise.all(probeTargets.map(t => probeUrl(t.url).then(r => ({ ...r, key: t.key }))));

  for (const pr of probeResults) {
    result.probes[pr.key] = { status: pr.status, ok: pr.ok, error: pr.error };
  }

  // Classify based on probe results
  classify(result, probeResults);

  return result;
}

function classify(result, probeResults) {
  const apiProbe = probeResults.find(p => p.key === 'api');
  const healthProbes = probeResults.filter(p => p.key.startsWith('health:'));
  const discoveryProbes = probeResults.filter(p => p.key.startsWith('discovery:'));
  const registerProbes = probeResults.filter(p => p.key.startsWith('register:'));

  const anyReachable = probeResults.some(p => p.status !== null);
  const anyOk = probeResults.some(p => p.ok);
  const anyApiResponse = probeResults.some(p => p.isApiResponse);
  const anyHealth = healthProbes.some(p => p.ok && p.isApiResponse);
  const anyDiscovery = discoveryProbes.some(p => p.ok);
  const anyRegister = registerProbes.some(p => (p.ok || p.status === 405) && !p.isHtmlOnly);
  const allHtmlOnly = probeResults.filter(p => p.ok).every(p => p.isHtmlOnly);
  const allErrors = probeResults.every(p => p.error);

  // Check for rate limiting (429)
  const hasRateLimit = probeResults.some(p => p.status === 429);
  if (hasRateLimit) {
    result.category = 'rate-limited';
    result.evidence.push('Received HTTP 429 (Too Many Requests)');
    result.recovery_action = 'Wait and retry — add exponential backoff';
    return;
  }

  // Dead: nothing responds at all (connection errors, timeouts)
  if (!anyReachable || allErrors) {
    result.category = 'dead';
    const errors = [...new Set(probeResults.filter(p => p.error).map(p => p.error))];
    result.evidence.push(`All ${probeResults.length} probes failed`);
    if (errors.length > 0) result.evidence.push(`Errors: ${errors.slice(0, 3).join(', ')}`);
    if (result.consecutive_failures > 30) {
      result.recovery_action = 'Likely permanently dead — consider marking defunct';
    } else {
      result.recovery_action = 'Monitor for revival — may be temporarily down';
    }
    return;
  }

  // Check for auth issues (401/403 on API but server is reachable)
  const isAuthError = apiProbe && (apiProbe.status === 401 || apiProbe.status === 403);
  if (isAuthError) {
    result.category = 'auth-fixable';
    result.evidence.push(`API returned ${apiProbe.status} — server reachable but auth rejected`);
    if (anyRegister) {
      result.evidence.push('Registration endpoint found — can attempt re-registration');
      result.recovery_action = 'Re-register via discovered registration endpoint';
    } else if (result.has_credentials) {
      result.recovery_action = 'Refresh credentials (current ones rejected)';
    } else {
      result.recovery_action = 'Obtain credentials — no registration endpoint found';
    }
    return;
  }

  // Auth-fixable: last_status is bad_creds/no_creds AND API-like responses exist
  if ((result.last_status === 'bad_creds' || result.last_status === 'no_creds') && anyApiResponse) {
    result.category = 'auth-fixable';
    result.evidence.push(`Status is ${result.last_status} and API endpoints respond`);
    if (anyRegister) {
      result.evidence.push('Registration endpoint available');
      result.recovery_action = result.last_status === 'bad_creds'
        ? 'Re-register to refresh credentials'
        : 'Register for the first time via discovered endpoint';
    } else {
      result.recovery_action = result.last_status === 'bad_creds'
        ? 'Investigate credential refresh (no registration endpoint)'
        : 'No auto-registration available — needs manual credential setup';
    }
    return;
  }

  // Landing page only: server returns HTML on all endpoints, no real API
  // This means the domain exists but the API is gone — effectively dead
  if (anyOk && allHtmlOnly && !anyApiResponse) {
    result.category = 'dead';
    result.evidence.push('All responses are HTML landing pages — no API endpoints found');
    result.evidence.push('Domain resolves but API appears decommissioned');
    result.recovery_action = 'API gone — mark as defunct or wait for platform relaunch';
    return;
  }

  // API changed: server has API responses on some endpoints but the known test URL fails
  if (anyApiResponse && apiProbe && !apiProbe.ok) {
    result.category = 'api-changed';
    result.evidence.push('API responses found on discovery endpoints but test URL fails');
    if (apiProbe.status) {
      result.evidence.push(`Test URL returned HTTP ${apiProbe.status}`);
    } else {
      result.evidence.push(`Test URL error: ${apiProbe.error}`);
    }
    if (anyHealth) result.evidence.push('Health endpoint responds with API data');
    if (anyDiscovery) result.evidence.push('Discovery endpoints found — check for new API docs');
    result.recovery_action = 'Update test URL in registry based on discovered endpoints';
    return;
  }

  // Server responds but with 5xx and has some API-like responses
  if (anyReachable && probeResults.some(p => p.status >= 500) && anyApiResponse) {
    result.category = 'api-changed';
    result.evidence.push('Server returns 5xx on some endpoints — API partially broken');
    result.recovery_action = 'Check API docs for updated endpoints or wait for server fix';
    return;
  }

  // Server responds on some endpoints with non-HTML but no healthy ones
  if (anyApiResponse && !anyHealth) {
    result.category = 'api-changed';
    result.evidence.push('API-like responses detected but no healthy endpoints');
    result.recovery_action = 'Probe additional endpoints to find working API';
    return;
  }

  // Fallback for servers that respond but only with mixed signals
  if (anyReachable && !anyApiResponse) {
    result.category = 'dead';
    result.evidence.push('Server responds but no API-like endpoints found');
    if (probeResults.some(p => p.isHtmlOnly)) {
      result.evidence.push('Only HTML responses — likely a parked domain or static site');
    }
    result.recovery_action = 'API gone — monitor for revival or mark defunct';
    return;
  }

  // True unknown
  result.evidence.push('Could not determine failure category');
  result.recovery_action = 'Manual investigation needed';
}

async function runWithConcurrency(items, fn, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function prioritize(results) {
  return results.sort((a, b) => {
    const pa = CATEGORIES[a.category].priority;
    const pb = CATEGORIES[b.category].priority;
    if (pa !== pb) return pa - pb;
    // Within same category, platforms with credentials first (easier fix)
    if (a.has_credentials !== b.has_credentials) return a.has_credentials ? -1 : 1;
    // Then by fewer consecutive failures (more likely alive)
    return a.consecutive_failures - b.consecutive_failures;
  });
}

function printHuman(results) {
  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  DEGRADED PLATFORM TRIAGE REPORT');
  console.log(`  ${results.length} platforms classified • ${new Date().toISOString().slice(0, 19)}Z`);
  console.log(`${'═'.repeat(70)}\n`);

  // Print summary
  console.log('SUMMARY:');
  for (const [cat, meta] of Object.entries(CATEGORIES)) {
    const count = (byCategory[cat] || []).length;
    if (count > 0) {
      console.log(`  ${meta.icon} ${meta.label}: ${count} — ${meta.desc}`);
    }
  }
  console.log('');

  // Print prioritized list
  console.log(`${'─'.repeat(70)}`);
  console.log('PRIORITIZED RECOVERY LIST (easiest first):\n');

  let rank = 1;
  for (const r of results) {
    const meta = CATEGORIES[r.category];
    console.log(`  ${rank}. ${meta.icon} ${r.platform} (${r.id})`);
    console.log(`     Category: ${meta.label} | Status: ${r.last_status} | Circuit: ${r.circuit_status}`);
    if (r.base_url) console.log(`     URL: ${r.base_url}`);
    for (const ev of r.evidence) {
      console.log(`     • ${ev}`);
    }
    console.log(`     → ${r.recovery_action}`);
    console.log('');
    rank++;
  }

  // Print actionable summary
  const authFixable = byCategory['auth-fixable'] || [];
  const apiChanged = byCategory['api-changed'] || [];
  const rateLimited = byCategory['rate-limited'] || [];
  const dead = byCategory['dead'] || [];

  console.log(`${'─'.repeat(70)}`);
  console.log('RECOMMENDED NEXT STEPS:\n');

  if (authFixable.length > 0) {
    console.log(`  1. Fix auth for ${authFixable.length} platform(s): ${authFixable.map(r => r.id).join(', ')}`);
    console.log('     These are reachable and likely recoverable with credential refresh.\n');
  }
  if (apiChanged.length > 0) {
    console.log(`  2. Update endpoints for ${apiChanged.length} platform(s): ${apiChanged.map(r => r.id).join(', ')}`);
    console.log('     Servers respond but API has moved — check their docs.\n');
  }
  if (rateLimited.length > 0) {
    console.log(`  3. Back off ${rateLimited.length} rate-limited platform(s): ${rateLimited.map(r => r.id).join(', ')}\n`);
  }
  if (dead.length > 0) {
    const defunctCandidates = dead.filter(r => r.consecutive_failures > 30);
    console.log(`  4. ${dead.length} dead platform(s): ${dead.map(r => r.id).join(', ')}`);
    if (defunctCandidates.length > 0) {
      console.log(`     Consider marking defunct: ${defunctCandidates.map(r => r.id).join(', ')}`);
    }
    console.log('');
  }
}

async function main() {
  const opts = parseArgs();
  const { registry, circuits } = loadData();
  const degraded = getDegradedPlatforms(registry);

  if (degraded.length === 0) {
    console.log('No degraded platforms found.');
    process.exit(0);
  }

  if (!opts.json) {
    console.log(`Probing ${degraded.length} degraded platforms (concurrency: ${CONCURRENCY})...`);
  }

  const results = await runWithConcurrency(
    degraded,
    (account) => triagePlatform(account, circuits[account.id]),
    CONCURRENCY,
  );

  const prioritized = prioritize(results);

  if (opts.json) {
    const output = {
      timestamp: new Date().toISOString(),
      total: prioritized.length,
      summary: {},
      platforms: prioritized.map(r => ({
        id: r.id,
        platform: r.platform,
        category: r.category,
        last_status: r.last_status,
        base_url: r.base_url,
        has_credentials: r.has_credentials,
        circuit_status: r.circuit_status,
        consecutive_failures: r.consecutive_failures,
        evidence: r.evidence,
        recovery_action: r.recovery_action,
      })),
    };
    for (const cat of Object.keys(CATEGORIES)) {
      output.summary[cat] = prioritized.filter(r => r.category === cat).length;
    }
    console.log(JSON.stringify(output, null, 2));
  } else {
    printHuman(prioritized);
  }

  if (opts.save) {
    const output = {
      timestamp: new Date().toISOString(),
      total: prioritized.length,
      summary: {},
      platforms: prioritized,
    };
    for (const cat of Object.keys(CATEGORIES)) {
      output.summary[cat] = prioritized.filter(r => r.category === cat).length;
    }
    writeFileSync(RESULTS_PATH, JSON.stringify(output, null, 2) + '\n');
    if (!opts.json) console.log(`Results saved to ${RESULTS_PATH}`);
  }

  if (opts.markDefunct) {
    const defunctCandidates = prioritized.filter(
      r => r.category === 'dead' && r.consecutive_failures > 30
    );

    if (defunctCandidates.length === 0) {
      if (!opts.json) console.log('\nNo platforms qualify for defunct marking (need dead + 30+ failures).');
    } else {
      // Reload fresh copies for safe mutation
      const freshRegistry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
      let freshCircuits = {};
      try {
        freshCircuits = JSON.parse(readFileSync(CIRCUITS_PATH, 'utf8'));
      } catch { /* no file */ }

      const now = new Date().toISOString();
      const marked = [];

      for (const candidate of defunctCandidates) {
        // Update account-registry
        const acc = freshRegistry.accounts.find(a => a.id === candidate.id);
        if (acc) {
          acc.last_status = 'defunct';
          acc.last_tested = now;
          acc.notes = (acc.notes || '') + ` Auto-defunct by triage (${candidate.consecutive_failures} failures, ${now.slice(0, 10)}).`;
        }

        // Update circuit breaker
        if (!freshCircuits[candidate.id]) {
          freshCircuits[candidate.id] = { consecutive_failures: candidate.consecutive_failures, total_failures: candidate.consecutive_failures, total_successes: 0 };
        }
        freshCircuits[candidate.id].status = 'defunct';
        freshCircuits[candidate.id].defunct_at = now;
        freshCircuits[candidate.id].defunct_reason = `Auto-defunct: ${candidate.consecutive_failures} consecutive failures, classified dead by triage`;

        marked.push(candidate.id);
      }

      writeFileSync(REGISTRY_PATH, JSON.stringify(freshRegistry, null, 2) + '\n');
      writeFileSync(CIRCUITS_PATH, JSON.stringify(freshCircuits, null, 2) + '\n');

      if (!opts.json) {
        console.log(`\nMarked ${marked.length} platform(s) as defunct: ${marked.join(', ')}`);
      }
    }
  }
}

main().catch(e => {
  console.error('Triage failed:', e.message);
  process.exit(1);
});

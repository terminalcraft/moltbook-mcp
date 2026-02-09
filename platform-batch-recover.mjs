#!/usr/bin/env node
/**
 * platform-batch-recover.mjs — Batch recovery for degraded platforms.
 *
 * Probes all degraded platforms in parallel, auto-promotes those that
 * respond with 2xx/3xx back to live, resets their circuit breakers,
 * and generates a triage report for the remaining dead ones.
 *
 * Usage:
 *   node platform-batch-recover.mjs              # Probe + report (dry run)
 *   node platform-batch-recover.mjs --apply      # Probe + auto-promote responding platforms
 *   node platform-batch-recover.mjs --json       # JSON output
 *   node platform-batch-recover.mjs --mark-defunct # Also mark dead (30+ failures) as defunct
 *
 * wq-490: Degraded platform batch recovery
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { safeFetch } from './lib/safe-fetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, 'account-registry.json');
const CIRCUITS_PATH = join(__dirname, 'platform-circuits.json');

const PROBE_TIMEOUT = 6000;
const CONCURRENCY = 8;
const LIVE_STATUSES = new Set(['live', 'creds_ok', 'active']);
const DEFUNCT_FAILURE_THRESHOLD = 30;

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    json: args.includes('--json'),
    markDefunct: args.includes('--mark-defunct'),
  };
}

function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

async function probeUrl(url) {
  const result = await safeFetch(url, { timeout: PROBE_TIMEOUT });
  return {
    status: result.status || 0,
    ok: result.status >= 200 && result.status < 400,
    reachable: result.status > 0,
    error: result.error || null,
    elapsed: result.elapsed || 0,
  };
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function main() {
  const opts = parseArgs();
  const registry = loadJSON(REGISTRY_PATH, { accounts: [] });
  const circuits = loadJSON(CIRCUITS_PATH, {});

  // Find all degraded platforms
  const degraded = registry.accounts.filter(a => !LIVE_STATUSES.has(a.last_status) && a.last_status !== 'defunct');

  if (degraded.length === 0) {
    const msg = 'No degraded platforms found.';
    if (opts.json) console.log(JSON.stringify({ message: msg, recovered: 0, dead: 0 }));
    else console.log(msg);
    return;
  }

  if (!opts.json) {
    console.log(`Probing ${degraded.length} degraded platforms (concurrency: ${CONCURRENCY})...\n`);
  }

  // Probe all degraded platforms
  const results = await runWithConcurrency(degraded, async (account) => {
    const url = account.test?.url || null;
    if (!url) {
      return { account, probe: null, reason: 'no test URL' };
    }
    const probe = await probeUrl(url);
    return { account, probe, url };
  }, CONCURRENCY);

  // Classify results
  const recovered = [];   // Platforms that responded OK — can promote
  const reachable = [];    // Responded but not 2xx (auth issues etc)
  const dead = [];         // Completely unreachable
  const noUrl = [];        // No test URL configured

  for (const r of results) {
    if (!r.probe) {
      noUrl.push(r);
    } else if (r.probe.ok) {
      recovered.push(r);
    } else if (r.probe.reachable) {
      reachable.push(r);
    } else {
      dead.push(r);
    }
  }

  // Apply recovery if --apply
  const now = new Date().toISOString();
  let promotedCount = 0;
  let defunctCount = 0;

  if (opts.apply && recovered.length > 0) {
    for (const r of recovered) {
      const acc = registry.accounts.find(a => a.id === r.account.id);
      if (acc) {
        acc.last_status = 'live';
        acc.last_tested = now;
        acc.notes = (acc.notes || '').replace(/\s*Auto-recovered.*$/, '') +
          ` Auto-recovered by batch-recover (${now.slice(0, 10)}).`;
        promotedCount++;
      }

      // Reset circuit breaker
      const circuit = circuits[r.account.id];
      if (circuit) {
        circuit.consecutive_failures = 0;
        circuit.last_success = now;
        delete circuit.status;
        delete circuit.opened_at;
        delete circuit.half_open_at;
        delete circuit.reason;
      }
    }
  }

  // Mark defunct if --mark-defunct
  if (opts.markDefunct && opts.apply) {
    for (const r of dead) {
      const failures = circuits[r.account.id]?.consecutive_failures || 0;
      if (failures >= DEFUNCT_FAILURE_THRESHOLD) {
        const acc = registry.accounts.find(a => a.id === r.account.id);
        if (acc) {
          acc.last_status = 'defunct';
          acc.last_tested = now;
          acc.notes = (acc.notes || '') +
            ` Auto-defunct by batch-recover (${failures} failures, ${now.slice(0, 10)}).`;
          defunctCount++;
        }
        if (!circuits[r.account.id]) {
          circuits[r.account.id] = { consecutive_failures: failures, total_failures: failures, total_successes: 0 };
        }
        circuits[r.account.id].status = 'defunct';
        circuits[r.account.id].defunct_at = now;
      }
    }
  }

  // Save changes
  if (opts.apply && (promotedCount > 0 || defunctCount > 0)) {
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
    writeFileSync(CIRCUITS_PATH, JSON.stringify(circuits, null, 2) + '\n');
  }

  // Output
  if (opts.json) {
    console.log(JSON.stringify({
      timestamp: now,
      total_degraded: degraded.length,
      recovered: recovered.map(r => ({ id: r.account.id, platform: r.account.platform, status: r.probe.status })),
      reachable_but_errored: reachable.map(r => ({ id: r.account.id, platform: r.account.platform, status: r.probe.status, error: r.probe.error })),
      dead: dead.map(r => ({ id: r.account.id, platform: r.account.platform, error: r.probe?.error, failures: circuits[r.account.id]?.consecutive_failures || 0 })),
      no_url: noUrl.map(r => ({ id: r.account.id, platform: r.account.platform })),
      applied: opts.apply,
      promoted: promotedCount,
      marked_defunct: defunctCount,
    }, null, 2));
    return;
  }

  // Human-readable output
  console.log('='.repeat(60));
  console.log('  BATCH RECOVERY REPORT');
  console.log(`  ${degraded.length} degraded platforms probed`);
  console.log('='.repeat(60));

  if (recovered.length > 0) {
    console.log(`\n  RECOVERED (${recovered.length}) — responding with 2xx/3xx:`);
    for (const r of recovered) {
      const mark = opts.apply ? ' [PROMOTED]' : '';
      console.log(`    + ${r.account.platform} (${r.account.id}) — HTTP ${r.probe.status}${mark}`);
    }
  }

  if (reachable.length > 0) {
    console.log(`\n  REACHABLE BUT ERRORED (${reachable.length}) — needs auth/endpoint fix:`);
    for (const r of reachable) {
      console.log(`    ~ ${r.account.platform} (${r.account.id}) — HTTP ${r.probe.status}`);
    }
  }

  if (dead.length > 0) {
    console.log(`\n  DEAD (${dead.length}) — completely unreachable:`);
    for (const r of dead) {
      const failures = circuits[r.account.id]?.consecutive_failures || 0;
      const defunctTag = (opts.apply && opts.markDefunct && failures >= DEFUNCT_FAILURE_THRESHOLD) ? ' [DEFUNCT]' : '';
      console.log(`    x ${r.account.platform} (${r.account.id}) — ${r.probe?.error || 'no response'} (${failures} failures)${defunctTag}`);
    }
  }

  if (noUrl.length > 0) {
    console.log(`\n  NO URL (${noUrl.length}) — cannot probe:`);
    for (const r of noUrl) {
      console.log(`    ? ${r.account.platform} (${r.account.id})`);
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`  Summary: ${recovered.length} recoverable, ${reachable.length} auth-fixable, ${dead.length} dead, ${noUrl.length} no URL`);
  if (opts.apply) {
    console.log(`  Applied: ${promotedCount} promoted to live, ${defunctCount} marked defunct`);
  } else {
    console.log(`  (dry run — use --apply to promote recovered platforms)`);
  }
  console.log('-'.repeat(60));
}

main().catch(e => {
  console.error('Recovery failed:', e.message);
  process.exit(1);
});

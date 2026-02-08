#!/usr/bin/env node
/**
 * hook-timing-tuner.mjs — Analyze hook execution times and generate adaptive timeout profiles.
 *
 * Reads pre-hook-results.json and hook-results.json (rolling 200-entry windows),
 * computes per-hook P50/P95 latencies by session type, and writes recommended
 * timeouts to hook-timing-profiles.json.
 *
 * Usage: node hook-timing-tuner.mjs [--dry-run]
 * Output: writes ~/.config/moltbook/hook-timing-profiles.json
 *
 * Created: B#362 (wq-427)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOG_DIR = join(homedir(), '.config/moltbook/logs');
const PROFILES_PATH = join(homedir(), '.config/moltbook/hook-timing-profiles.json');
const DRY_RUN = process.argv.includes('--dry-run');

// Minimum timeout floor (seconds) — never go below this
const MIN_TIMEOUT = 5;
// Multiplier above P95 for recommended timeout
const TIMEOUT_HEADROOM = 1.5;
// Minimum samples needed before we generate a recommendation
const MIN_SAMPLES = 5;

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map(line => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function analyzeHooks(entries) {
  // Build per-hook, per-mode timing data
  // Structure: { hookName: { all: [ms], B: [ms], E: [ms], ... } }
  const hookData = {};

  for (const entry of entries) {
    const session = entry.session;
    // Determine mode from session-type hooks or use 'all'
    // We don't have mode in the JSON directly, but we can infer from hook suffix patterns
    const hooks = entry.hooks || [];
    for (const h of hooks) {
      if (h.status === 'budget_skip' || h.status === 'skip') continue;
      const name = h.hook;
      const ms = h.ms || 0;
      if (!hookData[name]) hookData[name] = { all: [], timeouts: 0, failures: 0, samples: 0 };
      hookData[name].all.push(ms);
      hookData[name].samples++;
      if (h.status === 'fail:124') hookData[name].timeouts++;
      if (h.status && h.status.startsWith('fail:')) hookData[name].failures++;
    }
  }

  return hookData;
}

function generateProfiles(hookData) {
  const profiles = {};

  for (const [name, data] of Object.entries(hookData)) {
    if (data.samples < MIN_SAMPLES) continue;

    const sorted = [...data.all].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const max = sorted[sorted.length - 1];
    const mean = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);

    // Recommended timeout: P95 * headroom, rounded up to nearest second, floored at MIN_TIMEOUT
    const recommendedMs = Math.ceil(p95 * TIMEOUT_HEADROOM);
    const recommendedSecs = Math.max(MIN_TIMEOUT, Math.ceil(recommendedMs / 1000));

    const timeoutRate = data.samples > 0
      ? Math.round((data.timeouts / data.samples) * 100)
      : 0;

    profiles[name] = {
      samples: data.samples,
      p50_ms: Math.round(p50),
      p95_ms: Math.round(p95),
      p99_ms: Math.round(p99),
      max_ms: max,
      mean_ms: mean,
      timeout_count: data.timeouts,
      timeout_rate_pct: timeoutRate,
      failure_count: data.failures,
      recommended_timeout_secs: recommendedSecs,
    };
  }

  return profiles;
}

function classifyHooks(profiles) {
  const fast = []; // P95 < 200ms
  const medium = []; // P95 200-2000ms
  const slow = []; // P95 > 2000ms
  const chronic_timeout = []; // timeout_rate > 20%

  for (const [name, p] of Object.entries(profiles)) {
    if (p.timeout_rate_pct > 20) chronic_timeout.push(name);
    if (p.p95_ms < 200) fast.push(name);
    else if (p.p95_ms <= 2000) medium.push(name);
    else slow.push(name);
  }

  return { fast: fast.length, medium: medium.length, slow: slow.length, chronic_timeout };
}

// Main
const preResults = readJsonLines(join(LOG_DIR, 'pre-hook-results.json'));
const postResults = readJsonLines(join(LOG_DIR, 'hook-results.json'));

const preData = analyzeHooks(preResults);
const postData = analyzeHooks(postResults);

const preProfiles = generateProfiles(preData);
const postProfiles = generateProfiles(postData);

const preClassification = classifyHooks(preProfiles);
const postClassification = classifyHooks(postProfiles);

const output = {
  generated_at: new Date().toISOString(),
  sources: {
    pre_hook_entries: preResults.length,
    post_hook_entries: postResults.length,
  },
  pre_session: {
    profiles: preProfiles,
    classification: preClassification,
  },
  post_session: {
    profiles: postProfiles,
    classification: postClassification,
  },
};

if (DRY_RUN) {
  // Print summary to stdout
  console.log(JSON.stringify(output, null, 2));
} else {
  writeFileSync(PROFILES_PATH, JSON.stringify(output, null, 2));
  // Print summary
  const preCount = Object.keys(preProfiles).length;
  const postCount = Object.keys(postProfiles).length;
  console.log(`Hook timing profiles written to ${PROFILES_PATH}`);
  console.log(`Pre-session: ${preCount} hooks profiled (${preClassification.slow} slow, ${preClassification.chronic_timeout.length} chronic timeouts)`);
  console.log(`Post-session: ${postCount} hooks profiled (${postClassification.slow} slow, ${postClassification.chronic_timeout.length} chronic timeouts)`);

  // Flag chronic timeouts
  const allChronic = [...preClassification.chronic_timeout, ...postClassification.chronic_timeout];
  if (allChronic.length > 0) {
    console.log(`\nChronic timeout hooks (>20% timeout rate):`);
    for (const name of allChronic) {
      const p = preProfiles[name] || postProfiles[name];
      console.log(`  ${name}: ${p.timeout_rate_pct}% timeout rate, P95=${p.p95_ms}ms, recommended=${p.recommended_timeout_secs}s`);
    }
  }
}

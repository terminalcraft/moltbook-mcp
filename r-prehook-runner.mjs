#!/usr/bin/env node
/**
 * r-prehook-runner.mjs — Single-process runner for R session prehook checks.
 *
 * Replaces 2 subprocess invocations in 35-r-session-prehook_R.sh:
 *   1. jq pipeline for hook health analysis (complex JSON processing)
 *   2. node directive-analysis.mjs (directive staleness check)
 *
 * Eliminates ~200-500ms combined subprocess startup overhead.
 *
 * Usage: node r-prehook-runner.mjs <session_num> <directives_path> <queue_path> <history_path>
 *
 * Output: JSON with results from both checks.
 *
 * Created: wq-991 (B#636, d079)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { analyzeDirectives, formatResults } from './hooks/lib/directive-analysis.mjs';

const HOME = process.env.HOME || '/home/moltbot';
const LOGS_DIR = join(HOME, '.config/moltbook/logs');

function safeRun(label, fn) {
  try {
    return { ok: true, result: fn() };
  } catch (e) {
    return { ok: false, error: `${label}: ${(e.message || 'unknown').slice(0, 200)}` };
  }
}

// ---- Check 1: Hook health analysis (replaces jq pipeline) ----

function analyzeHookHealth() {
  const warnings = [];

  const files = [
    { path: join(LOGS_DIR, 'pre-hook-results.json'), phase: 'pre' },
    { path: join(LOGS_DIR, 'hook-results.json'), phase: 'post' },
  ];

  for (const { path, phase } of files) {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue; // file doesn't exist
    }

    // Parse last 5 JSON objects (file has one JSON object per line)
    const lines = raw.trim().split('\n').slice(-5);
    const recent = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed != null) recent.push(parsed);
      } catch {
        // skip malformed lines
      }
    }

    if (recent.length === 0) continue;

    // Collect all hook entries
    const allHooks = [];
    for (const session of recent) {
      if (!session.hooks || !Array.isArray(session.hooks)) continue;
      for (const h of session.hooks) {
        allHooks.push({
          hook: h.hook,
          status: h.status || '',
          ms: h.ms || 0,
        });
      }
    }

    // Group by hook name
    const groups = {};
    for (const h of allHooks) {
      if (!groups[h.hook]) groups[h.hook] = [];
      groups[h.hook].push(h);
    }

    const stats = Object.entries(groups).map(([name, entries]) => ({
      name,
      runs: entries.length,
      fails: entries.filter(e => e.status.startsWith('fail')).length,
      total_ms: entries.reduce((sum, e) => sum + e.ms, 0),
    }));

    // Failing hooks (>50% failure rate, >=2 runs)
    for (const s of stats) {
      if (s.runs >= 2 && (s.fails / s.runs) > 0.5) {
        const pct = Math.floor((s.fails * 100) / s.runs);
        warnings.push(`WARN: ${phase} hook ${s.name} failing ${pct}% (${s.fails}/${s.runs} recent sessions)`);
      }
    }

    // Slow hooks (avg >5000ms)
    for (const s of stats) {
      const avg = Math.floor(s.total_ms / s.runs);
      if (avg > 5000) {
        let fix;
        if (/liveness|health|balance/.test(s.name)) {
          fix = 'add time-based cache or move to periodic cron';
        } else if (/engagement|intel/.test(s.name)) {
          fix = 'reduce API calls or add short-circuit on empty state';
        } else if (avg > 15000) {
          fix = 'split into async background task';
        } else {
          fix = 'profile with LOG_DIR debug, check for network calls';
        }
        warnings.push(`WARN: ${phase} hook ${s.name} slow (avg ${avg}ms across ${s.runs} sessions) → FIX: ${fix}`);
      }
    }

    // Total session average
    const totalMs = allHooks.reduce((sum, h) => sum + h.ms, 0);
    const avgTotal = totalMs / recent.length;
    if (avgTotal > 60000) {
      warnings.push(`WARN: ${phase} hooks averaging ${Math.floor(avgTotal / 1000)}s total per session (budget drain)`);
    }
  }

  return { warnings, issueCount: warnings.length };
}

// ---- Check 2: Directive analysis (replaces node directive-analysis.mjs) ----

function runDirectiveAnalysis(sessionNum, directivesPath, queuePath, historyPath) {
  const directives = JSON.parse(readFileSync(directivesPath, 'utf8'));

  let queue = { queue: [] };
  try { queue = JSON.parse(readFileSync(queuePath, 'utf8')); } catch {}

  let historyLines = [];
  try { historyLines = readFileSync(historyPath, 'utf8').split('\n'); } catch {}

  const analysis = analyzeDirectives({ sessionNum, directives, queue, historyLines });
  const text = formatResults(analysis);

  return { text, needsAttention: analysis.needsAttention, healthy: analysis.healthy };
}

// ---- Main ----

const sessionNum = parseInt(process.argv[2], 10);
const directivesPath = process.argv[3];
const queuePath = process.argv[4];
const historyPath = process.argv[5];

const hookHealth = safeRun('hook-health', () => analyzeHookHealth());
const directives = safeRun('directive-analysis', () => {
  if (!sessionNum || !directivesPath) {
    return { error: 'missing args: session_num directives_path required' };
  }
  return runDirectiveAnalysis(sessionNum, directivesPath, queuePath, historyPath);
});

const output = {
  hook_health: hookHealth.ok ? hookHealth.result : { error: hookHealth.error },
  directive_analysis: directives.ok ? directives.result : { error: directives.error },
};

console.log(JSON.stringify(output));

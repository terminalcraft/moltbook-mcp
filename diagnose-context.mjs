#!/usr/bin/env node
// diagnose-context.mjs — Root cause analyzer for session-context.mjs failures
// Usage: node diagnose-context.mjs [--json]
// Reads timing history, init-errors.log, and last context output to diagnose
// prompt health degradation and phase failures.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const STATE_DIR = join(process.env.HOME || '/home/moltbot', '.config/moltbook');
const DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const jsonMode = process.argv.includes('--json');

const issues = [];
const recommendations = [];

// 1. Timing analysis
const timingPath = join(STATE_DIR, 'session-context-timing.json');
let timing = null;
if (existsSync(timingPath)) {
  try {
    timing = JSON.parse(readFileSync(timingPath, 'utf8'));
  } catch {}
}

if (!timing) {
  issues.push({ severity: 'warn', area: 'timing', message: 'No timing data found — session-context may not have run recently' });
} else {
  const { stats, slowest_sections, history } = timing;

  // Check overall performance
  if (stats.avg_ms > 10000) {
    issues.push({ severity: 'critical', area: 'performance', message: `Average execution time ${stats.avg_ms}ms exceeds 10s threshold` });
  } else if (stats.avg_ms > 5000) {
    issues.push({ severity: 'warn', area: 'performance', message: `Average execution time ${stats.avg_ms}ms — approaching slow threshold` });
  }

  if (stats.max_ms > 30000) {
    issues.push({ severity: 'critical', area: 'performance', message: `Max execution time ${stats.max_ms}ms — indicates timeout-prone runs` });
  }

  // Check for bottleneck sections
  if (slowest_sections && slowest_sections.length > 0) {
    const top = slowest_sections[0];
    const totalTime = slowest_sections.reduce((sum, s) => sum + s.total_ms, 0);
    if (top.total_ms > totalTime * 0.7) {
      issues.push({
        severity: 'warn',
        area: 'bottleneck',
        message: `Section "${top.section}" dominates execution (${Math.round(top.total_ms / totalTime * 100)}% of time)`,
      });
      recommendations.push(`Investigate ${top.section} phase for optimization or caching opportunities`);
    }
  }

  // Check recent history for failures and degradation patterns
  if (history && history.length > 0) {
    const recent = history.slice(-10);
    const timeouts = recent.filter(h => h.total_ms > 30000);
    if (timeouts.length > 0) {
      issues.push({
        severity: 'critical',
        area: 'stability',
        message: `${timeouts.length}/10 recent sessions exceeded 30s (sessions: ${timeouts.map(t => t.session).join(', ')})`,
      });
    }

    // Check for timing regression (last 5 vs prev 5)
    if (recent.length >= 10) {
      const prev5 = recent.slice(0, 5).map(h => h.total_ms);
      const last5 = recent.slice(5).map(h => h.total_ms);
      const prevAvg = prev5.reduce((a, b) => a + b, 0) / prev5.length;
      const lastAvg = last5.reduce((a, b) => a + b, 0) / last5.length;
      if (lastAvg > prevAvg * 1.5) {
        issues.push({
          severity: 'warn',
          area: 'regression',
          message: `Timing regression detected: ${Math.round(lastAvg)}ms avg (last 5) vs ${Math.round(prevAvg)}ms (prev 5)`,
        });
      }
    }

    // Check per-mode timing
    const byMode = {};
    for (const h of recent) {
      byMode[h.mode] = byMode[h.mode] || [];
      byMode[h.mode].push(h.total_ms);
    }
    for (const [mode, times] of Object.entries(byMode)) {
      const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      if (avg > 15000) {
        issues.push({
          severity: 'warn',
          area: 'mode-specific',
          message: `Mode ${mode} sessions average ${avg}ms — may need mode-specific optimization`,
        });
      }
    }
  }
}

// 2. Init errors analysis
const errLog = join(STATE_DIR, 'logs/init-errors.log');
if (existsSync(errLog)) {
  try {
    const lines = readFileSync(errLog, 'utf8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(-20);

    // Count error types
    const patterns = {};
    for (const line of recent) {
      if (line.includes('prompt-health') && line.includes('DEGRADED')) {
        const match = line.match(/(\w) prompt block missing or too short \((\d+) chars\)/);
        if (match) {
          const key = `${match[1]}_prompt_degraded`;
          patterns[key] = (patterns[key] || 0) + 1;
        }
      }
      if (line.includes('emergency mode')) {
        patterns['emergency_mode'] = (patterns['emergency_mode'] || 0) + 1;
      }
      if (line.includes('timeout')) {
        patterns['timeout'] = (patterns['timeout'] || 0) + 1;
      }
    }

    for (const [pattern, count] of Object.entries(patterns)) {
      if (pattern.includes('prompt_degraded') && count >= 3) {
        const mode = pattern.charAt(0);
        issues.push({
          severity: 'critical',
          area: 'prompt-health',
          message: `${mode} prompt block repeatedly too short (${count} occurrences in last 20 errors)`,
        });
        recommendations.push(`Run: node session-context.mjs ${mode} 0 2>/dev/null | jq '.${mode.toLowerCase()}_prompt_block | length' to check current output size`);
      }
      if (pattern === 'emergency_mode') {
        issues.push({ severity: 'critical', area: 'init', message: `Emergency mode triggered ${count} times recently` });
      }
      if (pattern === 'timeout' && count >= 2) {
        issues.push({ severity: 'warn', area: 'init', message: `Rotation timeouts: ${count} in recent errors` });
      }
    }
  } catch {}
}

// 3. Run a quick probe of session-context.mjs for each mode that has issues
const degradedModes = new Set(
  issues.filter(i => i.area === 'prompt-health').map(i => {
    const match = i.message.match(/^(\w) prompt/);
    return match ? match[1] : null;
  }).filter(Boolean)
);

for (const mode of degradedModes) {
  try {
    const output = execSync(
      `timeout 30 node ${join(DIR, 'session-context.mjs')} ${mode} 0 2>/dev/null`,
      { encoding: 'utf8', timeout: 35000 }
    );
    const ctx = JSON.parse(output);
    const blockKey = mode === 'R' ? 'r_prompt_block' : mode === 'A' ? 'a_prompt_block'
      : mode === 'E' ? 'e_prompt_block' : 'b_prompt_block';
    const block = ctx[blockKey] || '';
    const degraded = ctx._degraded || [];

    if (block.length < 100) {
      issues.push({
        severity: 'critical',
        area: 'root-cause',
        message: `Live probe: ${mode} prompt block is ${block.length} chars (expected 500+)`,
      });
      if (degraded.length > 0) {
        issues.push({
          severity: 'critical',
          area: 'root-cause',
          message: `Degraded sections in ${mode} context: ${degraded.join('; ')}`,
        });
      }
      // Check if the prompt block function exists
      if (!block || block === 'undefined') {
        recommendations.push(`${mode} prompt block assembly is returning undefined — check session-context.mjs ${mode} section`);
      }
    }
  } catch (e) {
    issues.push({
      severity: 'critical',
      area: 'root-cause',
      message: `Live probe failed for mode ${mode}: ${(e.message || 'unknown').substring(0, 100)}`,
    });
  }
}

// 4. Check for common file-level issues
const contextFile = join(DIR, 'session-context.mjs');
if (existsSync(contextFile)) {
  try {
    const src = readFileSync(contextFile, 'utf8');
    const undefinedVarMatches = src.match(/\bundefined\b/g);
    if (undefinedVarMatches && undefinedVarMatches.length > 3) {
      issues.push({
        severity: 'warn',
        area: 'code-quality',
        message: `session-context.mjs contains ${undefinedVarMatches.length} references to 'undefined' — potential uninitialized variables`,
      });
    }
  } catch {}
}

// 5. Summary
if (issues.length === 0) {
  issues.push({ severity: 'ok', area: 'overall', message: 'No issues detected — session-context.mjs appears healthy' });
}

const criticalCount = issues.filter(i => i.severity === 'critical').length;
const warnCount = issues.filter(i => i.severity === 'warn').length;

const report = {
  timestamp: new Date().toISOString(),
  health: criticalCount > 0 ? 'CRITICAL' : warnCount > 0 ? 'DEGRADED' : 'HEALTHY',
  summary: `${criticalCount} critical, ${warnCount} warnings`,
  issues,
  recommendations,
  timing_stats: timing?.stats || null,
  slowest_sections: timing?.slowest_sections || [],
};

// Write diagnostic report
const diagPath = join(STATE_DIR, 'context-diagnostics.json');
try {
  const { writeFileSync: wfs } = await import('fs');
  wfs(diagPath, JSON.stringify(report, null, 2) + '\n');
} catch {}

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n=== Session-Context Diagnostics ===`);
  console.log(`Health: ${report.health} (${report.summary})`);
  if (timing?.stats) {
    console.log(`\nTiming: avg=${timing.stats.avg_ms}ms, max=${timing.stats.max_ms}ms, samples=${timing.stats.samples}`);
  }
  console.log(`\nIssues:`);
  for (const issue of issues) {
    const icon = issue.severity === 'critical' ? 'X' : issue.severity === 'warn' ? '!' : '-';
    console.log(`  [${icon}] ${issue.area}: ${issue.message}`);
  }
  if (recommendations.length > 0) {
    console.log(`\nRecommendations:`);
    for (const rec of recommendations) {
      console.log(`  > ${rec}`);
    }
  }
  console.log(`\nDiagnostics written to: ${diagPath}`);
}

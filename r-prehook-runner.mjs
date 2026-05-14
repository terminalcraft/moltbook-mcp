#!/usr/bin/env node
/**
 * r-prehook-runner.mjs — Single-process runner for ALL R session prehook checks.
 *
 * Produces JSON with individual check results plus a pre-formatted .summary
 * field that the shell script can echo directly — matching the d080 pattern
 * established in a-prehook-runner.mjs (wq-1011).
 *
 * Checks (6 total):
 *   1. maintain-audit     — file perms, disk, API, log sizes, directive-audit errors
 *   2. security-posture   — gitignore + staged credential checks
 *   3. hook-health        — failing/slow hooks from result logs
 *   4. directive-analysis — staleness, attention needed
 *   5. brainstorm-gate    — ≥3 active ideas check
 *   6. issue-summary      — total issues count + ALL CLEAR / TOTAL line
 *
 * Usage: node r-prehook-runner.mjs <session_num> <directives_path> <queue_path> <history_path>
 * Output: JSON with all results + .summary text
 *
 * Created: wq-991 (B#636, d079)
 * Refactored: R#372 (d080) — ported shell checks, added summary text output
 */

import { readFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { analyzeDirectives, formatResults } from './hooks/lib/directive-analysis.mjs';
import { safeRun } from './lib/runner-utils.mjs';

const HOME = process.env.HOME || '/home/moltbot';
const LOGS_DIR = join(HOME, '.config/moltbook/logs');
const sessionNum = parseInt(process.argv[2], 10);
const directivesPath = process.argv[3];
const queuePath = process.argv[4];
const historyPath = process.argv[5];
const DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const AUDIT_FILE = join(HOME, '.config/moltbook/maintain-audit.txt');

const summary = [];
let totalIssues = 0;

// ---- Check 1: Maintenance audit (file perms, disk, API, logs) ----

const maintainAudit = safeRun('maintain-audit', () => {
  const warnings = [];

  // 1a. Sensitive file permissions
  const sensitiveFiles = [
    join(DIR, 'wallet.json'),
    join(DIR, 'ctxly.json'),
    join(DIR, '.env'),
    join(HOME, '.config/moltbook/engagement-state.json'),
  ];
  for (const f of sensitiveFiles) {
    try {
      const mode = (statSync(f).mode & 0o777).toString(8);
      if (mode !== '600') {
        warnings.push(`WARN: ${f} has permissions ${mode} (expected 600)`);
      }
    } catch {
      // file doesn't exist — fine
    }
  }

  // 1b. Disk usage
  try {
    const dfOut = execSync('df /home/moltbot --output=pcent', { encoding: 'utf8', timeout: 5000 });
    const pct = parseInt(dfOut.split('\n')[1]?.trim(), 10);
    if (pct > 80) {
      warnings.push(`WARN: Disk usage at ${pct}%`);
    }
  } catch {
    // df failed — non-critical
  }

  // 1c. API health
  try {
    execSync('curl -sf http://localhost:3847/health', { timeout: 5000 });
  } catch {
    warnings.push('WARN: API not responding on localhost:3847');
  }

  // 1d. Log sizes (>5MB)
  try {
    const logDir = join(HOME, '.config/moltbook/logs');
    for (const f of readdirSync(logDir)) {
      if (!f.endsWith('.log')) continue;
      const fullPath = join(logDir, f);
      const size = statSync(fullPath).size;
      if (size > 5242880) {
        warnings.push(`WARN: ${f} is ${Math.floor(size / 1048576)}MB`);
      }
    }
  } catch {
    // logs dir missing — fine
  }

  // 1e. Directive audit log errors
  try {
    const auditLog = join(HOME, '.config/moltbook/logs/directive-audit.log');
    const tail = readFileSync(auditLog, 'utf8').split('\n').slice(-5);
    const errors = tail.filter(l => l.includes('ERROR')).length;
    if (errors > 0) {
      warnings.push(`WARN: ${errors} recent directive-audit errors — check directive-audit.log`);
    }
  } catch {
    // no audit log — fine
  }

  return { warnings, issueCount: warnings.length };
});

if (!maintainAudit.ok) {
  summary.push('[maintain-audit] ERROR: runner failed');
} else {
  const r = maintainAudit.result;
  totalIssues += r.issueCount;
  if (r.issueCount > 0) {
    for (const w of r.warnings) summary.push(`[maintain-audit] ${w}`);
  }
}

// ---- Check 2: Security posture (gitignore + staged credentials) ----

const securityPosture = safeRun('security-posture', () => {
  const issues = [];

  // 2a. Sensitive files gitignored
  const patterns = ['agentid.json', 'account-registry.json', '*-credentials.json', '*.key', 'wallet.json', 'ctxly.json', 'identity-keys.json'];
  for (const f of patterns) {
    try {
      execSync(`git check-ignore -q "${f}"`, { cwd: DIR, timeout: 3000 });
    } catch {
      issues.push({ type: 'SEC_WARN', msg: `${f} not gitignored` });
    }
  }

  // 2b. Staged credential files
  try {
    const staged = execSync('git status --porcelain', { cwd: DIR, encoding: 'utf8', timeout: 5000 });
    const credLines = staged.split('\n').filter(l => /(credentials|wallet|agentid|registry|identity|ctxly|\.key|\.pem|\.env)/.test(l));
    if (credLines.length > 0) {
      issues.push({ type: 'SEC_CRITICAL', msg: `Credential files in git working tree: ${credLines.join(', ')}` });
    }
  } catch {
    // git failed — non-critical
  }

  const clean = issues.length === 0;
  return { issues, clean, issueCount: issues.length };
});

if (!securityPosture.ok) {
  summary.push('[security-posture] ERROR: runner failed');
} else {
  const r = securityPosture.result;
  totalIssues += r.issueCount;
  if (r.clean) {
    summary.push('[security-posture] CLEAN');
  } else {
    for (const i of r.issues) summary.push(`[security-posture] ${i.type}: ${i.msg}`);
  }
}

// ---- Check 3: Hook health analysis (failing/slow hooks) ----

const hookHealth = safeRun('hook-health', () => {
  const warnings = [];
  const files = [
    { path: join(LOGS_DIR, 'pre-hook-results.json'), phase: 'pre' },
    { path: join(LOGS_DIR, 'hook-results.json'), phase: 'post' },
  ];

  for (const { path, phase } of files) {
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch { continue; }

    const lines = raw.trim().split('\n').slice(-5);
    const recent = [];
    for (const line of lines) {
      try { const p = JSON.parse(line); if (p) recent.push(p); } catch {}
    }
    if (recent.length === 0) continue;

    const allHooks = [];
    for (const session of recent) {
      if (!session.hooks || !Array.isArray(session.hooks)) continue;
      for (const h of session.hooks) {
        allHooks.push({ hook: h.hook, status: h.status || '', ms: h.ms || 0 });
      }
    }

    const groups = {};
    for (const h of allHooks) {
      if (!groups[h.hook]) groups[h.hook] = [];
      groups[h.hook].push(h);
    }

    const stats = Object.entries(groups).map(([name, entries]) => ({
      name, runs: entries.length,
      fails: entries.filter(e => e.status.startsWith('fail')).length,
      total_ms: entries.reduce((sum, e) => sum + e.ms, 0),
    }));

    for (const s of stats) {
      if (s.runs >= 2 && (s.fails / s.runs) > 0.5) {
        const pct = Math.floor((s.fails * 100) / s.runs);
        warnings.push(`WARN: ${phase} hook ${s.name} failing ${pct}% (${s.fails}/${s.runs} recent sessions)`);
      }
    }

    for (const s of stats) {
      const avg = Math.floor(s.total_ms / s.runs);
      if (avg > 5000) {
        let fix;
        if (/liveness|health|balance/.test(s.name)) fix = 'add time-based cache or move to periodic cron';
        else if (/engagement|intel/.test(s.name)) fix = 'reduce API calls or add short-circuit on empty state';
        else if (avg > 15000) fix = 'split into async background task';
        else fix = 'profile with LOG_DIR debug, check for network calls';
        warnings.push(`WARN: ${phase} hook ${s.name} slow (avg ${avg}ms across ${s.runs} sessions) → FIX: ${fix}`);
      }
    }

    const totalMs = allHooks.reduce((sum, h) => sum + h.ms, 0);
    const avgTotal = totalMs / recent.length;
    if (avgTotal > 60000) {
      warnings.push(`WARN: ${phase} hooks averaging ${Math.floor(avgTotal / 1000)}s total per session (budget drain)`);
    }
  }

  return { warnings, issueCount: warnings.length };
});

if (!hookHealth.ok) {
  summary.push('[hook-health] ERROR: runner failed');
} else {
  const r = hookHealth.result;
  totalIssues += r.issueCount;
  if (r.issueCount > 0) {
    for (const w of r.warnings) summary.push(`[hook-health] ${w}`);
  }
}

// ---- Check 4: Directive analysis ----

const directives = safeRun('directive-analysis', () => {
  if (!sessionNum || !directivesPath) return { error: 'missing args: session_num directives_path required' };

  const directivesData = JSON.parse(readFileSync(directivesPath, 'utf8'));
  let queue = { queue: [] };
  try { queue = JSON.parse(readFileSync(queuePath, 'utf8')); } catch {}
  let historyLines = [];
  try { historyLines = readFileSync(historyPath, 'utf8').split('\n'); } catch {}

  const analysis = analyzeDirectives({ sessionNum, directives: directivesData, queue, historyLines });
  const text = formatResults(analysis);

  return { text, needsAttention: analysis.needsAttention, healthy: analysis.healthy };
});

if (!directives.ok) {
  summary.push('[directive-status] ERROR: analysis failed');
} else {
  const r = directives.result;
  if (r.error) {
    summary.push(`[directive-status] ERROR: ${r.error}`);
  } else {
    // Include the directive text block
    summary.push(`[directive-status] ${r.needsAttention} need attention, ${r.healthy} healthy`);
  }
}

// ---- Check 5: Brainstorm gate ----

const brainstormGate = safeRun('brainstorm-gate', () => {
  const brainstormPath = join(DIR, 'BRAINSTORMING.md');
  const MIN_IDEAS = 3;
  let content;
  try { content = readFileSync(brainstormPath, 'utf8'); } catch { return { error: 'BRAINSTORMING.md not found' }; }

  const lines = content.split('\n');
  const totalActive = lines.filter(l => /^- \*\*/.test(l)).length;
  const freshCount = lines.filter(l => /^- \*\*.+\(added ~s[0-9]+\)/.test(l)).length;
  const deficit = Math.max(0, MIN_IDEAS - freshCount);

  return { totalActive, freshCount, deficit, healthy: deficit === 0 };
});

if (!brainstormGate.ok) {
  summary.push('[brainstorm-gate] ERROR: runner failed');
} else {
  const r = brainstormGate.result;
  if (r.error) {
    summary.push(`[brainstorm-gate] ${r.error}`);
  } else if (!r.healthy) {
    summary.push(`[brainstorm-gate] WARN: only ${r.freshCount} active idea(s) (minimum: 3). Add ${r.deficit}+ before closing.`);
  } else {
    summary.push(`[brainstorm-gate] ${r.freshCount} fresh ideas (${r.totalActive} total active) — healthy`);
  }
}

// ---- Issue summary line ----

if (totalIssues === 0) {
  summary.push('[r-prehook] ALL CLEAR: security, disk, API, logs, hooks, git posture all healthy');
} else {
  summary.push(`[r-prehook] TOTAL: ${totalIssues} issue(s) flagged`);
}

// ---- Build maintain-audit.txt content ----

const auditLines = [];
const ts = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
auditLines.push(`=== Maintenance audit ${ts} s=${sessionNum} ===`);

// Maintain-audit warnings
if (maintainAudit.ok && maintainAudit.result.issueCount > 0) {
  for (const w of maintainAudit.result.warnings) auditLines.push(w);
}

// Security posture
if (securityPosture.ok) {
  const sp = securityPosture.result;
  if (sp.clean) {
    auditLines.push('Security posture: CLEAN');
  } else {
    auditLines.push(`Security posture: ${sp.issueCount} issue(s) — R session MUST address before committing`);
    for (const i of sp.issues) auditLines.push(`${i.type}: ${i.msg}`);
  }
} else {
  auditLines.push('Security posture: ERROR (runner failed)');
}

// Hook health warnings
if (hookHealth.ok && hookHealth.result.issueCount > 0) {
  for (const w of hookHealth.result.warnings) auditLines.push(w);
}

// Directive status section
const directiveStatusLines = [];
const dts = `=== Directive status ${ts} s=${sessionNum} ===`;
directiveStatusLines.push(dts);
if (directives.ok && directives.result.text) {
  directiveStatusLines.push(directives.result.text);
} else {
  directiveStatusLines.push('ERROR: directive analysis failed');
}

auditLines.push('');
auditLines.push(...directiveStatusLines);

// Brainstorm gate
if (brainstormGate.ok && !brainstormGate.result.healthy && !brainstormGate.result.error) {
  const bg = brainstormGate.result;
  auditLines.push('');
  auditLines.push('=== Brainstorming health ===');
  auditLines.push(`WARN: BRAINSTORMING.md has only ${bg.freshCount} active idea(s) (minimum: 3). You MUST add ${bg.deficit}+ new ideas before closing this R session.`);
}

// Final line
if (totalIssues === 0) {
  auditLines.push('ALL CLEAR: security, disk, API, logs, hooks, git posture all healthy');
} else {
  auditLines.push(`TOTAL: ${totalIssues} issue(s) flagged`);
}

// ---- Output ----

const output = {
  maintain_audit: maintainAudit.ok ? maintainAudit.result : { error: maintainAudit.error },
  security_posture: securityPosture.ok ? securityPosture.result : { error: securityPosture.error },
  hook_health: hookHealth.ok ? hookHealth.result : { error: hookHealth.error },
  directive_analysis: directives.ok ? directives.result : { error: directives.error },
  brainstorm_gate: brainstormGate.ok ? brainstormGate.result : { error: brainstormGate.error },
  total_issues: totalIssues,
  summary: summary.join('\n'),
  audit_text: auditLines.join('\n'),
  directive_status_text: directiveStatusLines.join('\n'),
};

console.log(JSON.stringify(output));

#!/usr/bin/env node
/**
 * a-prehook-runner.mjs — Single-process runner for ALL A session prehook checks.
 *
 * Produces JSON with individual check results plus a pre-formatted .summary
 * field that the shell script can echo directly — eliminating ~280 lines of
 * bash/jq formatting.
 *
 * Checks (9 total, check 9 conditional):
 *   1. b-cost-trend       (module import)
 *   2. r-cost-monitor      (module import)
 *   3. hook-timing-report  (module import)
 *   4. stale-tag detection + remediation (inline + module import)
 *   5. credential health cleanup (inline)
 *   6. briefing directive staleness (inline)
 *   7. cost escalation     (module import)
 *   8. auto-retire stuck   (module import)
 *   9. stale references    (calls stale-ref-check.sh)
 *  10. dead platform DNS prune (every 50 sessions, calls prune-dead-platforms.mjs)
 *
 * Usage: node a-prehook-runner.mjs [--apply-stale-tags] [--session <num>]
 * Output: JSON with all results + .summary text
 *
 * Created: wq-971 (B#624)
 * Refactored: wq-1011 (d080) — added summary text + inline checks
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { analyze as bCostAnalyze } from './b-cost-trend.mjs';
import { analyze as rCostAnalyze } from './r-cost-monitor.mjs';
import { report as hookTimingReport } from './hook-timing-report.mjs';
import { remediate } from './stale-tag-remediate.mjs';
import { run as costEscalation } from './audit-cost-escalation.mjs';
import { autoRetireStuckItems } from './audit-stats.mjs';
import { safeRun } from './lib/runner-utils.mjs';

const args = process.argv.slice(2);
const applyTags = args.includes('--apply-stale-tags');
const sessionIdx = args.indexOf('--session');
const SESSION = sessionIdx >= 0 ? parseInt(args[sessionIdx + 1], 10) || 0 : 0;
const DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const STATE_DIR = join(process.env.HOME || '/home/moltbot', '.config/moltbook');

const summary = [];

// ---- Check 1: Cost trends (b + r) ----

const bCost = safeRun('b-cost-trend', () => bCostAnalyze());
const rCost = safeRun('r-cost-monitor', () => rCostAnalyze());

if (!bCost.ok) {
  summary.push('[cost-trend] ERROR: runner failed');
} else {
  const b = bCost.result;
  if (!b.error) {
    const s = b.status, avg = b.recentAvg, trend = b.trendPct, high = b.highCount;
    if (s === 'critical') summary.push(`[cost-trend] CRITICAL: B session avg $${avg} exceeds $3.00. Trend: ${trend}%. High-cost: ${high}/10.`);
    else if (s === 'warn') summary.push(`[cost-trend] WARN: B session avg $${avg} exceeds $2.50 or ${high}+ sessions >$3. Trend: ${trend}%.`);
    else if (s === 'watch') summary.push(`[cost-trend] WATCH: B session cost trend +${trend}% (avg $${avg}). ${high} high-cost sessions.`);
    else summary.push(`[cost-trend] OK: B session avg $${avg}, trend ${trend}%.`);
  }
}

if (!rCost.ok) {
  // silent — r cost is optional
} else {
  const r = rCost.result;
  if (!r.error) {
    const s = r.status, avg = r.postR252Avg, mon = r.monitored, rem = r.remaining;
    if (s === 'ALERT') summary.push(`[r-cost-trend] ALERT: R sessions avg $${avg} — 3+ consecutive above $2.50. Investigate R#252 scope creep.`);
    else if (s === 'MONITORING') summary.push(`[r-cost-trend] MONITORING: R sessions avg $${avg} (${mon} sampled, ${rem} remaining). wq-601 active.`);
    else if (s === 'RESOLVED') summary.push(`[r-cost-trend] RESOLVED: R session cost trend acceptable (avg $${avg}). wq-601 can be closed.`);
  }
}

// ---- Check 2: Stale references (calls stale-ref-check.sh) ----

const staleRefs = safeRun('stale-refs', () => {
  const outputFile = join(STATE_DIR, 'stale-refs.json');
  let rawOutput;
  try {
    rawOutput = execSync(`"${DIR}/stale-ref-check.sh"`, { encoding: 'utf8', timeout: 30000 });
  } catch {
    const result = { checked: new Date().toISOString(), session: SESSION, stale_count: 0, stale_refs: [], error: 'stale-ref-check.sh failed' };
    writeFileSync(outputFile, JSON.stringify(result));
    return result;
  }

  const refs = [];
  let currentFile = null;
  for (const rawLine of rawOutput.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const staleMatch = line.match(/^STALE:\s+(\S+)/);
    if (staleMatch) {
      currentFile = staleMatch[1];
    } else if (currentFile && !/^(===|No |All )/.test(line)) {
      refs.push({ deleted_file: currentFile, referenced_in: line });
    }
  }

  const result = {
    checked: new Date().toISOString(),
    session: SESSION,
    stale_count: refs.length,
    stale_refs: refs,
    has_stale: refs.length > 0,
  };
  writeFileSync(outputFile, JSON.stringify(result));
  return result;
});

if (!staleRefs.ok) {
  summary.push('[stale-refs] WARN: stale-ref-check.sh failed');
} else {
  const r = staleRefs.result;
  if (r.error) {
    summary.push('[stale-refs] WARN: stale-ref-check.sh failed');
  } else if (r.stale_count > 0) {
    const uniqueFiles = [...new Set(r.stale_refs.map(x => x.deleted_file))].length;
    summary.push(`[stale-refs] ${r.stale_count} stale reference(s) in ${uniqueFiles} deleted file(s)`);
  } else {
    summary.push('[stale-refs] OK: clean (0 stale references)');
  }
}

// ---- Check 3: Hook timing ----

const hookTiming = safeRun('hook-timing-report', () => hookTimingReport({ last: 10 }));

{
  const outputFile = join(STATE_DIR, 'hook-timing-audit.json');
  if (!hookTiming.ok) {
    writeFileSync(outputFile, JSON.stringify({ checked: new Date().toISOString(), session: SESSION, error: 'runner failed', slow_count: 0, worst_offender: null }));
    summary.push('[hook-timing] ERROR: runner failed');
  } else if (hookTiming.result.error) {
    writeFileSync(outputFile, JSON.stringify({ checked: new Date().toISOString(), session: SESSION, error: hookTiming.result.error, slow_count: 0, worst_offender: null }));
    summary.push(`[hook-timing] ERROR: ${hookTiming.result.error}`);
  } else {
    const ht = hookTiming.result;
    const degradingCount = (ht.hooks || []).filter(h => h.trend === 'degrading' && h.p95 > 1000).length;
    const auditData = {
      checked: new Date().toISOString(),
      session: SESSION,
      threshold_ms: ht.threshold_ms,
      sessions_analyzed: ht.sessions_analyzed,
      total_hooks: ht.total_hooks,
      slow_count: ht.regressions,
      worst_offender: (ht.hooks || []).length > 0 ? { hook: ht.hooks[0].hook, phase: ht.hooks[0].phase, p95: ht.hooks[0].p95, avg: ht.hooks[0].avg, trend: ht.hooks[0].trend } : null,
      degrading_count: degradingCount,
      regressions: (ht.hooks || []).filter(h => h.regression).map(h => ({ hook: h.hook, phase: h.phase, p95: h.p95, avg: h.avg, trend: h.trend })),
    };
    writeFileSync(outputFile, JSON.stringify(auditData));

    if (ht.regressions > 0) {
      const worst = (ht.hooks || []).length > 0 ? `${ht.hooks[0].hook} (${ht.hooks[0].phase}) p95=${ht.hooks[0].p95}ms avg=${ht.hooks[0].avg}ms` : 'none';
      summary.push(`[hook-timing] ${ht.regressions}/${ht.total_hooks} hooks exceed threshold. Worst: ${worst}`);
      if (degradingCount > 0) summary.push(`[hook-timing] ${degradingCount} hook(s) degrading with P95 >1000ms`);
    } else {
      summary.push(`[hook-timing] OK: 0/${ht.total_hooks} hooks exceed threshold`);
    }
  }
}

// ---- Check 4: Stale tags (detection + remediation) ----

const staleTags = safeRun('stale-tags-detect', () => {
  const outputFile = join(STATE_DIR, 'stale-tags-audit.json');
  const directivesPath = join(DIR, 'directives.json');
  const queuePath = join(DIR, 'work-queue.json');

  if (!existsSync(directivesPath) || !existsSync(queuePath)) {
    const result = { checked: new Date().toISOString(), session: SESSION, stale_count: 0, stale_items: [], error: 'missing directives.json or work-queue.json' };
    writeFileSync(outputFile, JSON.stringify(result));
    return result;
  }

  const directives = JSON.parse(readFileSync(directivesPath, 'utf8'));
  const queue = JSON.parse(readFileSync(queuePath, 'utf8'));

  const completedIds = new Set(directives.directives.filter(d => d.status === 'completed').map(d => d.id));

  const staleItems = [];
  for (const item of queue.queue) {
    if (item.status === 'done' || item.status === 'retired') continue;
    const tags = item.tags || [];
    if (tags.length === 0) continue;
    const staleDirTags = tags.filter(t => /^d\d+$/.test(t) && completedIds.has(t));
    if (staleDirTags.length > 0) {
      staleItems.push({ id: item.id, title: item.title, status: item.status, stale_tags: staleDirTags, all_tags: tags });
    }
  }

  const result = {
    checked: new Date().toISOString(),
    session: SESSION,
    completed_directives_count: completedIds.size,
    stale_count: staleItems.length,
    stale_items: staleItems,
  };
  writeFileSync(outputFile, JSON.stringify(result));
  return result;
});

// Stale tag remediation (existing module)
const staleTagResult = safeRun('stale-tag-remediate', () => {
  const origLog = console.log;
  const origError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const argv = ['node', 'stale-tag-remediate.mjs', '--json'];
    if (applyTags) argv.push('--apply');
    return remediate(argv, { exit: () => {} });
  } finally {
    console.log = origLog;
    console.error = origError;
  }
});

if (!staleTags.ok) {
  summary.push('[stale-tags] ERROR: detection failed');
} else {
  const r = staleTags.result;
  if (r.error) {
    summary.push(`[stale-tags] ERROR: ${r.error}`);
  } else if (r.stale_count > 0) {
    const items = r.stale_items.map(i => `${i.id}(${i.stale_tags.join(',')})`).join(', ');
    summary.push(`[stale-tags] ${r.stale_count} item(s) tagged with completed directives: ${items}`);
    if (staleTagResult.ok) {
      const remCount = (staleTagResult.result?.remediated || []).length;
      if (remCount > 0) summary.push(`[stale-tags] Auto-remediated ${remCount} stale tag(s) via runner`);
    }
  } else {
    summary.push('[stale-tags] OK: no stale directive tags found');
  }
}

// ---- Check 5: Credential health cleanup ----

const credHealth = safeRun('cred-health', () => {
  const stateFile = join(STATE_DIR, 'credential-health-state.json');
  if (!existsSync(stateFile)) return { status: 'no_file' };

  let data;
  try { data = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { status: 'invalid_json' }; }

  const before = Object.keys(data).length;
  const result = {};
  let stale = 0;

  for (const [key, val] of Object.entries(data)) {
    if ((val.consecutive_failures || 0) <= 0) continue;
    const age = SESSION - (val.last_session || 0);
    if (age > 50) {
      val.stale = true;
      stale++;
    }
    result[key] = val;
  }

  writeFileSync(stateFile, JSON.stringify(result, null, 2));
  const after = Object.keys(result).length;
  const pruned = before - after;

  return { before, after, pruned, stale };
});

if (!credHealth.ok) {
  summary.push('[cred-health] WARN: processing failed');
} else {
  const r = credHealth.result;
  if (r.status === 'no_file') summary.push('[cred-health] OK: no state file to clean');
  else if (r.status === 'invalid_json') summary.push('[cred-health] WARN: invalid JSON in credential-health-state.json');
  else if (r.pruned > 0 || r.stale > 0) summary.push(`[cred-health] Pruned ${r.pruned} recovered, ${r.stale} stale of ${r.before} entries`);
  else summary.push(`[cred-health] OK: ${r.after} entries, 0 recovered, 0 stale`);
}

// ---- Check 6: Briefing directive staleness ----

const briefingDirs = safeRun('briefing-directives', () => {
  const outputFile = join(STATE_DIR, 'briefing-directive-audit.json');
  const briefingPath = join(DIR, 'BRIEFING.md');
  const directivesPath = join(DIR, 'directives.json');

  if (!existsSync(briefingPath) || !existsSync(directivesPath)) {
    const result = { checked: new Date().toISOString(), session: SESSION, stale_count: 0, stale_refs: [], error: 'missing BRIEFING.md or directives.json' };
    writeFileSync(outputFile, JSON.stringify(result));
    return result;
  }

  const directives = JSON.parse(readFileSync(directivesPath, 'utf8'));
  const briefing = readFileSync(briefingPath, 'utf8');
  const lines = briefing.split('\n');

  const statusMap = {};
  const completedMap = {};
  for (const d of directives.directives) {
    statusMap[d.id] = d.status;
    completedMap[d.id] = d.completed_session || null;
  }

  const staleRefs = [];
  const seen = new Set();
  const dirPattern = /d(0\d{2})/g;
  const historicalPattern = /completed|done|closed|finished|retired|past deadline/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    dirPattern.lastIndex = 0;
    while ((match = dirPattern.exec(line)) !== null) {
      const dirId = 'd' + match[1];
      if (statusMap[dirId] !== 'completed') continue;
      if (seen.has(dirId)) continue;
      if (historicalPattern.test(line.toLowerCase())) continue;
      // Skip if directive appears inside parentheses (historical note)
      const parenPattern = new RegExp(`\\([^)]*${dirId}[^(]*\\)`);
      if (parenPattern.test(line)) continue;

      seen.add(dirId);
      staleRefs.push({
        directive: dirId,
        status: 'completed',
        completed_session: completedMap[dirId],
        briefing_line: i + 1,
        context: line.trim().length > 120 ? line.trim().slice(0, 120) + '...' : line.trim(),
      });
    }
  }

  const result = {
    checked: new Date().toISOString(),
    session: SESSION,
    stale_count: staleRefs.length,
    stale_refs: staleRefs,
    severity: staleRefs.length > 0 ? 'critical' : 'clean',
  };
  writeFileSync(outputFile, JSON.stringify(result));
  return result;
});

if (!briefingDirs.ok) {
  summary.push('[briefing-directives] ERROR: processing failed');
} else {
  const r = briefingDirs.result;
  if (r.error) {
    summary.push(`[briefing-directives] ERROR: ${r.error}`);
  } else if (r.stale_count > 0) {
    const details = r.stale_refs.map(s => `${s.directive}(completed s${s.completed_session || '?'})`).join(', ');
    summary.push(`[briefing-directives] CRITICAL: ${r.stale_count} directive(s) referenced in BRIEFING.md but completed: ${details}`);
  } else {
    summary.push('[briefing-directives] OK: no stale directive references in BRIEFING.md');
  }
}

// ---- Check 7: Cost escalation ----

const costEsc = safeRun('audit-cost-escalation', () => costEscalation());

if (!costEsc.ok) {
  summary.push('[cost-escalation] WARN: runner failed');
} else {
  const r = costEsc.result;
  if (r.error) {
    summary.push(`[cost-escalation] WARN: ${r.error}`);
  } else {
    const created = (r.items_created || []).length;
    summary.push(`[cost-escalation] OK: checked cost trends, ${created} items created.`);
    if (created > 0) {
      for (const check of (r.checks || [])) {
        if (check.action === 'created') {
          summary.push(`  → ${check.wq_id}: ${check.type} session avg $${check.last5_avg} >= $${check.threshold}`);
        }
      }
    }
  }
}

// ---- Check 8: Auto-retire stuck items ----

const autoRetire = safeRun('auto-retire-stuck', () => autoRetireStuckItems());

if (!autoRetire.ok) {
  summary.push('[auto-retire] WARN: runner failed');
} else {
  const r = autoRetire.result;
  if (r.error) {
    summary.push(`[auto-retire] WARN: ${r.error}`);
  } else if ((r.count || 0) > 0) {
    const items = (r.retired || []).map(i => `${i.id}(age:${i.age})`).join(', ');
    summary.push(`[auto-retire] Retired ${r.count} stuck item(s): ${items}`);
  } else {
    summary.push('[auto-retire] OK: no stuck items (threshold: 50 sessions)');
  }
}

// ---- Check 9: Dead platform DNS pruning (every 50 sessions) ----

if (SESSION > 0 && SESSION % 50 === 0) {
  const prunResult = safeRun('prune-dead-platforms', () => {
    const out = execSync(`node "${DIR}/prune-dead-platforms.mjs" --apply`, { encoding: 'utf8', timeout: 10000 });
    // Parse output for change summary
    const lines = out.trim().split('\n');
    const summaryLine = lines[0] || '';
    const changes = lines.filter(l => /^\s+(DEFUNCT|RESURRECTED):/.test(l)).map(l => l.trim());
    return { summaryLine, changes, applied: true };
  });

  if (!prunResult.ok) {
    summary.push(`[dead-platform-prune] WARN: runner failed (${prunResult.error})`);
  } else {
    const r = prunResult.result;
    if (r.changes.length > 0) {
      summary.push(`[dead-platform-prune] ${r.summaryLine} — ${r.changes.length} change(s) applied`);
      for (const c of r.changes) summary.push(`  → ${c}`);
    } else {
      summary.push(`[dead-platform-prune] OK: ${r.summaryLine}`);
    }
  }
} else {
  summary.push(`[dead-platform-prune] SKIP: runs every 50 sessions (next: s${SESSION > 0 ? SESSION + (50 - SESSION % 50) : 50})`);
}

summary.push(`[a-prehook] All ${SESSION > 0 && SESSION % 50 === 0 ? 9 : 8} checks complete (single node process)`);

// ---- Output ----

const output = {
  b_cost_trend: bCost.ok ? bCost.result : { error: bCost.error },
  r_cost_monitor: rCost.ok ? rCost.result : { error: rCost.error },
  hook_timing: hookTiming.ok ? hookTiming.result : { error: hookTiming.error },
  stale_tag_detect: staleTags.ok ? staleTags.result : { error: staleTags.error },
  stale_tag_remediate: staleTagResult.ok ? staleTagResult.result : { error: staleTagResult.error },
  cred_health: credHealth.ok ? credHealth.result : { error: credHealth.error },
  briefing_directives: briefingDirs.ok ? briefingDirs.result : { error: briefingDirs.error },
  cost_escalation: costEsc.ok ? costEsc.result : { error: costEsc.error },
  auto_retire: autoRetire.ok ? autoRetire.result : { error: autoRetire.error },
  stale_refs: staleRefs.ok ? staleRefs.result : { error: staleRefs.error },
  summary: summary.join('\n'),
};

console.log(JSON.stringify(output));

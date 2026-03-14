#!/usr/bin/env node
// session-context.mjs — Single-pass pre-computation of all session context.
// Replaces 7+ inline `node -e` invocations in heartbeat.sh.
// Usage: node session-context.mjs <MODE_CHAR> <COUNTER> <B_FOCUS>
// Output: JSON to stdout with all computed context fields.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { buildRPromptBlock } from './lib/r-prompt-sections.mjs';
import { buildAPromptBlock } from './lib/a-prompt-sections.mjs';
import { buildEPromptBlock } from './lib/e-prompt-sections.mjs';
import { buildBPromptBlock } from './lib/b-prompt-sections.mjs';
import { runQueuePipeline } from './lib/queue-pipeline.mjs';
import { runIntelPipeline } from './lib/intel-pipeline.mjs';
import { runBrainstormPipeline } from './lib/brainstorm-pipeline.mjs';
import { analyzeHookHealth } from './lib/hook-health.mjs';

const DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const STATE_DIR = join(process.env.HOME, '.config/moltbook');

// wq-336: Performance profiling - track timing of major sections
const timingStart = Date.now();
const timings = {};
const markTiming = (label) => { timings[label] = Date.now() - timingStart; };

// R#224: Error boundary for R prompt block subsections.
// d061 showed cascading failures in init pipeline are highest-risk bugs.
// heartbeat.sh got safe_stage() wrapping; session-context.mjs had none.
// Each R prompt subsection (impact history, intel promotion, intel capture,
// human review) is now independently wrapped so a failure in one doesn't
// kill the entire r_prompt_block assembly. Returns fallback string on error.
const safeSection = (label, fn) => {
  try {
    return fn();
  } catch (e) {
    const msg = (e.message || 'unknown error').substring(0, 80);
    result._degraded = result._degraded || [];
    result._degraded.push(`${label}: ${msg}`);
    return `\n\n### ${label}: DEGRADED\n_Error: ${msg}. Section skipped — other context intact._`;
  }
};

const MODE = process.argv[2] || 'B';
const COUNTER = parseInt(process.argv[3] || '0', 10);
// B_FOCUS arg kept for backward compat but no longer used for task selection (R#49).

// R#223: Lazy file cache — eliminates redundant readFileSync calls across sections.
// session-context.mjs previously had 35 readFileSync calls with ~15 redundant reads:
//   session-history.txt (3x), BRAINSTORMING.md (4x), directives.json (2x),
//   engagement-trace.json (3x), engagement-trace-archive.json (3x),
//   engagement-intel-archive.json (3x), engagement-intel.json (2x),
//   account-registry.json (2x).
// FileCache reads each file at most once, caching both raw text and parsed JSON.
// Benefits: fewer I/O ops, no inconsistency between reads, simpler section code.
// Note: sections that WRITE to files (BRAINSTORMING.md, work-queue.json, intel files)
// must call fc.invalidate(path) after writes so subsequent reads see updated content.
const fc = {
  _text: new Map(),
  _json: new Map(),
  /** Read file as text (cached). Returns empty string on error. */
  text(path) {
    if (this._text.has(path)) return this._text.get(path);
    let content = '';
    try { content = readFileSync(path, 'utf8'); } catch { /* missing file */ }
    this._text.set(path, content);
    return content;
  },
  /** Read file as parsed JSON (cached). Returns null on error. */
  json(path) {
    if (this._json.has(path)) return this._json.get(path);
    const raw = this.text(path);
    let parsed = null;
    try { if (raw) parsed = JSON.parse(raw); } catch { /* parse error */ }
    this._json.set(path, parsed);
    return parsed;
  },
  /** Invalidate cache for a path (call after writing to that file). */
  invalidate(path) {
    this._text.delete(path);
    this._json.delete(path);
  }
};

function readJSON(path) {
  return fc.json(path);
}

const result = {};

// R#223: Commonly-used file paths (used by FileCache and multiple sections)
// R#232: Expanded PATHS to centralize ALL file locations used across sections.
// Previously 9 paths were centralized but 8+ remained as inline join() calls,
// defeating the purpose of PATHS as a single source of truth for file locations.
const PATHS = {
  history: join(STATE_DIR, 'session-history.txt'),
  brainstorming: join(DIR, 'BRAINSTORMING.md'),
  directives: join(DIR, 'directives.json'),
  intel: join(STATE_DIR, 'engagement-intel.json'),
  intelArchive: join(STATE_DIR, 'engagement-intel-archive.json'),
  trace: join(STATE_DIR, 'engagement-trace.json'),
  traceArchive: join(STATE_DIR, 'engagement-trace-archive.json'),
  registry: join(DIR, 'account-registry.json'),
  services: join(DIR, 'services.json'),
  queueArchive: join(DIR, 'work-queue-archive.json'),
  humanReview: join(DIR, 'human-review.json'),
  auditReport: join(DIR, 'audit-report.json'),
  rCounter: join(STATE_DIR, 'r_session_counter'),
  eCounter: join(STATE_DIR, 'e_session_counter'),
  aCounter: join(STATE_DIR, 'a_session_counter'),
  bCounter: join(STATE_DIR, 'b_session_counter'),
  eContext: join(STATE_DIR, 'e-session-context.md'),
  todoFollowups: join(STATE_DIR, 'todo-followups.txt'),
  impactAnalysis: join(STATE_DIR, 'r-impact-analysis.json'),
  rImpact: join(STATE_DIR, 'r-session-impact.json'),
};

// --- Counter sync with engagement-state.json ---
const estate = readJSON(join(STATE_DIR, 'engagement-state.json'));
result.estate_session = estate?.session || 0;

// --- Queue pipeline (R#260: extracted to lib/queue-pipeline.mjs) ---
// Handles: queue load, dedup, stall detection, task selection, auto-unblock,
// auto-promote, TODO ingest, friction ingest. ~415 lines → single function call.
const { wq, queue, queueCtx, dirtyRef: wqDirtyRef, pending, blocked, retired } = runQueuePipeline({
  MODE, COUNTER, fc, PATHS, DIR, result, readJSON, markTiming
});

// --- R session context (always computed — mode downgrades happen AFTER this script) ---
// Bug fix R#51: Previously gated by `if (MODE === 'R')`, so B→R downgrades
// (queue starvation gate) left R sessions without brainstorm/intel/intake data.
// Cost of always computing: ~3 file reads, negligible.
{
  // Brainstorming pipeline: count ideas, auto-seed when below threshold.
  // R#315: Extracted to lib/brainstorm-pipeline.mjs (~130 lines → single function call).
  runBrainstormPipeline({ fc, PATHS, COUNTER, result, queue });

  // Intel pipeline: digest, auto-promote, archive (R#295: extracted to lib/intel-pipeline.mjs)
  const intel = readJSON(PATHS.intel);
  runIntelPipeline({ intel, fc, PATHS, COUNTER, result, queueCtx });

  // --- R#186: Auto-promote live platforms from services.json to account-registry (d051) ---
  // Per d051: 17 live platforms exist in services.json but were never added to account-registry,
  // so platform-picker.mjs cannot select them. The discovery→integration pipeline is broken.
  // Fix: For each live service not in account-registry, add a skeleton entry with status
  // "needs_probe" so it becomes visible to platform-picker and E sessions can probe it.
  // Log promotions to ~/.config/moltbook/logs/discovery-promotions.log for tracking.
  {
    const servicesPath = join(DIR, 'services.json');
    const registryPath = join(DIR, 'account-registry.json');
    const logPath = join(STATE_DIR, 'logs', 'discovery-promotions.log');

    // R#230: Use fc.json() instead of raw readFileSync — services.json and account-registry.json
    // are in PATHS and may be read by other sections (registry used in E session context).
    const services = fc.json(PATHS.services);
    const registry = fc.json(PATHS.registry);

    if (services && registry && Array.isArray(services.services) && Array.isArray(registry.accounts)) {
      const registryIds = new Set(registry.accounts.map(a => a.id));
      const liveServices = (services.services || []).filter(s =>
        s.liveness?.alive === true && !registryIds.has(s.id)
      );

      const promoted = [];
      for (const svc of liveServices) {
        // Create skeleton account-registry entry
        const entry = {
          id: svc.id,
          platform: svc.name || svc.id,
          auth_type: 'unknown',
          cred_file: null,
          cred_key: null,
          test: { method: 'http', url: svc.url, auth: 'none', expect: 'status_2xx' },
          status: 'needs_probe',
          notes: `Auto-promoted from services.json s${COUNTER}. ${svc.notes || ''}`.trim()
        };
        registry.accounts.push(entry);
        promoted.push(`${svc.id}: ${svc.name || svc.id} (${svc.url})`);
      }

      if (promoted.length > 0) {
        writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
        result.platforms_promoted = promoted;

        // Log to discovery-promotions.log for tracking
        try {
          const logDir = join(STATE_DIR, 'logs');
          if (!existsSync(logDir)) {
            execSync(`mkdir -p "${logDir}"`);
          }
          const logEntry = `${new Date().toISOString()} s${COUNTER}: Promoted ${promoted.length} platforms: ${promoted.join(', ')}\n`;
          let logContent = '';
          try { logContent = readFileSync(logPath, 'utf8'); } catch {}
          writeFileSync(logPath, logContent + logEntry);
        } catch { /* log failure is not fatal */ }
      }
    }
  }
  markTiming('platform_promotion');

  // Directive intake check — uses directives.json (structured system, wq-015)
  // R#230: Use fc.json(PATHS.directives) — already cached from brainstorming seed section above.
  // Eliminates second readFileSync + JSON.parse of the same file.
  {
    const dData = fc.json(PATHS.directives);
    if (dData) {
      // R#85: Only show truly pending directives. Previously `!d.acked_session` included
      // completed directives that were never formally acked (e.g. d014 completed but acked_session=null).
      const pendingDirectives = (dData.directives || []).filter(d => d.status === 'pending' || (d.status === 'active' && !d.acked_session));
      const unanswered = (dData.questions || []).filter(q => !q.answered && q.from === 'agent');
      if (pendingDirectives.length > 0) {
        result.intake_status = `NEW:${pendingDirectives.length} pending directive(s)`;
        result.pending_directives = pendingDirectives.map(d => {
          const sess = d.session ? `[s${d.session}]` : '';
          const content = (d.content || '').length > 200 ? d.content.substring(0, 200) + '...' : d.content;
          return `- ${d.id} ${sess}: ${content}`;
        }).join('\n');
      } else if (unanswered.length > 0) {
        result.intake_status = `QUESTIONS:${unanswered.length} awaiting answer`;
      } else {
        result.intake_status = 'no-op:all-acked';
      }
    } else {
      result.intake_status = 'unknown:no-directives-json';
    }
  }

  // --- Assemble full R session prompt block (R#52, R#209 mode gate) ---
  // Previously heartbeat.sh read CTX_ vars and re-assembled markdown in 40 lines of bash.
  // Now session-context.mjs outputs the complete block, ready to inject.
  // R#209: Gate behind MODE === 'R'. This block reads r-session-impact.json, human-review.json,
  // engagement-trace-archive.json, engagement-intel-archive.json — ~6 file reads + JSON parses
  // only consumed by R sessions. B→R downgrades trigger heartbeat.sh recomputation (line 136-143),
  // so skipping here for non-R modes is safe. Previously ran for all modes (R#51 removed the
  // gate to fix B→R downgrades, but the recomputation mechanism was added later in R#59).
  if (MODE === 'R') {
    // wq-531: R-prompt sections extracted to lib/r-prompt-sections.mjs
    // Makes R-specific logic independently testable and reduces main file complexity.
    result.r_prompt_block = buildRPromptBlock({ safeSection, fc, PATHS, MODE, COUNTER, result, queue });
  } // end MODE === 'R' gate (R#209)
}
markTiming('r_session_context');

// --- E session context (always computed — mode downgrades may change session type) ---
// R#92: Pre-run orchestrator for E sessions. Previously E sessions had to manually invoke
// `node engage-orchestrator.mjs` at runtime, which cost a tool call, and sessions that
// skipped or forgot it got no ROI ranking (the core of d016).
// Now session-context.mjs runs the orchestrator and embeds the output in the prompt,
// guaranteeing every E session sees the plan before its first interaction.
// R#114: Added email status detection. E sessions are authorized for email (d018).
// Pre-checking inbox count saves a tool call and ensures email is surfaced in the prompt.
{
  const servicesPath = join(DIR, 'services.json');
  const services = readJSON(servicesPath);
  if (Array.isArray(services)) {
    const uneval = services.filter(x => x.status === 'discovered' || !x.status);
    if (uneval.length > 0) {
      const pick = uneval[Math.floor(Math.random() * uneval.length)];
      result.eval_target = pick.name + ' — ' + (pick.url || 'no url') + (pick.description ? ' (' + pick.description + ')' : '');
    }
  }

  // wq-641: E session prompt block extracted to lib/e-prompt-sections.mjs
  // Makes E-specific logic independently testable and reduces main file complexity.
  if (MODE === 'E') {
    result.e_prompt_block = buildEPromptBlock({ fc, PATHS, MODE, result, DIR });
  }
}
markTiming('e_session_context');

// --- A session context (R#102, wq-196, R#258 extracted to lib/a-prompt-sections.mjs) ---
if (MODE === 'A') {
  result.a_prompt_block = buildAPromptBlock({ fc, PATHS, MODE, COUNTER, result, queue, DIR });
}
markTiming('a_session_context');

// --- wq-355: Capability surfacing ---
// Inventory configured tools with health status. Prevents forgotten capabilities.
{
  const registryPath = join(DIR, 'account-registry.json');
  const registry = readJSON(registryPath);
  if (registry?.accounts) {
    const byStatus = { live: 0, defunct: 0, unreachable: 0, error: 0, other: 0 };
    const credMissing = [];
    const liveTools = [];

    for (const acct of registry.accounts) {
      const status = (acct.last_status || acct.status || 'unknown').toLowerCase();
      if (status === 'live' || status === 'creds_ok') {
        byStatus.live++;
        liveTools.push(acct.platform || acct.id);
        // Check if credentials file exists
        if (acct.cred_file) {
          const credPath = acct.cred_file.replace(/^~/, process.env.HOME);
          if (!existsSync(credPath)) {
            credMissing.push(acct.id);
          }
        }
      } else if (status === 'defunct') {
        byStatus.defunct++;
      } else if (status === 'unreachable') {
        byStatus.unreachable++;
      } else if (status.includes('error')) {
        byStatus.error++;
      } else {
        byStatus.other++;
      }
    }

    result.capability_summary = `${byStatus.live} live, ${byStatus.defunct} defunct, ${byStatus.unreachable + byStatus.error} degraded`;
    result.live_platforms = liveTools.slice(0, 15).join(', ');
    if (credMissing.length > 0) {
      result.cred_missing = credMissing.join(', ');
    }
  }
}
markTiming('capability_surface');

// --- wq-374: EVM balance dashboard for B sessions with onchain tasks ---
// When B sessions work on d044/onchain queue items, they need wallet balances to make
// decisions (e.g. "do I have enough ETH for gas?"). Previously this required manually
// running `node base-swap.mjs balance`. Now auto-included when onchain work is detected.
// Uses subprocess call with 10s timeout to avoid blocking session startup on RPC issues.
if (MODE === 'B') {
  const ONCHAIN_TAGS = ['d044', 'onchain', 'defi', 'evm', 'swap', 'gas', 'wallet'];
  const onchainItems = queue.filter(i =>
    (i.status === 'pending' || i.status === 'in-progress') &&
    (i.tags || []).some(t => ONCHAIN_TAGS.includes(t))
  );
  if (onchainItems.length > 0) {
    try {
      const balanceOutput = execSync('node base-swap.mjs balance', {
        encoding: 'utf8',
        timeout: 10000,
        cwd: DIR,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      // Parse the human-readable output from base-swap.mjs balance:
      //   Wallet Balances on Base:
      //     Address: 0x...
      //     ETH:  0.001234
      //     USDC: 50.123456
      //     WETH: 0.000000
      const ethMatch = balanceOutput.match(/ETH:\s+([0-9.]+)/);
      const usdcMatch = balanceOutput.match(/USDC:\s+([0-9.]+)/);
      const wethMatch = balanceOutput.match(/WETH:\s+([0-9.]+)/);
      const addrMatch = balanceOutput.match(/Address:\s+(0x[a-fA-F0-9]+)/);

      if (ethMatch || usdcMatch) {
        const eth = ethMatch ? parseFloat(ethMatch[1]) : 0;
        const usdc = usdcMatch ? parseFloat(usdcMatch[1]) : 0;
        const weth = wethMatch ? parseFloat(wethMatch[1]) : 0;

        result.evm_balances = {
          eth: eth.toFixed(6),
          usdc: usdc.toFixed(2),
          weth: weth.toFixed(6),
          address: addrMatch ? addrMatch[1] : 'unknown'
        };
        // One-line summary for prompt injection
        const warnings = [];
        if (eth < 0.0005) warnings.push('LOW GAS');
        if (usdc < 10) warnings.push('LOW USDC');
        result.evm_balance_summary = `ETH: ${eth.toFixed(6)} | USDC: ${usdc.toFixed(2)} | WETH: ${weth.toFixed(6)}${warnings.length ? ' [' + warnings.join(', ') + ']' : ''}`;
        result.onchain_items = onchainItems.map(i => i.id).join(', ');
      }
    } catch (e) {
      result.evm_balance_error = (e.message || 'unknown').substring(0, 100);
    }
  }
}
markTiming('evm_balance');

// --- B session prompt block (R#261: extracted to lib/b-prompt-sections.mjs) ---
// Completes the symmetric pattern: all 4 session types now have JS-based prompt builders.
// Previously B was the only mode with prompt assembly in bash (~50 lines in heartbeat.sh).
// Must run after capability surfacing and EVM balance sections which populate result fields.
if (MODE === 'B') {
  result.b_prompt_block = buildBPromptBlock({ fc, PATHS, result });
}
markTiming('b_session_context');

// R#204→R#349: Hook health analysis extracted to lib/hook-health.mjs.
// Reads structured hook results, computes per-hook moving averages,
// surfaces actionable warnings for slow or failing hooks.
{
  const { slow, failing, warning } = analyzeHookHealth(STATE_DIR);
  if (slow.length > 0 || failing.length > 0) {
    result.hook_health = { slow, failing };
    result.hook_health_warning = warning;
  }
}
markTiming('hook_health');

// R#200: Deferred work-queue.json write — single atomic write after all mutations.
if (wqDirtyRef.value) {
  writeFileSync(join(DIR, 'work-queue.json'), JSON.stringify(wq, null, 2) + '\n');
}
markTiming('wq_write');

// wq-336: Record total time and write timing data
markTiming('total');
const timingPath = join(STATE_DIR, 'session-context-timing.json');
try {
  // Load existing history (keep last 50 entries)
  let history = [];
  if (existsSync(timingPath)) {
    const existing = JSON.parse(readFileSync(timingPath, 'utf8'));
    history = existing.history || [];
  }
  // Add this session's timing
  history.push({
    session: COUNTER,
    mode: MODE,
    timestamp: new Date().toISOString(),
    timings,
    total_ms: timings.total,
  });
  // Keep last 50
  if (history.length > 50) history = history.slice(-50);
  // Compute stats
  const recentTotals = history.map(h => h.total_ms);
  const avg = recentTotals.length > 0 ? Math.round(recentTotals.reduce((a, b) => a + b, 0) / recentTotals.length) : 0;
  const max = Math.max(...recentTotals);
  const slowSections = {};
  for (const h of history.slice(-10)) {
    for (const [k, v] of Object.entries(h.timings)) {
      if (k !== 'total') {
        const prev = h.timings[Object.keys(h.timings)[Object.keys(h.timings).indexOf(k) - 1]] || 0;
        const delta = v - prev;
        slowSections[k] = (slowSections[k] || 0) + delta;
      }
    }
  }
  writeFileSync(timingPath, JSON.stringify({
    last_updated: new Date().toISOString(),
    stats: { avg_ms: avg, max_ms: max, samples: history.length },
    slowest_sections: Object.entries(slowSections).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => ({ section: k, total_ms: v })),
    history,
  }, null, 2));
} catch {}

console.log(JSON.stringify(result));

// Also write a shell-sourceable file to eliminate per-field node process spawns.
// heartbeat.sh can `source` this instead of calling ctx() 11+ times. (R#50)
const envPath = join(STATE_DIR, 'session-context.env');
const shellLines = [];
for (const [key, val] of Object.entries(result)) {
  const s = String(val ?? '');
  if (s.includes('\n')) {
    // Multi-line values use $'...' syntax with escaped newlines, backslashes, and single quotes.
    const safe = s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
    shellLines.push(`CTX_${key.toUpperCase()}=$'${safe}'`);
  } else {
    // Single-line: standard single-quote with embedded quote escaping
    const safe = s.replace(/'/g, "'\\''");
    shellLines.push(`CTX_${key.toUpperCase()}='${safe}'`);
  }
}
writeFileSync(envPath, shellLines.join('\n') + '\n');

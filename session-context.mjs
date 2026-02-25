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
import { runQueuePipeline, isTitleDupe, STOP_WORDS } from './lib/queue-pipeline.mjs';

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
  // Brainstorming count + auto-seed when empty (R#70).
  // When brainstorming hits 0 ideas, R sessions waste budget manually generating ideas.
  // Instead, parse recent session-history.txt to extract "feat:" commits and generate
  // follow-up seed ideas (test/harden/extend patterns). This shifts replenishment from
  // expensive LLM generation to cheap deterministic pre-computation.
  let bsContent = fc.text(PATHS.brainstorming);
  let bsCount = (bsContent.match(/^- \*\*/gm) || []).length;

  if (bsCount < 3) {
    // Auto-seed (R#82): Trigger when brainstorming < 3 ideas (was === 0).
    // Dead zone bug: with 1-2 ideas, auto-seed didn't run (threshold was 0),
    // but auto-promote couldn't promote either (too few ideas vs buffer).
    // Queue starved because neither mechanism could produce work.
    // Now seeds up to 4 ideas when below the health threshold of 3.
    // Previous approach (R#71) extracted 80-char substrings of directive content as titles,
    // producing ideas like "Address: Map the entire agent ecosystem. Crawl directories, follow links from agent profi"
    // — these are unreadable when promoted to queue items and tell B sessions nothing actionable.
    // New approach: each seed has a short imperative title (<60 chars) and a description.
    // Title format matches what a B session needs: "Build X", "Add Y support", "Fix Z".
    const seeds = [];
    const maxSeeds = 4 - bsCount; // Only fill gap to target (R#82)
    const queueTitles = queue.map(i => i.title);
    // R#84: Also dedup against existing brainstorming ideas, not just queue titles.
    // Without this, auto-seed generates duplicate brainstorming entries when multiple
    // active directives share keywords (e.g. d002 and d010 both produce "Batch-evaluate
    // 5 undiscovered services"). The duplicates survive because isTitleDupe only checked
    // queue items. Now we collect existing idea titles from BRAINSTORMING.md and check both.
    const existingIdeas = [...bsContent.matchAll(/^- \*\*(.+?)\*\*/gm)].map(m => m[1].trim());
    const allTitles = [...queueTitles, ...existingIdeas];
    const isDupe = (title) => isTitleDupe(title, allTitles);

    // Source 1: Unaddressed directives — table-driven keyword→seed mapping (R#78).
    // Previously a chain of if/else blocks that was hard to extend. Now declarative:
    // each entry maps keyword patterns to a concrete seed title+description template.
    // B#454: Added minMatch field to prevent false keyword matches.
    // Previously `.some()` triggered on ANY single keyword. d067 ("cost trends")
    // falsely matched the budget row, producing wq-004 (non-actionable).
    // Now each row specifies minMatch (default 1). Rows with common single-word
    // keywords (like 'cost') use minMatch:2 to require multiple keyword hits.
    const DIRECTIVE_SEED_TABLE = [
      { keywords: ['ecosystem', 'map', 'discover', 'catalog'], title: 'Batch-evaluate 5 undiscovered services', desc: 'systematically probe unevaluated services from services.json' },
      { keywords: ['explore', 'evaluate', 'e session', 'depth'], title: 'Deep-explore one new platform end-to-end', desc: 'pick an unevaluated service, register, post, measure response' },
      { keywords: ['account', 'credential', 'cred', 'path resolution'], title: 'Fix credential management issues', desc: 'audit account-manager path resolution and platform health checks' },
      { keywords: ['budget', 'cost', 'utilization', 'spending'], minMatch: 2, title: 'Improve session budget utilization', desc: 'add retry loops or deeper exploration to underutilized sessions' },
      { skip: true, keywords: ['safety', 'hook', 'do not remove', 'do not weaken'] },
    ];
    // R#230: Use fc.json(PATHS.directives) instead of raw readFileSync.
    // directives.json is read again at line ~889 for intake check — fc ensures single read.
    {
      const dData = fc.json(PATHS.directives);
      if (dData) {
        const active = (dData.directives || []).filter(d => d.status === 'active' || d.status === 'pending');
        for (const d of active) {
          if (seeds.length >= maxSeeds) break;
          const content = (d.content || '').toLowerCase();
          const match = DIRECTIVE_SEED_TABLE.find(row => {
            const hits = row.keywords.filter(k => content.includes(k)).length;
            return hits >= (row.minMatch || 1);
          });
          if (match?.skip) continue;
          // R#86: Always include directive ID in title to prevent cross-directive
          // collisions. Previously, two directives matching the same keyword row
          // (e.g. d002 and d010 both hitting 'ecosystem') produced identical titles
          // like "Batch-evaluate 5 undiscovered services". The dedup caught this
          // within a single run but not across sessions (pre-existing dupes persisted).
          // Now titles are directive-specific: "Batch-evaluate 5 undiscovered services (d002)".
          const baseTitle = match ? match.title : `Address directive ${d.id}`;
          const title = match ? `${baseTitle} (${d.id})` : baseTitle;
          const desc = match ? match.desc : (d.content || '').substring(0, 120);
          if (!isDupe(title)) {
            seeds.push(`- **${title}**: ${desc}`);
          }
        }
      }
    }

    // Source 2: Recent session patterns — find concrete improvement opportunities
    // R#230: Use fc.text(PATHS.history) instead of raw readFileSync — already cached from stall detection.
    if (seeds.length < maxSeeds) {
      const hist = fc.text(PATHS.history);
      const lines = hist.trim().split('\n').slice(-20);
      // Find repeated build patterns (same file touched 4+ times = unstable code)
      const fileCounts = {};
      for (const line of lines) {
        const files = line.match(/files=\[([^\]]+)\]/)?.[1];
        if (files) {
          for (const f of files.split(',').map(s => s.trim())) {
            fileCounts[f] = (fileCounts[f] || 0) + 1;
          }
        }
      }
      const hotFiles = Object.entries(fileCounts)
        .filter(([f, c]) => c >= 4 && !['work-queue.json', 'BRAINSTORMING.md', 'directives.json', '(none)'].includes(f))
        .sort((a, b) => b[1] - a[1]);
      if (hotFiles.length > 0 && seeds.length < maxSeeds) {
        const top = hotFiles[0];
        const title = `Add tests for ${top[0]}`;
        if (!isDupe(title)) {
          seeds.push(`- **${title}**: Touched ${top[1]} times in last 20 sessions — stabilize with unit tests`);
        }
      }
      // E session underutilization
      const lowCostE = lines.filter(l => {
        const c = l.match(/cost=\$([0-9.]+)/); const m = l.match(/mode=([A-Z])/);
        return c && m && m[1] === 'E' && parseFloat(c[1]) < 1.0;
      });
      if (lowCostE.length >= 3 && seeds.length < maxSeeds && !isDupe('E session budget utilization')) {
        seeds.push(`- **Improve E session budget utilization**: ${lowCostE.length}/recent E sessions under $1 — add auto-retry or deeper exploration loops`);
      }
    }

    // Source 3: Queue health
    if (pending.length === 0 && seeds.length < maxSeeds && !isDupe('queue starvation')) {
      seeds.push(`- **Generate 5 concrete build tasks from open directives**: Prevent queue starvation by pre-decomposing directive work`);
    }

    if (seeds.length > 0) {
      const marker = '## Evolution Ideas';
      if (bsContent.includes(marker)) {
        bsContent = bsContent.replace(marker, marker + '\n\n' + seeds.join('\n'));
      } else {
        bsContent += '\n' + marker + '\n\n' + seeds.join('\n') + '\n';
      }
      writeFileSync(PATHS.brainstorming, bsContent);
      fc.invalidate(PATHS.brainstorming); // R#223: reset cache after write
      result.brainstorm_seeded = seeds.length;
    }
  }
  // R#87: Always recount from file content after all mutations (auto-seed + auto-promote
  // may both modify BRAINSTORMING.md). Previous code set bsCount = seeds.length after
  // seeding, which REPLACED the count instead of adding to it — a brainstorming file
  // with 2 existing ideas + 1 new seed would report bsCount=1 instead of 3. This caused
  // pipeline health snapshots to underreport, triggering false WARN alerts and unnecessary
  // re-seeding in subsequent sessions.
  const finalBs = fc.text(PATHS.brainstorming);
  result.brainstorm_count = (finalBs.match(/^- \*\*/gm) || []).length;

  // Intel inbox: count + pre-categorized digest for R session prompt injection.
  // Previously R sessions manually read, parsed, and archived intel (~5 tool calls).
  // Now pre-categorizes entries so heartbeat can inject actionable summaries. (R#48)
  const intel = readJSON(PATHS.intel);
  result.intel_count = Array.isArray(intel) ? intel.length : 0;

  if (Array.isArray(intel) && intel.length > 0) {
    const actions = { queue: [], brainstorm: [], note: [] };
    for (const entry of intel) {
      const t = entry.type || '';
      const tag = `[s${entry.session || '?'}]`;
      const summary = entry.summary || '';
      const action = entry.actionable || '';
      if ((t === 'integration_target' || t === 'pattern') && action.length > 20) {
        actions.queue.push(`${tag} ${summary} → ${action}`);
      } else if (t === 'tool_idea' || t === 'collaboration') {
        actions.brainstorm.push(`${tag} ${summary}`);
      } else {
        actions.note.push(`${tag} ${summary}`);
      }
    }
    const lines = [];
    if (actions.queue.length) {
      lines.push('**Queue candidates** (promote to wq items):');
      actions.queue.forEach(a => lines.push(`  - ${a}`));
    }
    if (actions.brainstorm.length) {
      lines.push('**Brainstorm candidates**:');
      actions.brainstorm.forEach(a => lines.push(`  - ${a}`));
    }
    if (actions.note.length) {
      lines.push('**Notes** (no action needed):');
      actions.note.forEach(a => lines.push(`  - ${a}`));
    }
    result.intel_digest = lines.join('\n');

    // --- R#140: Auto-promote intel queue candidates to work-queue (d038) ---
    // Per d038: R sessions mark intel as consumed but don't act on actionables.
    // 119 of 292 intel entries had build suggestions, 0 became queue items.
    // Fix: automatically promote intel entries tagged as "queue candidates" to actual
    // work-queue items. This closes the E→B pipeline: E sessions gather intel,
    // session-context promotes actionable intel to queue, B sessions consume queue.
    // Only promotes if queue has capacity (<5 pending) to avoid flooding.
    // Source tag: 'intel-auto' allows tracking which items came from this mechanism.
    // R#149: Fixed bug — loop was using intel.find() which always returned the same
    // entry. Now we iterate directly over the qualifying intel entries.
    if (actions.queue.length > 0 && result.pending_count < 5) {
      const promoted = [];
      // Get qualifying entries (same criteria as actions.queue population above)
      // R#157: Added 'tool_idea' to qualifying types. tool_idea entries contain
      // concrete build suggestions ("Post-hoc skill audit tool", "Universal dry-run
      // API wrapper") but were excluded, causing 0% intel→queue conversion despite
      // 20 actionable intel entries. 'threat' entries remain excluded (warnings, not tasks).
      // B#263 (wq-235): Added imperative verb filter. Per intel-promotion-tracking.json,
      // wq-187 was retired as non-actionable — its "actionable" text was philosophical
      // observation ("Apply parasitic bootstrapping pattern") rather than concrete task.
      // Now require text to start with imperative verb to ensure build-ready items.
      // R#182: Removed "Monitor" and "Track" — these generate observation tasks, not build
      // tasks (wq-249: "Monitor for mainnet deployment" retired as "not a build task").
      const IMPERATIVE_VERBS = /^(Add|Build|Create|Fix|Implement|Update|Remove|Refactor|Extract|Migrate|Integrate|Configure|Enable|Disable|Optimize|Evaluate|Test|Validate|Deploy|Setup|Write|Design)\b/i;
      // R#178: Observational language filter. wq-284/wq-285/wq-265 were retired because
      // they started with imperative verbs but contained observational/philosophical text.
      const OBSERVATIONAL_PATTERNS = /(enables|maps to|mirrors|serves as|reflects|demonstrates|indicates|suggests that|is a form of|attach to|gradient|spectrum|binary|philosophy|metaphor|\bARE\b(?!n't| not| also| both| either))/i;
      // R#182: Meta-instruction filter.
      const META_INSTRUCTION_PATTERNS = /(Add to work-queue|potential [BERA] session|as (a )?queue (item|candidate)|should (be )?(added|promoted|tracked))/i;
      const qualifyingEntries = intel.filter(e => {
        const actionable = (e.actionable || '').trim();
        const summary = (e.summary || '');
        return (e.type === 'integration_target' || e.type === 'pattern' || e.type === 'tool_idea') &&
          actionable.length > 20 &&
          IMPERATIVE_VERBS.test(actionable) &&
          !OBSERVATIONAL_PATTERNS.test(actionable) &&
          !OBSERVATIONAL_PATTERNS.test(summary) &&
          !META_INSTRUCTION_PATTERNS.test(actionable) &&
          !META_INSTRUCTION_PATTERNS.test(summary) &&
          !e._promoted;
      });
      for (let i = 0; i < qualifyingEntries.length && promoted.length < 2; i++) {
        const entry = qualifyingEntries[i];
        // R#251: Smart truncation — find word boundary instead of hard-cutting mid-word.
        // Previous 70-char hard truncation produced unclear titles like
        // "Build narrow-scope side-effect monitor for platform probes as proof-of"
        // which confuse B sessions. Now truncates at last word boundary before 80 chars,
        // or at first sentence boundary (. or —) if shorter.
        const raw = (entry.actionable || '').trim();
        let title;
        if (raw.length <= 80) {
          title = raw.replace(/\.+$/, '');
        } else {
          // Try sentence boundary first (period or em dash followed by space)
          const sentenceEnd = raw.search(/[.]\s|—\s/);
          if (sentenceEnd > 20 && sentenceEnd <= 80) {
            title = raw.substring(0, sentenceEnd).trim();
          } else {
            // Word boundary truncation
            const cut = raw.substring(0, 80);
            const lastSpace = cut.lastIndexOf(' ');
            title = lastSpace > 30 ? cut.substring(0, lastSpace) : cut;
          }
        }
        const desc = entry.summary || '';
        if (isTitleDupe(title, queueCtx.titles)) continue;
        const newId = queueCtx.createItem({
          title,
          description: `${desc} [source: engagement intel s${entry.session || '?'}]`,
          source: 'intel-auto',
          tags: ['intel']
        });
        promoted.push(newId + ': ' + title);
        entry._promoted = true;
      }
      if (promoted.length > 0) {
        result.intel_promoted = promoted;
        result.pending_count = queueCtx.pendingCount;
      }
    }

    // Auto-archive intel unconditionally (R#58, was R-only since R#56).
    // Previously gated by MODE === 'R', but B→R downgrades (queue starvation gate)
    // happen AFTER session-context.mjs runs. A downgraded session would see intel
    // in its R prompt block but entries wouldn't be archived, causing duplicates
    // on the next real R session. Same class of bug as R#51 (prompt block gate).
    // Safe to always archive: digest is computed unconditionally, and if the session
    // doesn't use the R prompt block, the entries were still consumed.
    {
      // R#225: Migrated from raw readFileSync to fc cache — eliminates 3 redundant
      // file reads (intel-archive, trace-archive, trace) that are also read by
      // intel capture diagnostic and auto-promotion sections.
      const archivePath = PATHS.intelArchive;
      let archive = [...(fc.json(archivePath) || [])]; // clone — we push into this

      // R#214: Fix session=0 tagging bug.
      // inline-intel-capture.mjs uses SESSION_NUM env var, but Claude's Bash tool
      // doesn't always inherit it, resulting in session:0 entries.
      // Backfill: find the most recent E session from trace archive to attribute
      // orphaned intel entries (session=0 or missing) to the correct E session.
      let lastESession = 0;
      try {
        let allTraces = [...(fc.json(PATHS.traceArchive) || [])];
        const current = fc.json(PATHS.trace);
        if (Array.isArray(current)) {
          const archivedSessions = new Set(allTraces.map(t => t.session));
          allTraces.push(...current.filter(t => !archivedSessions.has(t.session)));
        }
        if (allTraces.length > 0) {
          lastESession = allTraces[allTraces.length - 1].session || 0;
        }
      } catch {}

      archive.push(...intel.map(e => {
        const entry = { ...e, archived_session: COUNTER, consumed_session: COUNTER };
        // Backfill session=0 entries with last known E session number
        if ((!entry.session || entry.session === 0) && lastESession > 0) {
          entry.session = lastESession;
          entry.session_backfilled = true;
        }
        return entry;
      }));
      writeFileSync(archivePath, JSON.stringify(archive, null, 2) + '\n');
      writeFileSync(PATHS.intel, '[]\n');
      result.intel_archived = intel.length;
    }

    // B#324 (wq-364): Archive engagement-trace.json entries to prevent data loss.
    // engagement-trace.json is overwritten by each E session (single-session array).
    // Without archiving, verify-e-artifacts.mjs can only validate the most recent session.
    // Mirrors the intel archiving pattern above: append to archive, keep current file
    // intact (it's read by covenant-tracker and other post-session hooks).
    {
      // R#225: Use fc cache for trace reads (same files as intel capture diagnostic)
      try {
        const traceData = fc.json(PATHS.trace);
        if (Array.isArray(traceData) && traceData.length > 0) {
          let traceArchive = [...(fc.json(PATHS.traceArchive) || [])];
          // Deduplicate: only archive entries not already in archive (by session number)
          const archivedSessions = new Set(traceArchive.map(t => t.session));
          const newEntries = traceData.filter(t => !archivedSessions.has(t.session));
          if (newEntries.length > 0) {
            traceArchive.push(...newEntries.map(t => ({ ...t, archived_at: COUNTER })));
            writeFileSync(PATHS.traceArchive, JSON.stringify(traceArchive, null, 2) + '\n');
            result.trace_archived = newEntries.length;
          }
        }
      } catch { /* trace missing or empty — skip */ }
    }
  }

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

// R#204: Hook health analysis — closes feedback loop on slow/failing hooks.
// maintain-audit.sh detects slow hooks but nothing acts on the data. This section
// reads structured hook results (pre and post), computes per-hook moving averages,
// and surfaces actionable warnings in session context. Sessions can then:
// - R sessions: prioritize optimizing the slowest hooks
// - All sessions: see which hooks are degrading performance
// Reads last 10 entries from each results file.
{
  const hookResultFiles = [
    join(STATE_DIR, 'logs/pre-hook-results.json'),
    join(STATE_DIR, 'logs/post-hook-results.json'),
  ];
  const SLOW_THRESHOLD_MS = 5000;
  const FAIL_THRESHOLD = 3; // 3+ failures in last 10 = consistently failing
  const hookStats = {}; // hookName -> { totalMs, count, failures, phase }

  for (const filePath of hookResultFiles) {
    if (!existsSync(filePath)) continue;
    const phase = filePath.includes('pre-') ? 'pre' : 'post';
    try {
      const raw = readFileSync(filePath, 'utf8').trim();
      // File is newline-delimited JSON (one entry per session)
      const lines = raw.split('\n').slice(-10);
      for (const line of lines) {
        const entry = JSON.parse(line);
        if (!entry.hooks) continue;
        for (const h of entry.hooks) {
          const key = `${phase}:${h.hook}`;
          if (!hookStats[key]) hookStats[key] = { totalMs: 0, count: 0, failures: 0, phase, hook: h.hook };
          hookStats[key].totalMs += h.ms;
          hookStats[key].count += 1;
          if (h.status && h.status.startsWith('fail')) hookStats[key].failures += 1;
        }
      }
    } catch { /* skip malformed files */ }
  }

  const slowHooks = [];
  const failingHooks = [];

  for (const [key, stats] of Object.entries(hookStats)) {
    if (stats.count === 0) continue;
    const avgMs = Math.round(stats.totalMs / stats.count);
    if (avgMs >= SLOW_THRESHOLD_MS) {
      slowHooks.push({ hook: stats.hook, phase: stats.phase, avg_ms: avgMs, samples: stats.count });
    }
    if (stats.failures >= FAIL_THRESHOLD) {
      failingHooks.push({ hook: stats.hook, phase: stats.phase, fail_count: stats.failures, samples: stats.count });
    }
  }

  // Sort by severity (slowest first)
  slowHooks.sort((a, b) => b.avg_ms - a.avg_ms);
  failingHooks.sort((a, b) => b.fail_count - a.fail_count);

  if (slowHooks.length > 0 || failingHooks.length > 0) {
    result.hook_health = { slow: slowHooks, failing: failingHooks };
    // Build human-readable warning for session prompts
    const parts = [];
    if (slowHooks.length > 0) {
      parts.push(`${slowHooks.length} slow hook(s): ${slowHooks.map(h => `${h.phase}/${h.hook} avg ${h.avg_ms}ms`).join(', ')}`);
    }
    if (failingHooks.length > 0) {
      parts.push(`${failingHooks.length} failing hook(s): ${failingHooks.map(h => `${h.phase}/${h.hook} ${h.fail_count}/${h.samples} failures`).join(', ')}`);
    }
    result.hook_health_warning = parts.join(' | ');
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

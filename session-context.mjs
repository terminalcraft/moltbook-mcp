#!/usr/bin/env node
// session-context.mjs — Single-pass pre-computation of all session context.
// Replaces 7+ inline `node -e` invocations in heartbeat.sh.
// Usage: node session-context.mjs <MODE_CHAR> <COUNTER> <B_FOCUS>
// Output: JSON to stdout with all computed context fields.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const STATE_DIR = join(process.env.HOME, '.config/moltbook');

// wq-336: Performance profiling - track timing of major sections
const timingStart = Date.now();
const timings = {};
const markTiming = (label) => { timings[label] = Date.now() - timingStart; };

const MODE = process.argv[2] || 'B';
const COUNTER = parseInt(process.argv[3] || '0', 10);
// B_FOCUS arg kept for backward compat but no longer used for task selection (R#49).

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

const result = {};

// --- Counter sync with engagement-state.json ---
const estate = readJSON(join(STATE_DIR, 'engagement-state.json'));
result.estate_session = estate?.session || 0;

// --- Work queue context ---
const wq = readJSON(join(DIR, 'work-queue.json'));
const queue = wq?.queue || [];

// Check if all deps are satisfied. Missing deps = archived = done (per work-queue.json spec).
const depsReady = (item) => !item.deps?.length || item.deps.every(d => {
  const dep = queue.find(i => i.id === d);
  return !dep || dep.status === 'done';
});

// --- Queue self-dedup (R#67) ---
// Detect and remove duplicate queue items by normalizing titles and comparing.
// Duplicates arise from multiple sources (manual add, auto-promote, different sessions).
// wq-012/wq-013 were both "engagement replay analytics" — this prevents that class of bug.
{
  const seen = new Map(); // normalized title -> first item index
  const dupes = [];
  for (let idx = 0; idx < queue.length; idx++) {
    const norm = queue[idx].title.toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')  // strip punctuation
      .replace(/\s+/g, ' ')          // collapse whitespace
      .trim()
      .split(' ').slice(0, 6).join(' '); // first 6 words for fuzzy match
    if (seen.has(norm)) {
      // Keep the earlier item (lower index = higher priority), mark later as dupe
      dupes.push(idx);
    } else {
      seen.set(norm, idx);
    }
  }
  if (dupes.length > 0) {
    // Remove in reverse order to preserve indices
    for (let i = dupes.length - 1; i >= 0; i--) {
      const removed = queue.splice(dupes[i], 1)[0];
      result.deduped = result.deduped || [];
      result.deduped.push(removed.id + ': ' + removed.title);
    }
    writeFileSync(join(DIR, 'work-queue.json'), JSON.stringify(wq, null, 2) + '\n');
  }
}

const pending = queue.filter(i => i.status === 'pending' && depsReady(i));
const blocked = queue.filter(i => i.status === 'blocked');
const retired = queue.filter(i => i.status === 'retired');

result.pending_count = pending.length;
result.blocked_count = blocked.length;
result.retired_count = retired.length;
markTiming('queue_context');

// --- B session stall detection (wq-085) ---
// Count consecutive recent B sessions with no commits (build=(none)).
// Used by mode-transform hook to detect when B sessions are stalling.
{
  const histPath = join(STATE_DIR, 'session-history.txt');
  let bStallCount = 0;
  if (existsSync(histPath)) {
    const hist = readFileSync(histPath, 'utf8');
    // Extract B sessions in order (oldest to newest in file)
    const bSessions = [...hist.matchAll(/mode=B .* build=([^ ]+)/g)];
    // Count consecutive stalls from the end (most recent)
    for (let i = bSessions.length - 1; i >= 0; i--) {
      if (bSessions[i][1] === '(none)') {
        bStallCount++;
      } else {
        break; // Stop at first non-stalled session
      }
    }
  }
  result.b_stall_count = bStallCount;
}

// Top task for B sessions — first pending by priority, with complexity-aware selection (wq-017).
// Items may have complexity: "S" | "M" | "L". Default is "M" if unset.
// When remaining budget is tight (detected via BUDGET_CAP env), prefer smaller tasks.
// Fallback (R#62): if queue is empty, extract a brainstorming idea as a fallback task.
// Shared helper: compute max wq-NNN id from queue (R#78 — was duplicated in 2 places).
function getMaxQueueId(queue) {
  return queue.reduce((m, i) => {
    const n = parseInt((i.id || '').replace('wq-', ''), 10);
    return isNaN(n) ? m : Math.max(m, n);
  }, 0);
}

// Shared fuzzy title matcher (R#79 — was duplicated in 3 places with slight variations).
// Checks if a candidate title is "close enough" to any existing queue title to be a duplicate.
// Uses normalized prefix comparison: lowercase first 20 chars of each, bidirectional includes.
// Centralizing prevents divergent matching logic (e.g. one copy split on ':', another didn't).
function isTitleDupe(candidate, queueTitles) {
  const norm = candidate.toLowerCase().trim();
  const prefix = norm.substring(0, 25);
  return queueTitles.some(qt => {
    const qn = qt.toLowerCase().trim();
    const qp = qn.substring(0, 25);
    return qn.includes(prefix) || norm.includes(qp);
  });
}

const BUDGET_CAP = parseFloat(process.env.BUDGET_CAP || '10');
if (MODE === 'B' && pending.length > 0) {
  // Priority boost: audit-tagged items sort first (R#98). Audit items were sitting
  // at queue bottom for 5+ sessions because selection was purely positional.
  // Within each group (audit vs non-audit), original order is preserved.
  const auditFirst = [...pending].sort((a, b) => {
    const aAudit = (a.tags || []).includes('audit') ? 0 : 1;
    const bAudit = (b.tags || []).includes('audit') ? 0 : 1;
    return aAudit - bAudit;
  });
  // If multiple pending items, prefer S/M over L for budget efficiency
  const sized = auditFirst.map(i => ({ ...i, _c: (i.complexity || 'M').toUpperCase() }));
  const preferred = sized.filter(i => i._c !== 'L');
  const item = (preferred.length > 0 && BUDGET_CAP <= 5) ? preferred[0] : auditFirst[0];
  let taskText = item.id + ': ' + item.title + (item.description?.length > 20 ? ' — ' + item.description : '');
  if (item.progress_notes?.length) {
    const recent = item.progress_notes.slice(-3);
    taskText += '\n\nProgress notes from previous sessions:\n' + recent.map(n => `- [s${n.session}] ${n.text}`).join('\n');
  }
  result.wq_item = taskText;
} else if (MODE === 'B' && pending.length === 0) {
  const bsPath = join(DIR, 'BRAINSTORMING.md');
  if (existsSync(bsPath)) {
    const bs = readFileSync(bsPath, 'utf8');
    const ideas = [...bs.matchAll(/^- \*\*(.+?)\*\*:?\s*(.*)/gm)];
    // Filter out ideas already in the work queue (by fuzzy title match).
    // Prevents fallback from assigning work that's already queued/blocked/done.
    const queueTitles = queue.map(i => i.title);
    const fresh = ideas.filter(idea => !isTitleDupe(idea[1].trim(), queueTitles));
    if (fresh.length > 0) {
      const idea = fresh[0];
      result.wq_item = `BRAINSTORM-FALLBACK: ${idea[1].trim()} — ${idea[2].trim()}`;
      result.wq_fallback = true;
    }
  }
}

// Auto-unblock: check blocked items with blocker_check commands
// wq-086: Run for all session types, not just B. Maximizes chance of detecting
// when a blocker clears. Each check has 10s timeout, cost is low.
{
  const unblocked = [];
  for (const item of queue) {
    if (item.status === 'blocked' && item.status !== 'retired' && item.blocker_check) {
      try {
        execSync(item.blocker_check, { timeout: 10000, stdio: 'pipe' });
        item.status = 'pending';
        item.notes = (item.notes || '') + ` Auto-unblocked s${COUNTER}: blocker_check passed.`;
        delete item.blocker_check;
        unblocked.push(item.id);
      } catch {}
    }
  }
  if (unblocked.length > 0) {
    writeFileSync(join(DIR, 'work-queue.json'), JSON.stringify(wq, null, 2) + '\n');
    result.unblocked = unblocked;
    // Recompute pending after unblock
    result.pending_count = queue.filter(i => i.status === 'pending' && depsReady(i)).length;
  }
}
markTiming('blocker_check');

// --- Auto-promote brainstorming ideas to queue when pending < 3 (R#64, R#68, R#72, R#74) ---
// R#74: Extended auto-promote to R sessions. Previously only B sessions promoted,
// meaning R sessions that replenished brainstorming still left queue empty until
// the next B session ran. This added a full rotation cycle of latency. Now both
// B and R sessions promote, eliminating the starvation gap.
// R#72: Dynamic buffer — when queue has 0 pending items (starvation), lower buffer
// from 3 to 1 so that even 2 brainstorming ideas can produce 1 queue item.
if (MODE === 'B' || MODE === 'R') {
  const currentPending = queue.filter(i => i.status === 'pending' && depsReady(i)).length;
  if (currentPending < 3) {
    const bsPath = join(DIR, 'BRAINSTORMING.md');
    if (existsSync(bsPath)) {
      const bs = readFileSync(bsPath, 'utf8');
      const ideas = [...bs.matchAll(/^- \*\*(.+?)\*\*:?\s*(.*)/gm)];
      const queueTitles = queue.map(i => i.title);
      const fresh = ideas.filter(idea => !isTitleDupe(idea[1].trim(), queueTitles));
      // R#72/R#81: Dynamic buffer scales with queue deficit.
      // Old logic: binary 1 (starvation) or 3 (normal). Problem: with 1 pending and
      // 3 brainstorm ideas, buffer=3 blocked all promotions even though queue needed 2 more.
      // New logic: buffer = max(1, 3 - deficit), where deficit = 3 - currentPending.
      // 0 pending → buffer=1 (aggressive), 1 pending → buffer=2, 2 pending → buffer=2, 3+ → no promote.
      const deficit = 3 - currentPending;
      const BS_BUFFER = Math.max(1, 3 - deficit);
      const promotable = fresh.length > BS_BUFFER ? fresh.slice(0, fresh.length - BS_BUFFER) : [];
      const maxId = getMaxQueueId(queue);
      const promoted = [];
      for (let i = 0; i < promotable.length && currentPending + promoted.length < 3; i++) {
        const title = promotable[i][1].trim();
        const desc = promotable[i][2].trim();
        const newId = `wq-${String(maxId + 1 + i).padStart(3, '0')}`;
        const item = {
          id: newId,
          title: title,
          description: desc || 'Auto-promoted from brainstorming',
          priority: maxId + 1 + i,
          status: 'pending',
          added: new Date().toISOString().split('T')[0],
          source: 'brainstorming-auto',
          tags: [],
          commits: []
        };
        queue.push(item);
        promoted.push(newId + ': ' + title);
      }
      if (promoted.length > 0) {
        writeFileSync(join(DIR, 'work-queue.json'), JSON.stringify(wq, null, 2) + '\n');
        result.auto_promoted = promoted;
        result.pending_count = queue.filter(i => i.status === 'pending' && depsReady(i)).length;

        // R#66: Remove promoted ideas from BRAINSTORMING.md to prevent stale duplicates.
        let updated = bs;
        for (let i = 0; i < promotable.length && i < promoted.length; i++) {
          const line = promotable[i][0]; // full matched line
          updated = updated.replace(line + '\n', '');
        }
        if (updated !== bs) {
          writeFileSync(bsPath, updated);
        }
      }
    }
  }
}
markTiming('auto_promote');

// --- Auto-ingest TODO followups into queue (R#72, R#194 rework) ---
// The post-session hook (27-todo-scan.sh) writes TODO/FIXME items to todo-followups.txt.
// R#194: Historical analysis shows 100% false positive rate (13/13 todo-scan items retired).
// False positive classes: markdown tables, session summaries, JSON data, regex patterns,
// queue references, brainstorming entries. Replaced simple regex with multi-stage rejection.
if (MODE === 'B') {
  const todoPath = join(STATE_DIR, 'todo-followups.txt');
  if (existsSync(todoPath)) {
    const todoContent = readFileSync(todoPath, 'utf8');
    const todoLines = [...todoContent.matchAll(/^- (.+)/gm)];
    if (todoLines.length > 0) {
      // R#194: Multi-stage false positive rejection pipeline.
      // Each stage catches a class of non-TODO content that the scanner picks up.
      const FALSE_POSITIVE_PATTERNS = [
        // Stage 1: JS code patterns (original R#73 filter)
        /\$\{|`|=>|require\(|\.substring|\.slice|\.match|\.replace|\.push/,
        /["']title["']|["']description["']/,
        // Stage 2: Markdown table content (wq-236, wq-262)
        /^\|.*\|$/,
        // Stage 3: Session summary text (wq-297, wq-301) — starts with *R#/B#/E#/A#
        /^\*[RBEA]#\d+/,
        // Stage 4: JSON data strings (wq-142, wq-166) — starts with " or {
        /^["{}]/,
        // Stage 5: Regex/comment patterns (wq-277, wq-278, wq-279) — starts with # Pattern
        /^#\s+(Pattern|TODO|FIXME)/i,
        // Stage 6: Queue data refs (wq-242, wq-328) — contains wq-XXX placeholder
        /wq-[Xx]{3}/,
        // Stage 7: Already-a-TODO-followup (self-referential scan)
        /TODO\s+followup:/i,
        // Stage 8: Pattern/config definitions — regex literal or { pattern:
        /\{\s*pattern:|\/.*\/[gimsuy]*,/,
      ];
      const isFalsePositive = (line) => FALSE_POSITIVE_PATTERNS.some(p => p.test(line));

      const maxId = getMaxQueueId(queue);
      const queueTitles = queue.map(i => i.title.toLowerCase());
      const ingested = [];
      for (let i = 0; i < todoLines.length && i < 3; i++) {
        const raw = todoLines[i][1].trim();
        // Multi-stage rejection
        if (isFalsePositive(raw)) continue;
        // Must contain an actual TODO/FIXME keyword to be a real followup
        if (!/\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b/i.test(raw)) continue;
        // Skip if already queued (fuzzy match on first 30 chars)
        const norm = raw.toLowerCase().substring(0, 30);
        if (queueTitles.some(qt => qt.includes(norm) || norm.includes(qt.substring(0, 20)))) continue;
        const newId = `wq-${String(maxId + 1 + ingested.length).padStart(3, '0')}`;
        queue.push({
          id: newId,
          title: `TODO followup: ${raw.substring(0, 80)}`,
          description: raw,
          priority: maxId + 1 + ingested.length,
          status: 'pending',
          added: new Date().toISOString().split('T')[0],
          source: 'todo-scan',
          complexity: 'S',
          tags: ['followup'],
          commits: []
        });
        ingested.push(newId);
      }
      if (ingested.length > 0) {
        writeFileSync(join(DIR, 'work-queue.json'), JSON.stringify(wq, null, 2) + '\n');
        result.todo_ingested = ingested;
        result.pending_count = queue.filter(i => i.status === 'pending' && depsReady(i)).length;
      }
    }
  }
}

// --- Auto-ingest friction signals into queue (wq-081, B#173) ---
// The /status/patterns endpoint detects repeated file touches and suggests stabilization work.
// For R sessions, check for friction_signals and create queue items from them.
// This closes the loop: pattern detection → automated queue item generation.
// Skip in test environments (no SESSION_NUM env var means test/dev context).
if (MODE === 'R' && process.env.SESSION_NUM) {
  try {
    const patternsJson = execSync('curl -s http://localhost:3847/status/patterns', { timeout: 5000, encoding: 'utf8' });
    const patterns = JSON.parse(patternsJson);
    const signals = patterns?.friction_signals || [];
    if (signals.length > 0) {
      const maxId = getMaxQueueId(queue);
      const queueTitles = queue.map(i => i.title);
      const ingested = [];
      for (let i = 0; i < signals.length && i < 2; i++) {
        const sig = signals[i];
        const title = sig.suggestion || `Address ${sig.type} friction`;
        // Skip if already queued (fuzzy match)
        if (isTitleDupe(title, queueTitles)) continue;
        const newId = `wq-${String(maxId + 1 + ingested.length).padStart(3, '0')}`;
        queue.push({
          id: newId,
          title: title,
          description: `${sig.reason || sig.type} — auto-generated from /status/patterns friction_signals`,
          priority: maxId + 1 + ingested.length,
          status: 'pending',
          added: new Date().toISOString().split('T')[0],
          source: 'friction-signal',
          tags: ['friction'],
          commits: []
        });
        ingested.push(newId + ': ' + title);
      }
      if (ingested.length > 0) {
        writeFileSync(join(DIR, 'work-queue.json'), JSON.stringify(wq, null, 2) + '\n');
        result.friction_ingested = ingested;
        result.pending_count = queue.filter(i => i.status === 'pending' && depsReady(i)).length;
      }
    }
  } catch (e) {
    // API might be down or slow — fail silently
    result.friction_check_error = e.message?.substring(0, 100);
  }
}

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
  const bsPath = join(DIR, 'BRAINSTORMING.md');
  let bsContent = '';
  if (existsSync(bsPath)) {
    bsContent = readFileSync(bsPath, 'utf8');
  }
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
    const DIRECTIVE_SEED_TABLE = [
      { keywords: ['ecosystem', 'map', 'discover', 'catalog'], title: 'Batch-evaluate 5 undiscovered services', desc: 'systematically probe unevaluated services from services.json' },
      { keywords: ['explore', 'evaluate', 'e session', 'depth'], title: 'Deep-explore one new platform end-to-end', desc: 'pick an unevaluated service, register, post, measure response' },
      { keywords: ['account', 'credential', 'cred', 'path resolution'], title: 'Fix credential management issues', desc: 'audit account-manager path resolution and platform health checks' },
      { keywords: ['budget', 'cost', 'utilization', 'spending'], title: 'Improve session budget utilization', desc: 'add retry loops or deeper exploration to underutilized sessions' },
      { skip: true, keywords: ['safety', 'hook', 'do not remove', 'do not weaken'] },
    ];
    const directivesPath2 = join(DIR, 'directives.json');
    if (existsSync(directivesPath2)) {
      try {
        const dData = JSON.parse(readFileSync(directivesPath2, 'utf8'));
        const active = (dData.directives || []).filter(d => d.status === 'active' || d.status === 'pending');
        for (const d of active) {
          if (seeds.length >= maxSeeds) break;
          const content = (d.content || '').toLowerCase();
          const match = DIRECTIVE_SEED_TABLE.find(row => row.keywords.some(k => content.includes(k)));
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
      } catch {}
    }

    // Source 2: Recent session patterns — find concrete improvement opportunities
    const histPath = join(STATE_DIR, 'session-history.txt');
    if (existsSync(histPath) && seeds.length < maxSeeds) {
      const hist = readFileSync(histPath, 'utf8');
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
      writeFileSync(bsPath, bsContent);
      result.brainstorm_seeded = seeds.length;
    }
  }
  // R#87: Always recount from file content after all mutations (auto-seed + auto-promote
  // may both modify BRAINSTORMING.md). Previous code set bsCount = seeds.length after
  // seeding, which REPLACED the count instead of adding to it — a brainstorming file
  // with 2 existing ideas + 1 new seed would report bsCount=1 instead of 3. This caused
  // pipeline health snapshots to underreport, triggering false WARN alerts and unnecessary
  // re-seeding in subsequent sessions.
  const finalBs = existsSync(bsPath) ? readFileSync(bsPath, 'utf8') : '';
  result.brainstorm_count = (finalBs.match(/^- \*\*/gm) || []).length;

  // Intel inbox: count + pre-categorized digest for R session prompt injection.
  // Previously R sessions manually read, parsed, and archived intel (~5 tool calls).
  // Now pre-categorizes entries so heartbeat can inject actionable summaries. (R#48)
  const intelPath = join(STATE_DIR, 'engagement-intel.json');
  const intel = readJSON(intelPath);
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
      const maxId = getMaxQueueId(queue);
      const queueTitles = queue.map(i => i.title);
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
      // Examples: "enables appropriate response", "maps to circuit breaker architecture",
      // "Gradient not binary - covenants ARE partial exit". These sound like tasks but
      // are actually pattern observations. Filter them out to improve conversion rate.
      // Check BOTH actionable AND summary — wq-284/wq-285 had clean actionable text but
      // observational summaries that B sessions used to identify non-actionability.
      // R#182: Added "attach to" (wq-187: "attach to existing mechanisms").
      const OBSERVATIONAL_PATTERNS = /(enables|maps to|mirrors|serves as|reflects|demonstrates|indicates|suggests that|is a form of|attach to|gradient|spectrum|binary|philosophy|metaphor|\bARE\b(?!n't| not| also| both| either))/i;
      // R#182: Meta-instruction filter. wq-248 ("Add to work-queue as potential B session
      // project") was a meta-instruction about the queue system, not a build task. These
      // phrases indicate the intel is describing what sessions should do, not code to write.
      const META_INSTRUCTION_PATTERNS = /(Add to work-queue|potential [BERA] session|as (a )?queue (item|candidate)|should (be )?(added|promoted|tracked))/i;
      const qualifyingEntries = intel.filter(e => {
        const actionable = (e.actionable || '').trim();
        const summary = (e.summary || '');
        return (e.type === 'integration_target' || e.type === 'pattern' || e.type === 'tool_idea') &&
          actionable.length > 20 &&
          IMPERATIVE_VERBS.test(actionable) &&
          !OBSERVATIONAL_PATTERNS.test(actionable) &&  // R#178: exclude philosophical observations in title
          !OBSERVATIONAL_PATTERNS.test(summary) &&     // R#178: also check summary for observations
          !META_INSTRUCTION_PATTERNS.test(actionable) &&  // R#182: exclude meta-instructions
          !META_INSTRUCTION_PATTERNS.test(summary) &&     // R#182: also check summary
          !e._promoted;
      });
      for (let i = 0; i < qualifyingEntries.length && promoted.length < 2; i++) {
        const entry = qualifyingEntries[i];
        // Use actionable as title (truncated), summary as description
        const title = (entry.actionable || '').substring(0, 70).replace(/\.+$/, '');
        const desc = entry.summary || '';
        // Skip if already queued
        if (isTitleDupe(title, queueTitles)) continue;
        const newId = `wq-${String(maxId + 1 + promoted.length).padStart(3, '0')}`;
        queue.push({
          id: newId,
          title: title,
          description: `${desc} [source: engagement intel s${entry.session || '?'}]`,
          priority: maxId + 1 + promoted.length,
          status: 'pending',
          added: new Date().toISOString().split('T')[0],
          source: 'intel-auto',
          tags: ['intel'],
          commits: []
        });
        promoted.push(newId + ': ' + title);
        queueTitles.push(title); // Prevent duplicates within same batch
        // Mark entry as promoted to avoid re-processing if intel isn't cleared
        entry._promoted = true;
      }
      if (promoted.length > 0) {
        writeFileSync(join(DIR, 'work-queue.json'), JSON.stringify(wq, null, 2) + '\n');
        result.intel_promoted = promoted;
        result.pending_count = queue.filter(i => i.status === 'pending' && depsReady(i)).length;
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
      const archivePath = join(STATE_DIR, 'engagement-intel-archive.json');
      let archive = [];
      try { archive = JSON.parse(readFileSync(archivePath, 'utf8')); } catch {}
      archive.push(...intel.map(e => ({ ...e, archived_session: COUNTER, consumed_session: COUNTER })));
      writeFileSync(archivePath, JSON.stringify(archive, null, 2) + '\n');
      writeFileSync(intelPath, '[]\n');
      result.intel_archived = intel.length;
    }

    // B#324 (wq-364): Archive engagement-trace.json entries to prevent data loss.
    // engagement-trace.json is overwritten by each E session (single-session array).
    // Without archiving, verify-e-artifacts.mjs can only validate the most recent session.
    // Mirrors the intel archiving pattern above: append to archive, keep current file
    // intact (it's read by covenant-tracker and other post-session hooks).
    {
      const tracePath = join(STATE_DIR, 'engagement-trace.json');
      const traceArchivePath = join(STATE_DIR, 'engagement-trace-archive.json');
      try {
        const traceData = JSON.parse(readFileSync(tracePath, 'utf8'));
        if (Array.isArray(traceData) && traceData.length > 0) {
          let traceArchive = [];
          try { traceArchive = JSON.parse(readFileSync(traceArchivePath, 'utf8')); } catch {}
          // Deduplicate: only archive entries not already in archive (by session number)
          const archivedSessions = new Set(traceArchive.map(t => t.session));
          const newEntries = traceData.filter(t => !archivedSessions.has(t.session));
          if (newEntries.length > 0) {
            traceArchive.push(...newEntries.map(t => ({ ...t, archived_at: COUNTER })));
            writeFileSync(traceArchivePath, JSON.stringify(traceArchive, null, 2) + '\n');
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

    let services = null;
    let registry = null;

    try { services = JSON.parse(readFileSync(servicesPath, 'utf8')); } catch { services = null; }
    try { registry = JSON.parse(readFileSync(registryPath, 'utf8')); } catch { registry = null; }

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
  const directivesPath = join(DIR, 'directives.json');
  if (existsSync(directivesPath)) {
    try {
      const dData = JSON.parse(readFileSync(directivesPath, 'utf8'));
      // R#85: Only show truly pending directives. Previously `!d.acked_session` included
      // completed directives that were never formally acked (e.g. d014 completed but acked_session=null).
      const pendingDirectives = (dData.directives || []).filter(d => d.status === 'pending' || (d.status === 'active' && !d.acked_session));
      const unanswered = (dData.questions || []).filter(q => !q.answered && q.from === 'agent');
      if (pendingDirectives.length > 0) {
        result.intake_status = `NEW:${pendingDirectives.length} pending directive(s)`;
        // R#85: Embed pending directive summaries directly in the prompt block.
        // Previously R sessions had to spend a tool call running `node directives.mjs pending`
        // just to read directive content they could already see. Now the R prompt block includes
        // each pending directive's ID, session, and content inline. This saves 1 tool call per
        // R session and eliminates a blocking step in the directive intake flow.
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
    } catch {
      result.intake_status = 'error:parse';
    }
  } else {
    result.intake_status = 'unknown:no-directives-json';
  }

  // --- Assemble full R session prompt block (R#52) ---
  // Previously heartbeat.sh read CTX_ vars and re-assembled markdown in 40 lines of bash.
  // Now session-context.mjs outputs the complete block, ready to inject.
  // R counter: read from state file. Heartbeat increments this AFTER session-context
  // runs for R sessions, so for R mode we predict +1. For B→R downgrades, heartbeat
  // will override CTX_R_PROMPT_BLOCK's counter via sed. Acceptable approximation.
  const rCounterPath = join(STATE_DIR, 'r_session_counter');
  let rCount = '?';
  try {
    const raw = parseInt(readFileSync(rCounterPath, 'utf8').trim());
    rCount = MODE === 'R' ? raw + 1 : raw;
  } catch { rCount = MODE === 'R' ? 1 : '?'; }
  const rPending = result.pending_count || 0;
  const rBlocked = result.blocked_count || 0;
  const rBrainstorm = result.brainstorm_count || 0;
  const rIntel = result.intel_count || 0;
  const rIntake = result.intake_status || 'unknown';
  const rIntelDigest = result.intel_digest || '';

  const rRetired = result.retired_count || 0;

  // Human review queue count (d013)
  let rReviewCount = 0;
  try {
    const reviewData = JSON.parse(readFileSync(join(DIR, 'human-review.json'), 'utf8'));
    rReviewCount = (reviewData.items || []).filter(i => i.status === 'open').length;
  } catch {}

  const health = `Queue: ${rPending} pending, ${rBlocked} blocked${rRetired ? `, ${rRetired} retired` : ''} | Brainstorming: ${rBrainstorm} ideas | Intel inbox: ${rIntel} entries${rReviewCount ? ` | Human review: ${rReviewCount} open` : ''}`;

  let intakeBlock;
  if (rIntake.startsWith('no-op')) {
    intakeBlock = `### Directive intake: ${rIntake}\nNo new human directives since last intake. Skip directive intake — go straight to intel processing and evolve.`;
  } else if (result.pending_directives) {
    // R#85: Embed directive content inline — saves a tool call vs "run node directives.mjs pending".
    intakeBlock = `### Directive intake: ${rIntake}\nNEW directives detected. Run \`node directives.mjs ack <id> <session>\` after reading each one.\n\n## PENDING DIRECTIVES (from directives.json)\n${result.pending_directives}`;
  } else {
    intakeBlock = `### Directive intake: ${rIntake}\nNEW directives detected. Run \`node directives.mjs pending\` and decompose into work-queue items.`;
  }

  let urgent = '';
  if (rPending < 3) urgent += `\n- URGENT: Queue has <3 pending items (${rPending}). B sessions will starve. Promote brainstorming ideas or generate new queue items.`;
  if (rBrainstorm < 3) urgent += `\n- WARN: Brainstorming has <3 ideas (${rBrainstorm}). Add forward-looking ideas.`;
  if (rIntel > 0) urgent += `\n- ${rIntel} engagement intel entries awaiting consumption.`;
  if (rReviewCount > 0) urgent += `\n- ${rReviewCount} item(s) in human review queue. Use \`human_review_list\` to view. Do NOT act on these — they await human decision.`;
  if (rIntelDigest) {
    urgent += `\n\n### Intel digest (pre-categorized, auto-archived):\n${rIntelDigest}\nProcess these: promote queue candidates to work-queue.json, add brainstorm candidates to BRAINSTORMING.md. Archiving is handled automatically — no manual archive step needed.`;
  }

  // wq-158: R session impact summary — pre-compute and inject into prompt
  // Saves a tool call vs running `node r-impact-digest.mjs` manually in step 3
  let impactSummary = '';
  try {
    const impactPath = join(STATE_DIR, 'r-session-impact.json');
    if (existsSync(impactPath)) {
      const impactData = JSON.parse(readFileSync(impactPath, 'utf8'));
      const analysis = impactData.analysis || [];
      const pending = (impactData.changes || []).filter(c => !c.analyzed);
      if (analysis.length > 0 || pending.length > 0) {
        const catStats = {};
        for (const a of analysis) {
          const cat = a.category || 'unknown';
          if (!catStats[cat]) catStats[cat] = { pos: 0, neg: 0, neu: 0 };
          const imp = a.impact || 'neutral';
          if (imp === 'positive') catStats[cat].pos++;
          else if (imp === 'negative') catStats[cat].neg++;
          else catStats[cat].neu++;
        }
        const recs = [];
        for (const [cat, s] of Object.entries(catStats)) {
          const total = s.pos + s.neg + s.neu;
          if (total === 0) continue;
          const posPct = (s.pos / total) * 100;
          const negPct = (s.neg / total) * 100;
          let rec = 'NEUTRAL';
          if (negPct > 50) rec = 'AVOID';
          else if (posPct > 50) rec = 'PREFER';
          recs.push(`${cat}: ${rec} (${s.pos}+ ${s.neg}- ${s.neu}=)`);
        }
        const recsText = recs.length > 0 ? recs.join(', ') : 'no category data';
        const pendingText = pending.length > 0 ? ` | ${pending.length} changes pending analysis` : '';
        impactSummary = `\n\n### Impact history (wq-158):\n${analysis.length} analyzed changes. Recommendations: ${recsText}${pendingText}`;
        if (pending.length > 0 && COUNTER > 0) {
          const nextAnalysis = pending.filter(p => {
            const sessionsUntil = 10 - (COUNTER - (p.session || 0));
            return sessionsUntil > 0 && sessionsUntil <= 3;
          });
          if (nextAnalysis.length > 0) {
            impactSummary += `\nSoon: ${nextAnalysis.map(p => `s${p.session} ${p.file} (${10 - (COUNTER - (p.session || 0))} sessions left)`).join(', ')}`;
          }
        }
      }
    }
  } catch {}

  // wq-191: Intel promotion visibility — show recently-promoted intel items and their outcomes
  // Closes the feedback loop on whether E→B pipeline produces outcomes
  // wq-216: Added capacity-awareness — distinguish "0% - capacity gated" from "0% - no actionable"
  let intelPromoSummary = '';
  {
    const intelItems = queue.filter(i => i.source === 'intel-auto');
    if (intelItems.length > 0) {
      const byStatus = { pending: [], done: [], retired: [], 'in-progress': [] };
      for (const item of intelItems) {
        const s = item.status || 'pending';
        if (byStatus[s]) byStatus[s].push(item);
        else byStatus.pending.push(item);
      }
      const parts = [];
      if (byStatus.pending.length) parts.push(`${byStatus.pending.length} pending`);
      if (byStatus['in-progress'].length) parts.push(`${byStatus['in-progress'].length} in-progress`);
      if (byStatus.done.length) parts.push(`${byStatus.done.length} done`);
      if (byStatus.retired.length) parts.push(`${byStatus.retired.length} retired`);
      const convRate = intelItems.length > 0
        ? Math.round((byStatus.done.length / intelItems.length) * 100)
        : 0;
      intelPromoSummary = `\n\n### Intel→Queue pipeline (wq-191):\n${intelItems.length} items auto-promoted from engagement intel. Status: ${parts.join(', ')}. Conversion rate: ${convRate}%.`;
      // Show recent pending items for visibility
      if (byStatus.pending.length > 0) {
        const recent = byStatus.pending.slice(0, 3).map(i => `  - ${i.id}: ${i.title.substring(0, 50)}`).join('\n');
        intelPromoSummary += `\nPending intel items:\n${recent}`;
      }
    } else {
      // wq-216: No intel-auto items yet — explain why (capacity gate vs no actionable intel)
      // Check if there's pending intel that could be promoted
      const intelPath = join(STATE_DIR, 'engagement-intel.json');
      const archivePath = join(STATE_DIR, 'engagement-intel-archive.json');
      let hasActionableIntel = false;
      let capacityGated = false;

      // Check current intel inbox
      try {
        const currentIntel = JSON.parse(readFileSync(intelPath, 'utf8'));
        if (Array.isArray(currentIntel)) {
          const actionable = currentIntel.filter(e =>
            (e.type === 'integration_target' || e.type === 'pattern') &&
            (e.actionable || '').length > 20
          );
          hasActionableIntel = actionable.length > 0;
        }
      } catch { /* empty or missing */ }

      // Check if queue was at capacity during last promotion attempt
      // Archive entries with _promoted flag indicate successful promotions happened before
      // If pending >= 5, promotions are blocked by capacity gate
      capacityGated = result.pending_count >= 5;

      if (capacityGated && hasActionableIntel) {
        intelPromoSummary = `\n\n### Intel→Queue pipeline (wq-191):\n0 items promoted — CAPACITY GATED (${result.pending_count} pending >= 5). Actionable intel exists but promotion blocked until queue capacity frees.`;
      } else if (!hasActionableIntel) {
        // Check archive for past promotions
        let archivedPromoCount = 0;
        try {
          const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
          archivedPromoCount = (archive || []).filter(e => e._promoted).length;
        } catch { /* no archive */ }
        if (archivedPromoCount > 0) {
          intelPromoSummary = `\n\n### Intel→Queue pipeline (wq-191):\n0 items currently promoted. ${archivedPromoCount} historical promotions (now archived/processed).`;
        }
        // else: no summary needed — no intel pipeline activity at all
      }
    }
  }

  // R#173: Intel capture rate diagnostic (updated B#324 to use trace archive)
  // Cross-references engagement-trace-archive.json + current trace with intel archive
  // to compute how many E sessions actually generated intel entries.
  // Surfaces the pattern: "E sessions engaging but not capturing intel."
  let intelCaptureWarning = '';
  {
    try {
      const tracePath = join(STATE_DIR, 'engagement-trace.json');
      const traceArchivePath = join(STATE_DIR, 'engagement-trace-archive.json');
      const archivePath = join(STATE_DIR, 'engagement-intel-archive.json');
      // Merge trace archive + current trace for full E session history
      let allTraces = [];
      try { allTraces = JSON.parse(readFileSync(traceArchivePath, 'utf8')); } catch {}
      try {
        const current = JSON.parse(readFileSync(tracePath, 'utf8'));
        if (Array.isArray(current)) {
          // Deduplicate by session number (current may overlap with archive)
          const archivedSessions = new Set(allTraces.map(t => t.session));
          allTraces.push(...current.filter(t => !archivedSessions.has(t.session)));
        }
      } catch {}
      const archive = JSON.parse(readFileSync(archivePath, 'utf8'));

      if (Array.isArray(allTraces) && allTraces.length > 0) {
        // Get last 10 E sessions from combined trace history
        const recentESessions = allTraces.slice(-10).map(t => t.session);

        // Count which E sessions generated intel (check archive for matching session numbers)
        const sessionsWithIntel = new Set(
          (archive || []).map(e => e.session || e.archived_session).filter(s => recentESessions.includes(s))
        );

        const captureRate = recentESessions.length > 0
          ? Math.round((sessionsWithIntel.size / recentESessions.length) * 100)
          : 0;

        if (captureRate < 50 && recentESessions.length >= 5) {
          intelCaptureWarning = `\n\n### Intel Capture Alert (R#173):\nOnly ${sessionsWithIntel.size}/${recentESessions.length} recent E sessions (${captureRate}%) generated intel entries. E sessions are engaging but not capturing actionable insights. Review SESSION_ENGAGE.md Phase 3b compliance.`;
        }
      }
    } catch { /* trace or archive missing/empty — no diagnostic */ }
  }

  result.r_prompt_block = `## R Session: #${rCount}
This is R session #${rCount}. Follow the checklist in SESSION_REFLECT.md.

### Pipeline health snapshot:
${health}${impactSummary}${intelPromoSummary}${intelCaptureWarning}

${intakeBlock}${urgent}`;
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

  // Pre-run orchestrator and capture its human-readable output
  if (MODE === 'E') {
    try {
      const orchOutput = execSync('node engage-orchestrator.mjs', {
        encoding: 'utf8',
        timeout: 45000,
        cwd: DIR,
        stdio: ['pipe', 'pipe', 'pipe'], // capture stderr too
      });
      if (orchOutput && orchOutput.trim().length > 20) {
        result.e_orchestrator_output = orchOutput.trim();
      }
    } catch (e) {
      result.e_orchestrator_error = (e.message || 'unknown').substring(0, 200);
    }

    // Build the E prompt block with orchestrator output embedded
    const orchSection = result.e_orchestrator_output
      ? `### Orchestrator output (auto-generated, d016 tools active)\n\`\`\`\n${result.e_orchestrator_output}\n\`\`\`\n\nThe above is your session plan. Engage platforms in ROI order.`
      : result.e_orchestrator_error
        ? `### Orchestrator failed: ${result.e_orchestrator_error}\nRun \`node engage-orchestrator.mjs\` manually or fall back to Phase 1 platform health check.`
        : '';

    // E session counter (analogous to R session counter)
    const eCounterPath = join(STATE_DIR, 'e_session_counter');
    let eCount = '?';
    try {
      const raw = parseInt(readFileSync(eCounterPath, 'utf8').trim());
      eCount = MODE === 'E' ? raw + 1 : raw;
    } catch { eCount = MODE === 'E' ? 1 : '?'; }

    // Fold in previous engagement context (was manually assembled in heartbeat.sh)
    let prevEngageCtx = '';
    const eCtxPath = join(STATE_DIR, 'e-session-context.md');
    try {
      const raw = readFileSync(eCtxPath, 'utf8').trim();
      if (raw) prevEngageCtx = `\n\n## Previous engagement context (auto-generated)\n${raw}`;
    } catch { /* no previous context */ }

    // Fold in eval target (was manually assembled in heartbeat.sh)
    let evalBlock = '';
    if (result.eval_target) {
      evalBlock = `\n\n## YOUR DEEP-DIVE TARGET (from services.json):\n${result.eval_target}\n\nSpend 3-5 minutes actually exploring this service. Read content, sign up if possible, interact if alive, reject if dead. See SESSION_ENGAGE.md Deep dive section.`;
    }

    // R#114: Email status detection — E sessions are authorized for email (d018/d030).
    // Pre-check inbox count to surface pending emails in the prompt. This replaces
    // the manual email_list call at the start of E sessions, saving a tool call.
    // Only runs if AgentMail credentials are configured.
    let emailBlock = '';
    const emailCredsPath = join(process.env.HOME, '.agentmail-creds.json');
    if (existsSync(emailCredsPath)) {
      try {
        const creds = JSON.parse(readFileSync(emailCredsPath, 'utf8'));
        if (creds.api_key && creds.inbox_id) {
          // Check inbox for messages via API (5s timeout)
          const inboxResp = execSync(
            `curl -s --max-time 5 -H "Authorization: Bearer ${creds.api_key}" "https://api.agentmail.to/v0/inboxes/${creds.inbox_id}/messages?limit=5"`,
            { encoding: 'utf8', timeout: 8000 }
          );
          const inbox = JSON.parse(inboxResp);
          const msgCount = inbox.count || (inbox.messages || []).length;
          result.email_configured = true;
          result.email_inbox = creds.email_address || creds.inbox_id;
          result.email_count = msgCount;
          if (msgCount > 0) {
            // Build summary of recent messages
            const msgs = (inbox.messages || []).slice(0, 3);
            const msgSummary = msgs.map(m => {
              const from = m.from?.email || m.from || 'unknown';
              const subj = m.subject || '(no subject)';
              return `  - "${subj}" from ${from}`;
            }).join('\n');
            emailBlock = `\n\n### Email (${msgCount} messages in ${creds.email_address || creds.inbox_id})\n${msgSummary}\n\nUse \`email_list\` and \`email_read <id>\` to view full content. Reply with \`email_reply\`.`;
          } else {
            emailBlock = `\n\n### Email: 0 messages in ${creds.email_address || creds.inbox_id}`;
          }
        }
      } catch (e) {
        // Email check failed — note it but don't block session
        result.email_error = (e.message || 'unknown').substring(0, 100);
        emailBlock = `\n\n### Email: configured but check failed (${result.email_error}). Use \`email_list\` to check manually.`;
      }
    }

    // wq-220: Covenant tracking — pre-compute covenant digest for E session prompt.
    // This identifies agents we've had consistent mutual engagement with across sessions,
    // helping E sessions prioritize relationship maintenance over random engagement.
    let covenantBlock = '';
    try {
      const covenantOutput = execSync('node covenant-tracker.mjs digest', {
        encoding: 'utf8',
        timeout: 5000,
        cwd: DIR,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      if (covenantOutput && covenantOutput.trim() && !covenantOutput.includes('No covenants')) {
        covenantBlock = `\n\n### Agent covenants (wq-220)\n${covenantOutput.trim()}\n\nPrioritize engagement with covenant agents when you see their threads.`;
      }
    } catch {
      // Covenant check failed — skip silently
    }

    // wq-368: Surface capability summary in E session prompt
    let capBlock = '';
    if (result.capability_summary) {
      capBlock = `\n\nCapabilities: ${result.capability_summary}. Live: ${result.live_platforms || 'none'}.`;
      if (result.cred_missing) capBlock += `\nWARN: Missing credential files: ${result.cred_missing}`;
    }

    result.e_prompt_block = `## E Session: #${eCount}
This is engagement session #${eCount}. Follow SESSION_ENGAGE.md.

${orchSection}${prevEngageCtx}${evalBlock}${emailBlock}${covenantBlock}${capBlock}`.trim();
  }
}
markTiming('e_session_context');

// --- A session context (R#102, wq-196) ---
// Audit sessions previously got no pre-computed context. Now they get:
// 1. Session counter for tracking
// 2. Previous audit findings summary (delta tracking)
// 3. Audit-tagged queue item status (pending vs completed since last audit)
// 4. Quick cost trend indicator
// 5. (wq-196) Pre-run audit-stats.mjs output embedded in prompt — saves a tool call
// 6. (wq-196) Previous recommendations with status for lifecycle tracking
if (MODE === 'A') {
  // A session counter
  const aCounterPath = join(STATE_DIR, 'a_session_counter');
  let aCount = '?';
  try {
    const raw = parseInt(readFileSync(aCounterPath, 'utf8').trim());
    aCount = raw + 1; // Heartbeat increments after this script
  } catch { aCount = 1; }

  // Previous audit findings — enhanced to include recommendation lifecycle data (wq-196)
  let prevAuditSummary = '';
  let prevRecommendations = [];
  const auditReportPath = join(DIR, 'audit-report.json');
  try {
    const prev = JSON.parse(readFileSync(auditReportPath, 'utf8'));
    const prevSession = prev.session || '?';
    const criticalCount = (prev.critical_issues || []).length;
    const recCount = (prev.recommended_actions || []).length;
    prevAuditSummary = `Previous audit: s${prevSession} (A#${prev.audit_number || '?'}) — ${criticalCount} critical issues, ${recCount} recommendations`;
    if (criticalCount > 0) {
      const criticalList = (prev.critical_issues || []).slice(0, 3).map(c =>
        typeof c === 'string' ? c : (c.description || c.id || JSON.stringify(c))
      );
      prevAuditSummary += `\nCritical: ${criticalList.join(', ')}${criticalCount > 3 ? '...' : ''}`;
    }
    // wq-196: Extract previous recommendations for lifecycle tracking
    prevRecommendations = (prev.recommended_actions || []).map(r => ({
      id: r.id,
      description: (r.description || '').substring(0, 120),
      priority: r.priority || 'unknown',
      type: r.type || 'unknown',
      deadline: r.deadline_session
    }));
  } catch {
    prevAuditSummary = 'No previous audit report found.';
  }

  // Audit-tagged queue items status
  const auditItems = queue.filter(i => (i.tags || []).includes('audit'));
  const auditPending = auditItems.filter(i => i.status === 'pending').length;
  const auditDone = auditItems.filter(i => i.status === 'done').length;
  const auditStatus = `Audit-tagged queue items: ${auditPending} pending, ${auditDone} done (of ${auditItems.length} total)`;

  // Quick cost trend from session history
  let costTrend = '';
  const histPath = join(STATE_DIR, 'session-history.txt');
  try {
    const hist = readFileSync(histPath, 'utf8');
    const costs = [...hist.matchAll(/cost=\$([0-9.]+)/g)].map(m => parseFloat(m[1]));
    if (costs.length >= 5) {
      const recent5 = costs.slice(-5);
      const prev5 = costs.slice(-10, -5);
      const recentAvg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
      const prevAvg = prev5.length > 0 ? prev5.reduce((a, b) => a + b, 0) / prev5.length : recentAvg;
      const trend = recentAvg > prevAvg * 1.2 ? '↑ increasing' : recentAvg < prevAvg * 0.8 ? '↓ decreasing' : '→ stable';
      costTrend = `Cost trend (last 5 sessions avg $${recentAvg.toFixed(2)}): ${trend}`;
    }
  } catch { /* no history */ }

  // wq-196: Pre-run audit-stats.mjs and embed output
  // This saves the tool call that A sessions previously had to make manually.
  // The output is a compact summary of pipeline health, queue status, and session stats.
  let auditStatsOutput = '';
  try {
    const statsRaw = execSync('node audit-stats.mjs', {
      encoding: 'utf8',
      timeout: 15000,
      cwd: DIR,
      env: { ...process.env, SESSION_NUM: String(COUNTER) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stats = JSON.parse(statsRaw);
    // Format as compact human-readable summary instead of raw JSON
    const lines = [];
    // Pipelines
    const p = stats.pipelines || {};
    if (p.intel) lines.push(`Intel: ${p.intel.current} current, ${p.intel.archived} archived, ${p.intel.consumption_rate} consumed — ${p.intel.verdict}`);
    if (p.brainstorming) lines.push(`Brainstorming: ${p.brainstorming.active} active, ${p.brainstorming.stale_count} stale — ${p.brainstorming.verdict}`);
    if (p.queue) {
      const stuck = p.queue.stuck_items?.length || 0;
      lines.push(`Queue: ${p.queue.total} total, ${p.queue.by_status?.pending || 0} pending, ${stuck} stuck — ${p.queue.verdict}`);
    }
    if (p.directives) lines.push(`Directives: ${p.directives.total} total, ${p.directives.active} active, ${p.directives.unacted_active?.length || 0} unacted — ${p.directives.verdict}`);
    // Sessions
    const s = stats.sessions?.summary || {};
    for (const type of ['B', 'E', 'R', 'A']) {
      if (s[type]) {
        lines.push(`${type} sessions: ${s[type].count_in_history} in history, avg cost $${s[type].avg_cost_last_10} — ${s[type].verdict}`);
      }
    }
    auditStatsOutput = lines.join('\n');
  } catch (e) {
    auditStatsOutput = `audit-stats.mjs failed: ${(e.message || 'unknown').substring(0, 100)}`;
  }

  // wq-196: Format previous recommendations for lifecycle tracking
  let recLifecycleBlock = '';
  if (prevRecommendations.length > 0) {
    const recLines = prevRecommendations.map(r => {
      const deadline = r.deadline ? ` (deadline: s${r.deadline})` : '';
      return `- ${r.id} [${r.priority}]: ${r.description}${deadline}`;
    });
    recLifecycleBlock = `\n\n### Previous recommendations (MUST track status)\n${recLines.join('\n')}\n\nFor EACH recommendation above, determine status: resolved | in_progress | superseded | stale.\nStale recommendations (2+ audits with no progress) MUST escalate to critical_issues.`;
  } else {
    recLifecycleBlock = '\n\n### Previous recommendations: none — clean slate from last audit.';
  }

  result.a_prompt_block = `## A Session: #${aCount}
This is audit session #${aCount}. Follow the full checklist in SESSION_AUDIT.md.

### Pre-computed stats (from audit-stats.mjs — no need to run manually)
${auditStatsOutput}

### Context summary
- ${prevAuditSummary}
- ${auditStatus}
${costTrend ? `- ${costTrend}` : ''}${recLifecycleBlock}

**Remember**: All 5 sections are mandatory. Create work-queue items with \`["audit"]\` tag for every recommendation.`.trim();
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

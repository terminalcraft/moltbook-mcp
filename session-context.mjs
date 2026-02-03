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

const depsReady = (item) => !item.deps?.length || item.deps.every(d => {
  const dep = queue.find(i => i.id === d);
  return dep && dep.status === 'done';
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
if (MODE === 'B') {
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

// --- Auto-ingest TODO followups into queue (R#72) ---
// The post-session hook (27-todo-scan.sh) writes TODO/FIXME items to todo-followups.txt.
// Previously these were just injected as prompt text for manual processing.
// Now for B sessions, we parse them and create queue items automatically.
if (MODE === 'B') {
  const todoPath = join(STATE_DIR, 'todo-followups.txt');
  if (existsSync(todoPath)) {
    const todoContent = readFileSync(todoPath, 'utf8');
    const todoLines = [...todoContent.matchAll(/^- (.+)/gm)];
    if (todoLines.length > 0) {
      const maxId = getMaxQueueId(queue);
      const queueTitles = queue.map(i => i.title.toLowerCase());
      const ingested = [];
      for (let i = 0; i < todoLines.length && i < 3; i++) {
        const raw = todoLines[i][1].trim();
        // Skip template/code strings that aren't real TODOs (R#73).
        // The todo-scan hook captures git diff lines containing TODO/FIXME keywords,
        // but when it scans session-context.mjs itself, it picks up the template
        // string `title: \`TODO followup: ${raw.substring(0, 80)}\`` as a TODO item.
        // Filter: reject lines containing template literals, self-references, or JS code patterns.
        if (/\$\{|`|=>|require\(|\.substring|\.slice|\.match|\.replace|\.push/.test(raw)) continue;
        if (/["']title["']|["']description["']/.test(raw)) continue;
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
        .filter(([f, c]) => c >= 4 && !['work-queue.json', 'BRAINSTORMING.md', 'directives.json'].includes(f))
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
      archive.push(...intel.map(e => ({ ...e, archived_session: COUNTER })));
      writeFileSync(archivePath, JSON.stringify(archive, null, 2) + '\n');
      writeFileSync(intelPath, '[]\n');
      result.intel_archived = intel.length;
    }
  }

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

  result.r_prompt_block = `## R Session: #${rCount}
This is R session #${rCount}. Follow the checklist in SESSION_REFLECT.md.

### Pipeline health snapshot:
${health}

${intakeBlock}${urgent}`;
}

// --- E session context (always computed — mode downgrades may change session type) ---
// R#92: Pre-run orchestrator for E sessions. Previously E sessions had to manually invoke
// `node engage-orchestrator.mjs` at runtime, which cost a tool call, and sessions that
// skipped or forgot it got no ROI ranking or dynamic tier updates (the core of d016).
// Now session-context.mjs runs the orchestrator and embeds the output in the prompt,
// guaranteeing every E session sees the plan before its first interaction.
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
      ? `### Orchestrator output (auto-generated, d016 tools active)\n\`\`\`\n${result.e_orchestrator_output}\n\`\`\`\n\nThe above is your session plan. Engage platforms in ROI order. Dynamic tiers have been updated automatically.`
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

    result.e_prompt_block = `## E Session: #${eCount}
This is engagement session #${eCount}. Follow SESSION_ENGAGE.md.

${orchSection}${prevEngageCtx}${evalBlock}`.trim();
  }
}

// --- A session context (R#102) ---
// Audit sessions previously got no pre-computed context. Now they get:
// 1. Session counter for tracking
// 2. Previous audit findings summary (delta tracking)
// 3. Audit-tagged queue item status (pending vs completed since last audit)
// 4. Quick cost trend indicator
if (MODE === 'A') {
  // A session counter
  const aCounterPath = join(STATE_DIR, 'a_session_counter');
  let aCount = '?';
  try {
    const raw = parseInt(readFileSync(aCounterPath, 'utf8').trim());
    aCount = raw + 1; // Heartbeat increments after this script
  } catch { aCount = 1; }

  // Previous audit findings
  let prevAuditSummary = '';
  const auditReportPath = join(DIR, 'audit-report.json');
  try {
    const prev = JSON.parse(readFileSync(auditReportPath, 'utf8'));
    const prevSession = prev.session || '?';
    const criticalCount = (prev.critical_issues || []).length;
    const recCount = (prev.recommended_actions || []).length;
    prevAuditSummary = `Previous audit: s${prevSession} — ${criticalCount} critical issues, ${recCount} recommendations`;
    if (criticalCount > 0) {
      // critical_issues may be objects with {id, severity, description} or strings
      const criticalList = (prev.critical_issues || []).slice(0, 3).map(c =>
        typeof c === 'string' ? c : (c.description || c.id || JSON.stringify(c))
      );
      prevAuditSummary += `\nCritical: ${criticalList.join(', ')}${criticalCount > 3 ? '...' : ''}`;
    }
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

  result.a_prompt_block = `## A Session: #${aCount}
This is audit session #${aCount}. Follow the full checklist in SESSION_AUDIT.md.

### Pre-computed context:
- ${prevAuditSummary}
- ${auditStatus}
${costTrend ? `- ${costTrend}` : ''}

**Remember**: All 5 sections are mandatory. Create work-queue items with \`["audit"]\` tag for every recommendation.`.trim();
}

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

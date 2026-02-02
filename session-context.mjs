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

result.pending_count = pending.length;
result.blocked_count = blocked.length;

// Top task for B sessions — first pending by priority, with complexity-aware selection (wq-017).
// Items may have complexity: "S" | "M" | "L". Default is "M" if unset.
// When remaining budget is tight (detected via BUDGET_CAP env), prefer smaller tasks.
// Fallback (R#62): if queue is empty, extract a brainstorming idea as a fallback task.
const BUDGET_CAP = parseFloat(process.env.BUDGET_CAP || '10');
if (MODE === 'B' && pending.length > 0) {
  // If multiple pending items, prefer S/M over L for budget efficiency
  const sized = pending.map(i => ({ ...i, _c: (i.complexity || 'M').toUpperCase() }));
  const preferred = sized.filter(i => i._c !== 'L');
  const item = (preferred.length > 0 && BUDGET_CAP <= 5) ? preferred[0] : pending[0];
  result.wq_item = item.id + ': ' + item.title + (item.description?.length > 20 ? ' — ' + item.description : '');
} else if (MODE === 'B' && pending.length === 0) {
  const bsPath = join(DIR, 'BRAINSTORMING.md');
  if (existsSync(bsPath)) {
    const bs = readFileSync(bsPath, 'utf8');
    const ideas = [...bs.matchAll(/^- \*\*(.+?)\*\*:?\s*(.*)/gm)];
    // Filter out ideas already in the work queue (by fuzzy title match).
    // Prevents fallback from assigning work that's already queued/blocked/done.
    const queueTitles = queue.map(i => i.title.toLowerCase());
    const fresh = ideas.filter(idea => {
      const title = idea[1].trim().toLowerCase();
      return !queueTitles.some(qt => qt.includes(title) || title.includes(qt.split(':')[0].trim()));
    });
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
    if (item.status === 'blocked' && item.blocker_check) {
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

// --- Auto-promote brainstorming ideas to queue when pending < 3 (R#64, R#68) ---
// Queue starvation was the most frequent R session trigger. session-context.mjs
// auto-promotes fresh ideas (not already in queue) as pending items.
// R#68: Only run for B sessions (the consumer). Previously ran for ALL modes,
// which immediately depleted brainstorming after every R session — R adds ideas,
// next E/B session auto-promotes them all, brainstorming drops to 0, next R
// must replenish again. Now B sessions promote on-demand, and a minimum buffer
// of 3 ideas is preserved in brainstorming so R sessions aren't constantly
// refilling an empty pool. This breaks the deplete-replenish cycle.
if (MODE === 'B') {
  const currentPending = queue.filter(i => i.status === 'pending' && depsReady(i)).length;
  if (currentPending < 3) {
    const bsPath = join(DIR, 'BRAINSTORMING.md');
    if (existsSync(bsPath)) {
      const bs = readFileSync(bsPath, 'utf8');
      const ideas = [...bs.matchAll(/^- \*\*(.+?)\*\*:?\s*(.*)/gm)];
      const queueTitles = queue.map(i => i.title.toLowerCase());
      const fresh = ideas.filter(idea => {
        const title = idea[1].trim().toLowerCase();
        return !queueTitles.some(qt => qt.includes(title) || title.includes(qt.split(':')[0].trim()));
      });
      // R#68: Preserve a buffer of 3 ideas in brainstorming. Only promote excess.
      const BS_BUFFER = 3;
      const promotable = fresh.length > BS_BUFFER ? fresh.slice(0, fresh.length - BS_BUFFER) : [];
      const maxId = queue.reduce((m, i) => {
        const n = parseInt((i.id || '').replace('wq-', ''), 10);
        return isNaN(n) ? m : Math.max(m, n);
      }, 0);
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

// --- R session context (always computed — mode downgrades happen AFTER this script) ---
// Bug fix R#51: Previously gated by `if (MODE === 'R')`, so B→R downgrades
// (queue starvation gate) left R sessions without brainstorm/intel/intake data.
// Cost of always computing: ~3 file reads, negligible.
{
  // Brainstorming count
  const bsPath = join(DIR, 'BRAINSTORMING.md');
  if (existsSync(bsPath)) {
    const bs = readFileSync(bsPath, 'utf8');
    result.brainstorm_count = (bs.match(/^- \*\*/gm) || []).length;
  } else {
    result.brainstorm_count = 0;
  }

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

  // Directive intake check
  const dialoguePath = join(DIR, 'dialogue.md');
  if (wq && existsSync(dialoguePath)) {
    const d = readFileSync(dialoguePath, 'utf8');
    const lastIntake = wq.last_intake_session || 0;
    const matches = [...d.matchAll(/Human.*?\(s(\d+)/gi), ...d.matchAll(/Human directive \(s(\d+)/gi), ...d.matchAll(/Human \(s(\d+)/gi)];
    const maxDirective = matches.reduce((m, x) => Math.max(m, parseInt(x[1] || 0)), 0);
    result.intake_status = maxDirective > lastIntake ? `NEW:s${maxDirective}` : `no-op:s${lastIntake}`;
  } else {
    result.intake_status = 'unknown';
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

  const health = `Queue: ${rPending} pending, ${rBlocked} blocked | Brainstorming: ${rBrainstorm} ideas | Intel inbox: ${rIntel} entries`;

  let intakeBlock;
  if (rIntake.startsWith('no-op')) {
    intakeBlock = `### Directive intake: ${rIntake}\nNo new human directives since last intake. Skip directive intake — go straight to intel processing and evolve.`;
  } else {
    intakeBlock = `### Directive intake: ${rIntake}\nNEW directives detected. Read dialogue.md and decompose into work-queue items.`;
  }

  let urgent = '';
  if (rPending < 3) urgent += `\n- URGENT: Queue has <3 pending items (${rPending}). B sessions will starve. Promote brainstorming ideas or generate new queue items.`;
  if (rBrainstorm < 3) urgent += `\n- WARN: Brainstorming has <3 ideas (${rBrainstorm}). Add forward-looking ideas.`;
  if (rIntel > 0) urgent += `\n- ${rIntel} engagement intel entries awaiting consumption.`;
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

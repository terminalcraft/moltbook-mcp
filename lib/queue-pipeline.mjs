// lib/queue-pipeline.mjs — Queue context, dedup, stall detection, auto-promote,
// TODO ingest, friction ingest, and shared utilities.
// Extracted from session-context.mjs (R#260) to reduce main file complexity.
// Lines 112-541 of session-context.mjs moved here.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

// B#340: Stop words for keyword-based dedup. Used by both self-dedup and isTitleDupe.
export const STOP_WORDS = new Set(['a','an','the','for','to','of','in','on','and','or','add','fix','build','create','test','tests','new','with','from']);

// Shared fuzzy title matcher (R#79 — was duplicated in 3 places with slight variations).
// Checks if a candidate title is "close enough" to any existing queue title to be a duplicate.
// Uses normalized prefix comparison: lowercase first 20 chars of each, bidirectional includes.
// Centralizing prevents divergent matching logic (e.g. one copy split on ':', another didn't).
// B#340: Added keyword overlap check — catches semantically-equivalent titles with different
// wording (e.g. "Add tests for audit-report generation" vs "Test coverage for audit-report generation").
export function isTitleDupe(candidate, queueTitles) {
  const norm = candidate.toLowerCase().trim();
  const prefix = norm.substring(0, 25);
  return queueTitles.some(qt => {
    const qn = qt.toLowerCase().trim();
    const qp = qn.substring(0, 25);
    // Original prefix check
    if (qn.includes(prefix) || norm.includes(qp)) return true;
    // B#340: Keyword overlap check — extract significant words (>3 chars, not stop words),
    // flag as dupe if 60%+ of the smaller set overlaps with the larger set.
    const wordsA = new Set(norm.split(/\W+/).filter(w => w.length > 3 && !STOP_WORDS.has(w)));
    const wordsB = new Set(qn.split(/\W+/).filter(w => w.length > 3 && !STOP_WORDS.has(w)));
    if (wordsA.size === 0 || wordsB.size === 0) return false;
    const [smaller, larger] = wordsA.size <= wordsB.size ? [wordsA, wordsB] : [wordsB, wordsA];
    let overlap = 0;
    for (const w of smaller) if (larger.has(w)) overlap++;
    return overlap / smaller.size >= 0.6;
  });
}

/**
 * Run the full queue pipeline: load queue, dedup, detect stalls, select B task,
 * auto-unblock, auto-promote, TODO ingest, friction ingest.
 *
 * @param {Object} opts
 * @param {string} opts.MODE - Session mode (B/R/E/A)
 * @param {number} opts.COUNTER - Session counter
 * @param {Object} opts.fc - FileCache instance
 * @param {Object} opts.PATHS - Centralized file paths
 * @param {string} opts.DIR - MCP project directory
 * @param {Object} opts.result - Mutable result object for session context output
 * @param {Function} opts.readJSON - JSON file reader (uses fc.json)
 * @param {Function} opts.markTiming - Timing marker function
 * @returns {{ wq, queue, queueCtx, dirtyRef: {value: boolean}, pending, blocked, retired }}
 */
export function runQueuePipeline({ MODE, COUNTER, fc, PATHS, DIR, result, readJSON, markTiming }) {
  // Dirty flag as object property so queueCtx.createItem() can mutate it
  // and callers can check/set it after the pipeline returns.
  const dirtyRef = { value: false };

  // --- Work queue context ---
  const wq = readJSON(join(DIR, 'work-queue.json'));
  const queue = wq?.queue || [];

  // Check if all deps are satisfied. Missing deps = archived = done (per work-queue.json spec).
  const depsReady = (item) => !item.deps?.length || item.deps.every(d => {
    const dep = queue.find(i => i.id === d);
    return !dep || dep.status === 'done';
  });

  // --- Queue self-dedup (R#67, B#340) ---
  {
    const seen = [];
    const dupes = [];
    for (let idx = 0; idx < queue.length; idx++) {
      if (queue[idx].status !== 'pending') { seen.push(null); continue; }
      const norm = queue[idx].title.toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const first6 = norm.split(' ').slice(0, 6).join(' ');
      const keywords = new Set(norm.split(/\W+/).filter(w => w.length > 3 && !STOP_WORDS.has(w)));
      let isDupe = false;
      for (const prev of seen) {
        if (!prev) continue;
        if (first6 === prev.first6) { isDupe = true; break; }
        if (keywords.size > 0 && prev.keywords.size > 0) {
          const [smaller, larger] = keywords.size <= prev.keywords.size ? [keywords, prev.keywords] : [prev.keywords, keywords];
          let overlap = 0;
          for (const w of smaller) if (larger.has(w)) overlap++;
          if (overlap / smaller.size >= 0.6) { isDupe = true; break; }
        }
      }
      if (isDupe) {
        dupes.push(idx);
      }
      seen.push({ first6, keywords, idx });
    }
    if (dupes.length > 0) {
      for (let i = dupes.length - 1; i >= 0; i--) {
        const removed = queue.splice(dupes[i], 1)[0];
        result.deduped = result.deduped || [];
        result.deduped.push(removed.id + ': ' + removed.title);
      }
      dirtyRef.value = true;
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
  {
    let bStallCount = 0;
    {
      const hist = fc.text(PATHS.history);
      const bSessions = [...hist.matchAll(/mode=B .* build=(\S+)/g)];
      for (let i = bSessions.length - 1; i >= 0; i--) {
        if (bSessions[i][1] === '(none)') {
          bStallCount++;
        } else {
          break;
        }
      }
    }
    result.b_stall_count = bStallCount;
  }

  // R#218: Shared QueueContext
  const queueCtx = {
    _maxId: null,
    _titles: null,
    _pendingCount: null,
    get maxId() {
      if (this._maxId !== null) return this._maxId;
      let max = queue.reduce((m, i) => {
        const n = parseInt((i.id || '').replace('wq-', ''), 10);
        return isNaN(n) ? m : Math.max(m, n);
      }, 0);
      try {
        const archivePath = PATHS.queueArchive;
        if (existsSync(archivePath)) {
          const archive = fc.json(archivePath);
          const archived = archive.archived || archive;
          if (Array.isArray(archived)) {
            for (const item of archived) {
              const n = parseInt((item.id || '').replace('wq-', ''), 10);
              if (!isNaN(n) && n > max) max = n;
            }
          }
        }
      } catch { /* archive missing or malformed */ }
      this._maxId = max;
      return max;
    },
    get titles() {
      if (this._titles !== null) return this._titles;
      this._titles = queue.map(i => i.title);
      return this._titles;
    },
    get pendingCount() {
      if (this._pendingCount !== null) return this._pendingCount;
      this._pendingCount = queue.filter(i => i.status === 'pending' && depsReady(i)).length;
      return this._pendingCount;
    },
    invalidate() {
      this._maxId = null;
      this._titles = null;
      this._pendingCount = null;
    },
    allocateIds(count) {
      const base = this.maxId;
      this._maxId = base + count;
      return base;
    },
    createItem({ title, description, source, tags = [], complexity }) {
      const nextId = this.maxId + 1;
      this._maxId = nextId;
      const id = `wq-${String(nextId).padStart(3, '0')}`;
      const item = {
        id,
        title,
        description: description || 'Auto-generated',
        priority: nextId,
        status: 'pending',
        added: new Date().toISOString().split('T')[0],
        source,
        tags,
        commits: []
      };
      if (complexity) item.complexity = complexity;
      queue.push(item);
      dirtyRef.value = true;
      this._titles = null;
      this._pendingCount = null;
      return id;
    }
  };

  // B session task selection
  const BUDGET_CAP = parseFloat(process.env.BUDGET_CAP || '10');
  if (MODE === 'B' && pending.length > 0) {
    const auditFirst = [...pending].sort((a, b) => {
      const aAudit = (a.tags || []).includes('audit') ? 0 : 1;
      const bAudit = (b.tags || []).includes('audit') ? 0 : 1;
      return aAudit - bAudit;
    });
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
    {
      const bs = fc.text(PATHS.brainstorming);
      const ideas = [...bs.matchAll(/^- \*\*(.+?)\*\*:?\s*(.*)/gm)];
      const fresh = ideas.filter(idea => !isTitleDupe(idea[1].trim(), queueCtx.titles));
      if (fresh.length > 0) {
        const idea = fresh[0];
        result.wq_item = `BRAINSTORM-FALLBACK: ${idea[1].trim()} — ${idea[2].trim()}`;
        result.wq_fallback = true;
      }
    }
  }

  // Auto-unblock: check blocked items with blocker_check commands
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
      dirtyRef.value = true;
      queueCtx.invalidate();
      result.unblocked = unblocked;
      result.pending_count = queueCtx.pendingCount;
    }
  }
  markTiming('blocker_check');

  // --- Auto-promote brainstorming ideas to queue when pending < 3 ---
  if (MODE === 'B' || MODE === 'R') {
    const currentPending = queueCtx.pendingCount;
    if (currentPending < 3) {
      {
        const bs = fc.text(PATHS.brainstorming);
        const ideas = [...bs.matchAll(/^- \*\*(.+?)\*\*:?\s*(.*)/gm)];
        const fresh = ideas.filter(idea => !isTitleDupe(idea[1].trim(), queueCtx.titles));
        const deficit = 3 - currentPending;
        const BS_BUFFER = Math.max(1, 3 - deficit);
        const promotable = fresh.length > BS_BUFFER ? fresh.slice(0, fresh.length - BS_BUFFER) : [];
        const promoted = [];
        for (let i = 0; i < promotable.length && currentPending + promoted.length < 3; i++) {
          const title = promotable[i][1].trim();
          const desc = promotable[i][2].trim();
          const newId = queueCtx.createItem({
            title,
            description: desc || 'Auto-promoted from brainstorming',
            source: 'brainstorming-auto'
          });
          promoted.push(newId + ': ' + title);
        }
        if (promoted.length > 0) {
          result.auto_promoted = promoted;
          result.pending_count = queueCtx.pendingCount;

          // R#66: Remove promoted ideas from BRAINSTORMING.md
          let updated = bs;
          for (let i = 0; i < promotable.length && i < promoted.length; i++) {
            const line = promotable[i][0];
            updated = updated.replace(line + '\n', '');
          }
          if (updated !== bs) {
            writeFileSync(PATHS.brainstorming, updated);
            fc.invalidate(PATHS.brainstorming);
          }
        }
      }
    }
  }
  markTiming('auto_promote');

  // --- Auto-ingest TODO followups into queue ---
  if (MODE === 'B') {
    const todoPath = PATHS.todoFollowups;
    if (existsSync(todoPath)) {
      const todoContent = fc.text(todoPath);
      const todoLines = [...todoContent.matchAll(/^- (.+)/gm)];
      if (todoLines.length > 0) {
        const FALSE_POSITIVE_PATTERNS = [
          /\$\{|`|=>|require\(|\.substring|\.slice|\.match|\.replace|\.push/,
          /["']title["']|["']description["']/,
          /^\|.*\|$/,
          /^\*[RBEA]#\d+/,
          /^["{}]/,
          /^#\s+(Pattern|TODO|FIXME)/i,
          /wq-[Xx]{3}/,
          /TODO\s+followup:/i,
          /\{\s*pattern:|\/.*\/[gimsuy]*,/,
        ];
        const isFalsePositive = (line) => FALSE_POSITIVE_PATTERNS.some(p => p.test(line));

        const todoTitlesLower = queueCtx.titles.map(t => t.toLowerCase());
        const ingested = [];
        for (let i = 0; i < todoLines.length && i < 3; i++) {
          const raw = todoLines[i][1].trim();
          if (isFalsePositive(raw)) continue;
          if (!/\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b/i.test(raw)) continue;
          const norm = raw.toLowerCase().substring(0, 30);
          if (todoTitlesLower.some(qt => qt.includes(norm) || norm.includes(qt.substring(0, 20)))) continue;
          const newId = queueCtx.createItem({
            title: `TODO followup: ${raw.substring(0, 80)}`,
            description: raw,
            source: 'todo-scan',
            complexity: 'S',
            tags: ['followup']
          });
          ingested.push(newId);
        }
        if (ingested.length > 0) {
          result.todo_ingested = ingested;
          result.pending_count = queueCtx.pendingCount;
        }
      }
    }
  }

  // --- Auto-ingest friction signals into queue ---
  if (MODE === 'R' && process.env.SESSION_NUM) {
    try {
      const patternsJson = execSync('curl -s http://localhost:3847/status/patterns', { timeout: 5000, encoding: 'utf8' });
      const patterns = JSON.parse(patternsJson);
      const signals = patterns?.friction_signals || [];
      if (signals.length > 0) {
        const ingested = [];
        for (let i = 0; i < signals.length && i < 2; i++) {
          const sig = signals[i];
          const title = sig.suggestion || `Address ${sig.type} friction`;
          if (isTitleDupe(title, queueCtx.titles)) continue;
          const newId = queueCtx.createItem({
            title,
            description: `${sig.reason || sig.type} — auto-generated from /status/patterns friction_signals`,
            source: 'friction-signal',
            tags: ['friction']
          });
          ingested.push(newId + ': ' + title);
        }
        if (ingested.length > 0) {
          result.friction_ingested = ingested;
          result.pending_count = queueCtx.pendingCount;
        }
      }
    } catch (e) {
      result.friction_check_error = e.message?.substring(0, 100);
    }
  }

  return { wq, queue, queueCtx, dirtyRef, pending, blocked, retired };
}

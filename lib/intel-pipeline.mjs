// lib/intel-pipeline.mjs — Intel digest, auto-promotion, and archiving.
// Extracted from session-context.mjs (R#295) to reduce main file complexity.
// Handles: categorizing intel entries, auto-promoting to work-queue,
// archiving intel and trace data.

import { writeFileSync } from 'fs';
import { isTitleDupe } from './queue-pipeline.mjs';

// Imperative verb filter for auto-promotion (B#263, R#182).
const IMPERATIVE_VERBS = /^(Add|Build|Create|Fix|Implement|Update|Remove|Refactor|Extract|Migrate|Integrate|Configure|Enable|Disable|Optimize|Evaluate|Test|Validate|Deploy|Setup|Write|Design)\b/i;
// R#178: Observational language filter.
const OBSERVATIONAL_PATTERNS = /(enables|maps to|mirrors|serves as|reflects|demonstrates|indicates|suggests that|is a form of|attach to|gradient|spectrum|binary|philosophy|metaphor|\bARE\b(?!n't| not| also| both| either))/i;
// R#182: Meta-instruction filter.
const META_INSTRUCTION_PATTERNS = /(Add to work-queue|potential [BERA] session|as (a )?queue (item|candidate)|should (be )?(added|promoted|tracked))/i;

/**
 * Categorize intel entries into queue/brainstorm/note buckets.
 * Returns { actions, digest } where digest is the formatted string.
 */
function categorizeIntel(intel) {
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
  return { actions, digest: lines.join('\n') };
}

/**
 * R#251: Smart truncation — word boundary instead of hard-cutting mid-word.
 */
function smartTruncate(raw) {
  if (raw.length <= 80) {
    return raw.replace(/\.+$/, '');
  }
  // Try sentence boundary first (period or em dash followed by space)
  const sentenceEnd = raw.search(/[.]\s|—\s/);
  if (sentenceEnd > 20 && sentenceEnd <= 80) {
    return raw.substring(0, sentenceEnd).trim();
  }
  // Word boundary truncation
  const cut = raw.substring(0, 80);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 30 ? cut.substring(0, lastSpace) : cut;
}

/**
 * Auto-promote qualifying intel entries to work-queue (R#140, d038).
 * Only promotes if queue has capacity (<5 pending).
 */
function autoPromoteIntel(intel, actions, result, queueCtx) {
  if (actions.queue.length === 0 || result.pending_count >= 5) return;

  const promoted = [];
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
    const raw = (entry.actionable || '').trim();
    const title = smartTruncate(raw);
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

/**
 * Archive intel entries and backfill session=0 tags (R#58, R#214).
 */
function archiveIntel(intel, fc, PATHS, COUNTER, result) {
  const archivePath = PATHS.intelArchive;
  let archive = [...(fc.json(archivePath) || [])];

  // R#214: Backfill session=0 entries with last known E session number.
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

/**
 * Archive engagement-trace.json entries (B#324, wq-364).
 */
function archiveTraces(fc, PATHS, COUNTER, result) {
  try {
    const traceData = fc.json(PATHS.trace);
    if (Array.isArray(traceData) && traceData.length > 0) {
      let traceArchive = [...(fc.json(PATHS.traceArchive) || [])];
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

/**
 * Run the full intel pipeline: categorize, digest, promote, archive.
 * Main entry point called from session-context.mjs.
 */
export function runIntelPipeline({ intel, fc, PATHS, COUNTER, result, queueCtx }) {
  result.intel_count = Array.isArray(intel) ? intel.length : 0;

  if (!Array.isArray(intel) || intel.length === 0) return;

  const { actions, digest } = categorizeIntel(intel);
  result.intel_digest = digest;

  autoPromoteIntel(intel, actions, result, queueCtx);
  archiveIntel(intel, fc, PATHS, COUNTER, result);
  archiveTraces(fc, PATHS, COUNTER, result);
}

// Export internals for testing
export { categorizeIntel, smartTruncate, autoPromoteIntel, archiveIntel, archiveTraces };
export { IMPERATIVE_VERBS, OBSERVATIONAL_PATTERNS, META_INSTRUCTION_PATTERNS };

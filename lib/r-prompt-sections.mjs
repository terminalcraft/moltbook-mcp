// lib/r-prompt-sections.mjs — R session prompt block assembly.
// Extracted from session-context.mjs (wq-531) to make R-specific logic
// independently testable and reduce main file complexity.
// Three safeSection blocks: impact history, intel promotion, intel capture diagnostic.

/**
 * Build the complete R session prompt block.
 * @param {Object} ctx
 * @param {Function} ctx.safeSection - Error-isolating wrapper: (label, fn) => string
 * @param {Object} ctx.fc - FileCache instance with .text() and .json() methods
 * @param {Object} ctx.PATHS - Centralized file paths (rCounter, humanReview, rImpact, intel, intelArchive, trace, traceArchive)
 * @param {string} ctx.MODE - Session mode character (should be 'R')
 * @param {number} ctx.COUNTER - Session counter
 * @param {Object} ctx.result - Shared result object (reads pending_count, blocked_count, retired_count, brainstorm_count, intel_count, intel_digest, intake_status, pending_directives)
 * @param {Array} ctx.queue - Work queue array
 * @returns {string} The assembled r_prompt_block string
 */
export function buildRPromptBlock(ctx) {
  const { safeSection, fc, PATHS, MODE, COUNTER, result, queue } = ctx;

  let rCount = '?';
  try {
    const raw = parseInt(fc.text(PATHS.rCounter).trim());
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
    const reviewData = fc.json(PATHS.humanReview);
    rReviewCount = (reviewData.items || []).filter(i => i.status === 'open').length;
  } catch {}

  const health = `Queue: ${rPending} pending, ${rBlocked} blocked${rRetired ? `, ${rRetired} retired` : ''} | Brainstorming: ${rBrainstorm} ideas | Intel inbox: ${rIntel} entries${rReviewCount ? ` | Human review: ${rReviewCount} open` : ''}`;

  let intakeBlock;
  if (rIntake.startsWith('no-op')) {
    intakeBlock = `### Directive intake: ${rIntake}\nNo new human directives since last intake. Skip directive intake — go straight to intel processing and evolve.`;
  } else if (result.pending_directives) {
    intakeBlock = `### Directive intake: ${rIntake}\nNEW directives detected. Run \`node directives.mjs ack <id> <session>\` after reading each one.\n\n## PENDING DIRECTIVES (from directives.json)\n${result.pending_directives}`;
  } else {
    intakeBlock = `### Directive intake: ${rIntake}\nNEW directives detected. Run \`node directives.mjs pending\` and decompose into work-queue items.`;
  }

  let urgent = '';
  if (rPending < 5) urgent += `\n- URGENT: Queue has <5 pending items (${rPending}). B sessions will starve. Promote brainstorming ideas or generate new queue items.`;
  if (rBrainstorm < 3) urgent += `\n- WARN: Brainstorming has <3 ideas (${rBrainstorm}). Add forward-looking ideas.`;
  if (rIntel > 0) urgent += `\n- ${rIntel} engagement intel entries awaiting consumption.`;
  if (rReviewCount > 0) urgent += `\n- ${rReviewCount} item(s) in human review queue. Use \`human_review_list\` to view. Do NOT act on these — they await human decision.`;
  if (rIntelDigest) {
    urgent += `\n\n### Intel digest (pre-categorized, auto-archived):\n${rIntelDigest}\nProcess these: promote queue candidates to work-queue.json, add brainstorm candidates to BRAINSTORMING.md. Archiving is handled automatically — no manual archive step needed.`;
  }

  const impactSummary = buildImpactSummary(safeSection, fc, PATHS, COUNTER);
  const intelPromoSummary = buildIntelPromoSummary(safeSection, fc, PATHS, result, queue);
  const intelCaptureWarning = buildIntelCaptureWarning(safeSection, fc, PATHS);

  return `## R Session: #${rCount}
This is R session #${rCount}. Follow the checklist in SESSION_REFLECT.md.

### Pipeline health snapshot:
${health}${impactSummary}${intelPromoSummary}${intelCaptureWarning}

${intakeBlock}${urgent}`;
}

/**
 * Impact history section (wq-158).
 * Reads r-session-impact.json and computes category recommendations.
 */
function buildImpactSummary(safeSection, fc, PATHS, COUNTER) {
  return safeSection('Impact history', () => {
    const impactData = fc.json(PATHS.rImpact);
    if (!impactData) return '';
    const analysis = impactData.analysis || [];
    const pending = (impactData.changes || []).filter(c => !c.analyzed);
    if (analysis.length === 0 && pending.length === 0) return '';
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
    let summary = `\n\n### Impact history (wq-158):\n${analysis.length} analyzed changes. Recommendations: ${recsText}${pendingText}`;
    if (pending.length > 0 && COUNTER > 0) {
      const nextAnalysis = pending.filter(p => {
        const sessionsUntil = 10 - (COUNTER - (p.session || 0));
        return sessionsUntil > 0 && sessionsUntil <= 3;
      });
      if (nextAnalysis.length > 0) {
        summary += `\nSoon: ${nextAnalysis.map(p => `s${p.session} ${p.file} (${10 - (COUNTER - (p.session || 0))} sessions left)`).join(', ')}`;
      }
    }
    return summary;
  });
}

/**
 * Intel promotion summary (wq-191, wq-216).
 * Shows recently-promoted intel items and their outcomes.
 */
function buildIntelPromoSummary(safeSection, fc, PATHS, result, queue) {
  return safeSection('Intel promotion', () => {
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
      let summary = `\n\n### Intel→Queue pipeline (wq-191):\n${intelItems.length} items auto-promoted from engagement intel. Status: ${parts.join(', ')}. Conversion rate: ${convRate}%.`;
      if (byStatus.pending.length > 0) {
        const recent = byStatus.pending.slice(0, 3).map(i => `  - ${i.id}: ${i.title.substring(0, 50)}`).join('\n');
        summary += `\nPending intel items:\n${recent}`;
      }
      return summary;
    }
    // wq-216: No intel-auto items — explain why (capacity gate vs no actionable intel)
    let hasActionableIntel = false;
    const cachedIntel = fc.json(PATHS.intel);
    if (Array.isArray(cachedIntel)) {
      hasActionableIntel = cachedIntel.some(e =>
        (e.type === 'integration_target' || e.type === 'pattern') &&
        (e.actionable || '').length > 20
      );
    }
    const capacityGated = result.pending_count >= 5;
    if (capacityGated && hasActionableIntel) {
      return `\n\n### Intel→Queue pipeline (wq-191):\n0 items promoted — CAPACITY GATED (${result.pending_count} pending >= 5). Actionable intel exists but promotion blocked until queue capacity frees.`;
    }
    if (!hasActionableIntel) {
      const cachedArchive = fc.json(PATHS.intelArchive) || [];
      const archivedPromoCount = cachedArchive.filter(e => e._promoted).length;
      if (archivedPromoCount > 0) {
        return `\n\n### Intel→Queue pipeline (wq-191):\n0 items currently promoted. ${archivedPromoCount} historical promotions (now archived/processed).`;
      }
    }
    return '';
  });
}

/**
 * Intel capture diagnostic (R#173).
 * Cross-references trace archive with intel archive to compute capture rate.
 */
function buildIntelCaptureWarning(safeSection, fc, PATHS) {
  return safeSection('Intel capture diagnostic', () => {
    let allTraces = fc.json(PATHS.traceArchive) || [];
    allTraces = [...allTraces];
    const current = fc.json(PATHS.trace);
    if (Array.isArray(current)) {
      const archivedSessions = new Set(allTraces.map(t => t.session));
      allTraces.push(...current.filter(t => !archivedSessions.has(t.session)));
    }
    const archive = fc.json(PATHS.intelArchive) || [];
    if (!Array.isArray(allTraces) || allTraces.length === 0) return '';
    const recentESessions = allTraces.slice(-10).map(t => t.session);
    const sessionsWithIntel = new Set(
      (archive || []).map(e => e.session || e.archived_session).filter(s => recentESessions.includes(s))
    );
    const captureRate = recentESessions.length > 0
      ? Math.round((sessionsWithIntel.size / recentESessions.length) * 100)
      : 0;
    if (captureRate < 50 && recentESessions.length >= 5) {
      return `\n\n### Intel Capture Alert (R#173):\nOnly ${sessionsWithIntel.size}/${recentESessions.length} recent E sessions (${captureRate}%) generated intel entries. E sessions are engaging but not capturing actionable insights. Review SESSION_ENGAGE.md Phase 3b compliance.`;
    }
    return '';
  });
}

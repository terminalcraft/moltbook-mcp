// lib/brainstorm-pipeline.mjs — Brainstorming auto-seed and count management.
// Extracted from session-context.mjs (R#315) to reduce main file complexity.
// Handles: counting active ideas, auto-seeding when below threshold,
// directive-based seeds, session-pattern seeds, queue-health seeds.

import { writeFileSync } from 'fs';
import { isTitleDupe } from './queue-pipeline.mjs';

// Directive keyword→seed mapping table (R#78, B#454).
// Each entry maps keyword patterns to a concrete seed title+description template.
// minMatch prevents false keyword matches on common single words.
const DIRECTIVE_SEED_TABLE = [
  { keywords: ['ecosystem', 'map', 'discover', 'catalog'], title: 'Batch-evaluate 5 undiscovered services', desc: 'systematically probe unevaluated services from services.json' },
  { keywords: ['explore', 'evaluate', 'e session', 'depth'], title: 'Deep-explore one new platform end-to-end', desc: 'pick an unevaluated service, register, post, measure response' },
  { keywords: ['account', 'credential', 'cred', 'path resolution'], title: 'Fix credential management issues', desc: 'audit account-manager path resolution and platform health checks' },
  { keywords: ['budget', 'cost', 'utilization', 'spending'], minMatch: 2, title: 'Improve session budget utilization', desc: 'add retry loops or deeper exploration to underutilized sessions' },
  { skip: true, keywords: ['safety', 'hook', 'do not remove', 'do not weaken'] },
];

/**
 * Run the brainstorming pipeline: count ideas, auto-seed when low.
 * @param {Object} opts - Context object from session-context.mjs
 * @param {Object} opts.fc - FileCache instance
 * @param {Object} opts.PATHS - Centralized file paths
 * @param {number} opts.COUNTER - Current session number
 * @param {Object} opts.result - Shared result accumulator
 * @param {Array} opts.queue - Current work queue items
 * @returns {{ brainstormCount: number, seeded: number }}
 */
export function runBrainstormPipeline({ fc, PATHS, COUNTER, result, queue }) {
  let bsContent = fc.text(PATHS.brainstorming);
  let bsCount = (bsContent.match(/^- \*\*/gm) || []).length;
  let seeded = 0;

  if (bsCount < 3) {
    // Auto-seed (R#82): Trigger when brainstorming < 3 ideas.
    // Seeds up to 4 ideas when below the health threshold of 3.
    const seeds = [];
    const maxSeeds = 4 - bsCount;
    const queueTitles = queue.map(i => i.title);
    // R#84: Also dedup against existing brainstorming ideas.
    const existingIdeas = [...bsContent.matchAll(/^- \*\*(.+?)\*\*/gm)].map(m => m[1].trim());
    const allTitles = [...queueTitles, ...existingIdeas];
    const isDupe = (title) => isTitleDupe(title, allTitles);

    // Source 1: Unaddressed directives — table-driven keyword→seed mapping (R#78).
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
          // R#86: Always include directive ID in title to prevent cross-directive collisions.
          const baseTitle = match ? match.title : `Address directive ${d.id}`;
          const title = match ? `${baseTitle} (${d.id})` : baseTitle;
          const desc = match ? match.desc : (d.content || '').substring(0, 120);
          if (!isDupe(title)) {
            seeds.push(`- **${title}**: ${desc}`);
          }
        }
      }
    }

    // Source 2: Recent session patterns — find concrete improvement opportunities.
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
    const pending = queue.filter(i => i.status === 'pending');
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
      fc.invalidate(PATHS.brainstorming);
      seeded = seeds.length;
      result.brainstorm_seeded = seeded;
    }
  }

  // R#87: Always recount from file content after all mutations.
  const finalBs = fc.text(PATHS.brainstorming);
  const brainstormCount = (finalBs.match(/^- \*\*/gm) || []).length;
  result.brainstorm_count = brainstormCount;

  return { brainstormCount, seeded };
}

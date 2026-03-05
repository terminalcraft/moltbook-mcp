#!/usr/bin/env node
// e-session-seed.mjs — Generate E session context from engagement intel + recent history
//
// Extracted from 35-e-session-prehook_E.sh Check 2 (R#323).
// Replaces 80 lines of inline bash (jq/awk/grep text generation) with a
// standalone, testable Node module.
//
// Usage (CLI):
//   node e-session-seed.mjs [--output /path/to/context.md]
//   Reads from env: SESSION_NUM, STATE_DIR (default ~/.config/moltbook)
//
// Usage (import):
//   import { generateSeed } from './e-session-seed.mjs';
//   const { lines, sections } = generateSeed({ historyFile, intelFile, nudgeFile });

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

export function generateSeed({ historyFile, intelFile, nudgeFile, deps = {} } = {}) {
  const fs = {
    readFileSync: deps.readFileSync || readFileSync,
    existsSync: deps.existsSync || existsSync,
  };
  const output = [];
  const sections = [];

  // 1. Recent E session summaries
  if (fs.existsSync(historyFile)) {
    const lines = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
    const eSessions = lines.filter(l => l.includes('mode=E')).slice(-3);
    if (eSessions.length > 0) {
      output.push('## Last E sessions');
      for (const line of eSessions) {
        output.push(`- ${line}`);
      }
      output.push('');
      sections.push('last_e_sessions');
    }
  }

  // 2. Engagement intel entries
  if (fs.existsSync(intelFile)) {
    try {
      const intel = JSON.parse(fs.readFileSync(intelFile, 'utf8'));
      if (Array.isArray(intel) && intel.length > 0) {
        const recent = intel.slice(-8);
        output.push('## Engagement intel (from recent sessions)');
        for (const entry of recent) {
          const type = entry.type || '?';
          const session = entry.session || '?';
          const summary = entry.summary || '';
          let line = `- **[${type}]** (s${session}) ${summary}`;
          if (entry.actionable) {
            line += `\n  - Action: ${entry.actionable}`;
          }
          output.push(line);
        }
        output.push('');
        sections.push('intel');
      }
    } catch {
      // Malformed intel file — skip silently
    }
  }

  // 3. Platform rotation hint
  if (fs.existsSync(historyFile)) {
    const lines = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
    const lastE = lines.filter(l => l.includes('mode=E')).slice(-1)[0];
    if (lastE) {
      const noteMatch = lastE.match(/note: (.+)/);
      if (noteMatch) {
        output.push('## Platform rotation hint');
        output.push(`Last E session covered: ${noteMatch[1]}`);
        output.push('Prioritize platforms NOT mentioned above.');
        output.push('');
        sections.push('rotation_hint');
      }
    }
  }

  // 4. Budget utilization warning
  if (fs.existsSync(historyFile)) {
    const lines = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
    const eSessions = lines.filter(l => l.includes('mode=E')).slice(-5);
    const costs = [];
    for (const line of eSessions) {
      const m = line.match(/cost=\$(\d+\.?\d*)/);
      if (m) costs.push(parseFloat(m[1]));
    }
    if (costs.length > 0) {
      const avg = costs.reduce((a, b) => a + b, 0) / costs.length;
      output.push('## Budget utilization alert');
      if (avg < 1.50) {
        output.push(`WARNING: Last ${costs.length} E sessions averaged $${avg.toFixed(2)} (target: $1.50+).`);
        output.push('You MUST use the Phase 4 budget gate. Do NOT end the session until you have spent at least $1.50.');
        output.push('After each platform engagement, check your budget spent from the system-reminder line.');
        output.push('If under $1.50, loop back to Phase 2 with another platform.');
      } else {
        output.push(`Recent E sessions averaging $${avg.toFixed(2)} — on target.`);
      }
      output.push('');
      sections.push('budget');
    }
  }

  // 5. d049 violation nudge
  if (fs.existsSync(nudgeFile)) {
    try {
      const nudge = fs.readFileSync(nudgeFile, 'utf8').trim();
      if (nudge) {
        output.push(nudge);
        output.push('');
        sections.push('d049_nudge');
      }
    } catch {
      // Missing nudge file — skip
    }
  }

  return { text: output.join('\n'), lines: output.length, sections };
}

// CLI entry point
if (process.argv[1]?.endsWith('e-session-seed.mjs')) {
  const stateDir = process.env.STATE_DIR || join(process.env.HOME, '.config/moltbook');
  const historyFile = join(stateDir, 'session-history.txt');
  const intelFile = join(stateDir, 'engagement-intel.json');
  const nudgeFile = join(stateDir, 'd049-nudge.txt');

  const outputArg = process.argv.indexOf('--output');
  const outputFile = outputArg >= 0 ? process.argv[outputArg + 1] : join(stateDir, 'e-session-context.md');

  const { text, lines, sections } = generateSeed({ historyFile, intelFile, nudgeFile });

  if (lines > 0) {
    writeFileSync(outputFile, text);
    console.log(`wrote ${lines} lines to ${outputFile.split('/').pop()} (sections: ${sections.join(', ')})`);
  } else {
    try { unlinkSync(outputFile); } catch { /* ok */ }
    console.log('no engagement context to seed');
  }
}

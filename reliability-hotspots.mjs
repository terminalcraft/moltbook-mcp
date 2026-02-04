#!/usr/bin/env node
/**
 * reliability-hotspots.mjs — Identify components with repeated fixes (wq-196)
 *
 * Scans git history for fix commits and identifies reliability hotspots:
 * components that needed fixes more than 3 times in the last N commits.
 *
 * Usage:
 *   node reliability-hotspots.mjs [commits=200]
 *
 * Output: Components ranked by fix count, with hotspots (>3 fixes) highlighted.
 */

import { execSync } from 'child_process';

const HOTSPOT_THRESHOLD = 3;
const commits = parseInt(process.argv[2]) || 200;

// Get fix commits from git log
const log = execSync(`git log --oneline -${commits}`, { encoding: 'utf8' });
const lines = log.split('\n').filter(l => l.includes('fix'));

// Parse fix scopes
// Patterns: "fix(scope): ...", "fix: scope ...", "fix: ... (scope)"
const scopes = {};

for (const line of lines) {
  const hash = line.slice(0, 7);
  const msg = line.slice(8);

  // Pattern 1: fix(scope): ...
  const scopeMatch = msg.match(/^fix\(([^)]+)\):/);
  if (scopeMatch) {
    const parts = scopeMatch[1].split(',').map(s => s.trim());
    for (const scope of parts) {
      if (!scopes[scope]) scopes[scope] = [];
      scopes[scope].push({ hash, msg });
    }
    continue;
  }

  // Pattern 2: fix: ... (wq-XXX) — extract wq item as scope
  const wqMatch = msg.match(/\(wq-\d+\)/);
  if (wqMatch) {
    const scope = wqMatch[0].slice(1, -1); // remove parens
    if (!scopes[scope]) scopes[scope] = [];
    scopes[scope].push({ hash, msg });
    continue;
  }

  // Pattern 3: fix: component.file ... — extract first word after "fix: "
  const compMatch = msg.match(/^fix: (\S+)/);
  if (compMatch) {
    const scope = compMatch[1].replace(/[.:,]$/, ''); // strip trailing punctuation
    if (!scopes[scope]) scopes[scope] = [];
    scopes[scope].push({ hash, msg });
    continue;
  }

  // Unscoped fix
  if (!scopes['(unscoped)']) scopes['(unscoped)'] = [];
  scopes['(unscoped)'].push({ hash, msg });
}

// Sort by fix count descending
const sorted = Object.entries(scopes)
  .sort((a, b) => b[1].length - a[1].length);

// Output
console.log(`=== Reliability Hotspots (last ${commits} commits) ===`);
console.log(`Hotspot threshold: >${HOTSPOT_THRESHOLD} fixes\n`);

const hotspots = sorted.filter(([_, fixes]) => fixes.length > HOTSPOT_THRESHOLD);
const others = sorted.filter(([_, fixes]) => fixes.length <= HOTSPOT_THRESHOLD);

if (hotspots.length > 0) {
  console.log('🔥 HOTSPOTS (need attention):');
  for (const [scope, fixes] of hotspots) {
    console.log(`  ${scope}: ${fixes.length} fixes`);
    for (const f of fixes.slice(0, 3)) {
      console.log(`    - ${f.hash} ${f.msg.slice(0, 60)}`);
    }
    if (fixes.length > 3) {
      console.log(`    ... and ${fixes.length - 3} more`);
    }
  }
  console.log();
}

console.log('Other components:');
for (const [scope, fixes] of others.slice(0, 15)) {
  console.log(`  ${scope}: ${fixes.length} fix${fixes.length > 1 ? 'es' : ''}`);
}

if (others.length > 15) {
  console.log(`  ... and ${others.length - 15} more with ≤${HOTSPOT_THRESHOLD} fixes`);
}

console.log(`\nTotal: ${lines.length} fix commits across ${sorted.length} scopes`);

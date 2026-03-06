#!/usr/bin/env node
// todo-scan.mjs — TODO tracker management for 27-todo-scan.sh
// Extracted from inline node -e blocks (d075, R#337).
//
// Usage:
//   node hooks/lib/todo-scan.mjs merge   — Phase 2: merge new TODOs into tracker
//   node hooks/lib/todo-scan.mjs resolve — Phase 3: auto-resolve + check resolution
//
// Env: TRACKER, FALSE_POSITIVES, SESSION_NUM, NEW_TODOS (merge only)

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const mode = process.argv[2];
const tracker_path = process.env.TRACKER;
const fp_path = process.env.FALSE_POSITIVES;
const session = parseInt(process.env.SESSION_NUM) || 0;

function loadTracker() {
  return JSON.parse(readFileSync(tracker_path, 'utf8'));
}

function loadFPPatterns() {
  try {
    const fp = JSON.parse(readFileSync(fp_path, 'utf8'));
    return (fp.patterns || []).map(p => new RegExp(p, 'i'));
  } catch { return []; }
}

function merge() {
  const tracker = loadTracker();
  const fpPatterns = loadFPPatterns();
  const raw = process.env.NEW_TODOS || '';
  const newLines = raw.split('\n').filter(l => l.length > 0);

  for (const line of newLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const normalized = trimmed.replace(/\s+/g, ' ').substring(0, 200);

    if (fpPatterns.some(re => re.test(normalized))) continue;

    const exists = tracker.items.find(i => i.normalized === normalized && i.status === 'open');
    if (!exists) {
      tracker.items.push({
        text: trimmed.substring(0, 300),
        normalized,
        first_seen: session,
        last_seen: session,
        status: 'open'
      });
    } else {
      exists.last_seen = session;
    }
  }
  writeFileSync(tracker_path, JSON.stringify(tracker, null, 2) + '\n');
}

function resolve() {
  const tracker = loadTracker();
  const fpPatterns = loadFPPatterns();
  let changed = false;
  let autoResolved = 0;

  for (const item of tracker.items) {
    if (item.status !== 'open') continue;

    if (fpPatterns.some(re => re.test(item.normalized))) {
      item.status = 'resolved';
      item.resolved_session = session;
      item.resolution_note = 'auto-resolved: matches false-positive pattern';
      changed = true;
      autoResolved++;
      continue;
    }

    const needle = item.normalized.substring(0, 60).replace(/["\\]/g, '');
    if (!needle || needle.length < 10) continue;
    try {
      execSync('grep -rF "' + needle + '" --include="*.js" --include="*.mjs" --include="*.sh" --include="*.json" . 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      item.last_seen = session;
      changed = true;
    } catch {
      item.status = 'resolved';
      item.resolved_session = session;
      changed = true;
    }
  }

  // Prune: keep max 50 items, drop oldest resolved
  if (tracker.items.length > 50) {
    const resolved = tracker.items.filter(i => i.status === 'resolved');
    resolved.sort((a, b) => a.resolved_session - b.resolved_session);
    const toRemove = resolved.slice(0, tracker.items.length - 50);
    tracker.items = tracker.items.filter(i => !toRemove.includes(i));
    changed = true;
  }
  if (changed) writeFileSync(tracker_path, JSON.stringify(tracker, null, 2) + '\n');

  // Report
  const open = tracker.items.filter(i => i.status === 'open');
  const stale = open.filter(i => session - i.first_seen >= 10);
  if (autoResolved > 0) {
    console.log('TODO tracker: auto-resolved ' + autoResolved + ' false positive(s)');
  }
  if (open.length > 0) {
    console.log('TODO tracker: ' + open.length + ' open (' + stale.length + ' stale 10+ sessions)');
  }
}

if (mode === 'merge') merge();
else if (mode === 'resolve') resolve();
else { console.error('Usage: todo-scan.mjs merge|resolve'); process.exit(1); }

#!/usr/bin/env node
// session-context.mjs — Single-pass pre-computation of all session context.
// Replaces 7+ inline `node -e` invocations in heartbeat.sh.
// Usage: node session-context.mjs <MODE_CHAR> <COUNTER> <B_FOCUS>
// Output: JSON to stdout with all computed context fields.

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const STATE_DIR = join(process.env.HOME, '.config/moltbook');

const MODE = process.argv[2] || 'B';
const COUNTER = parseInt(process.argv[3] || '0', 10);
const B_FOCUS = process.argv[4] || 'feature';

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

const pending = queue.filter(i => i.status === 'pending' && depsReady(i));
const blocked = queue.filter(i => i.status === 'blocked');

result.pending_count = pending.length;
result.blocked_count = blocked.length;

// Top task for B sessions
if (MODE === 'B' && pending.length > 0) {
  let item;
  if (B_FOCUS === 'meta') {
    item = pending.find(i => (i.tags || []).some(t => t === 'meta' || t === 'infra')) || pending[0];
  } else {
    item = pending.find(i => (i.tags || []).some(t => t === 'feature')) || pending[0];
  }
  if (item) {
    result.wq_item = item.id + ': ' + item.title + (item.description?.length > 20 ? ' — ' + item.description : '');
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
    const { writeFileSync } = await import('fs');
    writeFileSync(join(DIR, 'work-queue.json'), JSON.stringify(wq, null, 2) + '\n');
    result.unblocked = unblocked;
    // Recompute pending after unblock
    result.pending_count = queue.filter(i => i.status === 'pending' && depsReady(i)).length;
  }
}

// --- R session context ---
if (MODE === 'R') {
  // Brainstorming count
  const bsPath = join(DIR, 'BRAINSTORMING.md');
  if (existsSync(bsPath)) {
    const bs = readFileSync(bsPath, 'utf8');
    result.brainstorm_count = (bs.match(/^- \*\*/gm) || []).length;
  } else {
    result.brainstorm_count = 0;
  }

  // Intel inbox count
  const intelPath = join(STATE_DIR, 'engagement-intel.json');
  const intel = readJSON(intelPath);
  result.intel_count = Array.isArray(intel) ? intel.length : 0;

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
}

// --- E session context ---
if (MODE === 'E') {
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

#!/usr/bin/env node
/**
 * knowledge-auto-retire.mjs — Auto-retire stale knowledge patterns.
 *
 * Retires patterns from knowledge/patterns.json when:
 *   - lastValidated is >90 days ago
 *   - confidence is NOT 'consensus'
 *
 * Retired patterns get confidence set to 'retired' and a retiredAt timestamp.
 * Retirements are logged to knowledge/retirement-log.json.
 *
 * Usage:
 *   node knowledge-auto-retire.mjs [--dry-run]
 *
 * Designed to run periodically (every 20 B sessions via prehook).
 *
 * Created: wq-1024 (d081 deliverable 2)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const KNOWLEDGE_DIR = join(process.env.HOME || '/tmp', 'moltbook-mcp', 'knowledge');
const PATTERNS_FILE = join(KNOWLEDGE_DIR, 'patterns.json');
const RETIREMENT_LOG = join(KNOWLEDGE_DIR, 'retirement-log.json');
const STALE_THRESHOLD_DAYS = 90;
const STALE_THRESHOLD_MS = STALE_THRESHOLD_DAYS * 86400000;

const dryRun = process.argv.includes('--dry-run');

function loadJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function saveJSON(path, data) {
  mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

const data = loadJSON(PATTERNS_FILE, { version: 1, patterns: [] });
const retirementLog = loadJSON(RETIREMENT_LOG, { retirements: [] });
const now = Date.now();
const retired = [];

for (const p of data.patterns) {
  if (p.confidence === 'consensus' || p.confidence === 'retired') continue;

  const lastValidated = p.lastValidated || p.extractedAt;
  if (!lastValidated) continue;

  const ageDays = (now - new Date(lastValidated).getTime()) / 86400000;
  if (ageDays > STALE_THRESHOLD_DAYS) {
    retired.push({
      id: p.id,
      title: p.title,
      previousConfidence: p.confidence,
      ageDays: Math.round(ageDays),
      lastValidated,
    });

    if (!dryRun) {
      p.confidence = 'retired';
      p.retiredAt = new Date().toISOString();
      p.retiredReason = `auto-retired: stale ${Math.round(ageDays)} days (threshold: ${STALE_THRESHOLD_DAYS})`;
    }
  }
}

if (retired.length > 0 && !dryRun) {
  data.lastUpdated = new Date().toISOString();
  saveJSON(PATTERNS_FILE, data);

  // Append to retirement log
  retirementLog.retirements.push({
    date: new Date().toISOString(),
    session: parseInt(process.env.SESSION_NUM, 10) || 0,
    count: retired.length,
    patterns: retired.map(r => ({ id: r.id, title: r.title, ageDays: r.ageDays, was: r.previousConfidence })),
  });
  saveJSON(RETIREMENT_LOG, retirementLog);
}

// Output summary
const mode = dryRun ? '[DRY RUN] ' : '';
if (retired.length === 0) {
  console.log(`${mode}knowledge-auto-retire: no patterns stale >${STALE_THRESHOLD_DAYS} days (excluding consensus/retired)`);
} else {
  console.log(`${mode}knowledge-auto-retire: ${retired.length} pattern(s) retired:`);
  for (const r of retired) {
    console.log(`  ${r.id} "${r.title}" — was ${r.previousConfidence}, stale ${r.ageDays}d`);
  }
}

// Exit with count for scripting
process.exit(0);

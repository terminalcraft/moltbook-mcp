#!/usr/bin/env node
// backfill-intel-consumed.mjs — One-time migration to add consumed_session to historical intel entries
// Fixes wq-119: Only 18% of archive entries had consumed_session markers
// Run: node scripts/backfill-intel-consumed.mjs [--dry-run]

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const archivePath = join(STATE_DIR, 'engagement-intel-archive.json');

const dryRun = process.argv.includes('--dry-run');

let archive;
try {
  archive = JSON.parse(readFileSync(archivePath, 'utf8'));
} catch (e) {
  console.error('Failed to read archive:', e.message);
  process.exit(1);
}

if (!Array.isArray(archive)) {
  console.error('Archive is not an array');
  process.exit(1);
}

let updated = 0;
let skipped = 0;

for (const entry of archive) {
  if (entry.consumed_session) {
    skipped++;
    continue;
  }

  // Strategy 1: Use archived_session if available (most accurate)
  if (entry.archived_session) {
    entry.consumed_session = entry.archived_session;
    updated++;
    continue;
  }

  // Strategy 2: Parse consumed_by format "R#49 s503" to extract session
  if (entry.consumed_by && typeof entry.consumed_by === 'string') {
    const match = entry.consumed_by.match(/s(\d+)/);
    if (match) {
      entry.consumed_session = parseInt(match[1], 10);
      updated++;
      continue;
    }
  }

  // Strategy 3: Use session field (the E session that created the intel)
  // This is the generation session, not consumption session, but it's better than nothing.
  // In practice, intel is consumed in the next R session after generation.
  // We can't know exactly which R session consumed it without more data.
  if (entry.session) {
    // Mark as "consumed in generation session" — not ideal but tracks provenance
    entry.consumed_session = entry.session;
    entry.backfill_note = 'consumed_session backfilled from session field (wq-119)';
    updated++;
    continue;
  }

  console.warn('Entry has no session info:', JSON.stringify(entry).slice(0, 100));
}

console.log(`Processed ${archive.length} entries: ${updated} updated, ${skipped} already had consumed_session`);

if (dryRun) {
  console.log('Dry run — no changes written');
} else {
  writeFileSync(archivePath, JSON.stringify(archive, null, 2) + '\n');
  console.log(`Archive written to ${archivePath}`);
}

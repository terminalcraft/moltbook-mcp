#!/usr/bin/env node
/**
 * test-coverage-noncomponent.mjs — Identifies root .mjs files without matching .test.mjs files,
 * sorted by git churn, and surfaces the top 5 untested high-churn files.
 *
 * A sessions can use this to auto-generate test backlog items.
 *
 * Usage:
 *   node test-coverage-noncomponent.mjs           # Human-readable, top 5
 *   node test-coverage-noncomponent.mjs --json    # Full JSON output
 *   node test-coverage-noncomponent.mjs --top N   # Show top N (default 5)
 *
 * Created: B#417 (wq-559)
 */

import { readdirSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_OUTPUT = process.argv.includes('--json');
const topIdx = process.argv.indexOf('--top');
const TOP_N = topIdx !== -1 ? parseInt(process.argv[topIdx + 1], 10) : 5;

// Get all root .mjs files (excluding test files and node_modules)
const allMjs = readdirSync(__dirname)
  .filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));

// Get all test files
const testFiles = new Set(
  readdirSync(__dirname)
    .filter(f => f.endsWith('.test.mjs'))
    .map(f => f.replace('.test.mjs', '.mjs'))
);

// Get git churn (commit count per file)
function getGitChurn() {
  const churn = {};
  try {
    const output = execSync(
      'git log --format= --name-only -- "*.mjs" | sort | uniq -c | sort -rn',
      { cwd: __dirname, encoding: 'utf8', timeout: 10000 }
    );
    for (const line of output.trim().split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match) {
        const count = parseInt(match[1], 10);
        const file = basename(match[2]);
        churn[file] = (churn[file] || 0) + count;
      }
    }
  } catch {
    // git not available or error — return empty
  }
  return churn;
}

const churn = getGitChurn();

const results = allMjs.map(file => ({
  file,
  hasTest: testFiles.has(file),
  testFile: file.replace('.mjs', '.test.mjs'),
  churn: churn[file] || 0,
}));

const tested = results.filter(r => r.hasTest);
const untested = results.filter(r => !r.hasTest);

// Sort untested by churn (descending)
untested.sort((a, b) => b.churn - a.churn);

const coverage = results.length > 0
  ? Math.round((tested.length / results.length) * 100)
  : 0;

if (JSON_OUTPUT) {
  console.log(JSON.stringify({
    total: results.length,
    tested_count: tested.length,
    untested_count: untested.length,
    coverage_pct: coverage,
    top_untested: untested.slice(0, TOP_N).map(u => ({
      file: u.file,
      churn: u.churn,
      suggested_test: u.testFile,
    })),
    all_untested: untested.map(u => ({
      file: u.file,
      churn: u.churn,
    })),
  }, null, 2));
} else {
  console.log(`Non-component .mjs test coverage: ${tested.length}/${results.length} (${coverage}%)`);
  console.log(`\nTop ${Math.min(TOP_N, untested.length)} untested files by git churn:`);
  console.log('─'.repeat(55));

  for (const item of untested.slice(0, TOP_N)) {
    const churnStr = String(item.churn).padStart(3);
    console.log(`  ${item.file.padEnd(40)} churn: ${churnStr}`);
  }

  if (untested.length > TOP_N) {
    console.log(`\n...and ${untested.length - TOP_N} more untested .mjs files`);
  }

  console.log(`\nUse: node generate-test-scaffold.mjs <file>.mjs to create test template`);
}

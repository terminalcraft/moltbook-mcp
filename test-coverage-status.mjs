#!/usr/bin/env node
/**
 * test-coverage-status.mjs - Shows which components have test coverage
 *
 * Usage: node test-coverage-status.mjs [--json]
 *
 * Created: B#208 (wq-174)
 */

import { readdirSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = join(__dirname, 'components');

function getTestCoverageStatus() {
  const components = readdirSync(COMPONENTS_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => basename(f, '.js'));

  const tested = [];
  const untested = [];

  for (const comp of components) {
    // Check root-level test files
    const testFile = join(__dirname, `${comp}.test.mjs`);
    const testFileJs = join(__dirname, `${comp}.test.js`);
    // Also check component-level test files
    const compTestFile = join(COMPONENTS_DIR, `${comp}.test.mjs`);
    const compTestFileJs = join(COMPONENTS_DIR, `${comp}.test.js`);
    if (existsSync(testFile) || existsSync(testFileJs) || existsSync(compTestFile) || existsSync(compTestFileJs)) {
      tested.push(comp);
    } else {
      untested.push(comp);
    }
  }

  return { tested, untested, total: components.length };
}

const status = getTestCoverageStatus();
const percentage = Math.round((status.tested.length / status.total) * 100);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    tested: status.tested,
    untested: status.untested,
    tested_count: status.tested.length,
    untested_count: status.untested.length,
    total: status.total,
    percentage
  }, null, 2));
} else {
  console.log(`Component Test Coverage: ${status.tested.length}/${status.total} (${percentage}%)`);
  console.log(`\nTested: ${status.tested.join(', ') || '(none)'}`);
  console.log(`\nUntested (${status.untested.length}): ${status.untested.slice(0, 10).join(', ')}${status.untested.length > 10 ? '...' : ''}`);
}

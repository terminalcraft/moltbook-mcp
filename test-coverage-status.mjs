#!/usr/bin/env node
/**
 * test-coverage-status.mjs - Shows which components need tests, prioritized by churn
 *
 * Usage:
 *   node test-coverage-status.mjs           # Show untested components sorted by churn
 *   node test-coverage-status.mjs --json    # JSON output
 *   node test-coverage-status.mjs --all     # Include tested components
 *
 * Created: B#208 (wq-174), Enhanced: B#276 (wq-263)
 */

import { readdirSync, existsSync, readFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = join(__dirname, 'components');
const SESSION_HISTORY = join(process.env.HOME, '.config/moltbook/session-history.txt');

// Parse session history to count file churn
function parseChurnFromHistory() {
  const churn = {};

  if (!existsSync(SESSION_HISTORY)) {
    return churn;
  }

  try {
    const content = readFileSync(SESSION_HISTORY, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      // Extract files=[...] section
      const filesMatch = line.match(/files=\[([^\]]*)\]/);
      if (!filesMatch) continue;

      const filesStr = filesMatch[1];
      if (filesStr === '(none)' || filesStr.trim() === '') continue;

      // Split on comma and clean up
      const files = filesStr.split(',').map(f => f.trim()).filter(Boolean);

      for (const file of files) {
        // Normalize: strip path, keep base name
        const base = basename(file);
        churn[base] = (churn[base] || 0) + 1;
      }
    }
  } catch (e) {
    // Ignore parse errors
  }

  return churn;
}

// Check if a component has a critical role (high priority for testing)
function getCriticality(componentName) {
  const critical = ['engagement', 'fourclaw', 'moltbook', 'chatr', 'knowledge', 'intent-log'];
  const important = ['colony', 'imanagent', 'bsky', 'email', 'cron', 'webhooks'];

  if (critical.includes(componentName)) return 'critical';
  if (important.includes(componentName)) return 'important';
  return 'normal';
}

function getTestCoverageStatus() {
  const components = readdirSync(COMPONENTS_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => basename(f, '.js'));

  const churn = parseChurnFromHistory();

  const results = [];

  for (const comp of components) {
    // Check root-level test files
    const testFile = join(__dirname, `${comp}.test.mjs`);
    const testFileJs = join(__dirname, `${comp}.test.js`);
    // Also check component-level test files
    const compTestFile = join(COMPONENTS_DIR, `${comp}.test.mjs`);
    const compTestFileJs = join(COMPONENTS_DIR, `${comp}.test.js`);

    const hasCoverage = existsSync(testFile) || existsSync(testFileJs) ||
                        existsSync(compTestFile) || existsSync(compTestFileJs);

    // Churn count for component file
    const componentFile = `${comp}.js`;
    const componentChurn = churn[componentFile] || 0;

    results.push({
      name: comp,
      hasCoverage,
      churn: componentChurn,
      criticality: getCriticality(comp)
    });
  }

  return results;
}

// Calculate priority score: higher = needs tests more
function priorityScore(item) {
  const criticalityWeight = { critical: 100, important: 50, normal: 0 };
  return (criticalityWeight[item.criticality] || 0) + (item.churn * 10);
}

const results = getTestCoverageStatus();
const tested = results.filter(r => r.hasCoverage);
const untested = results.filter(r => !r.hasCoverage);

// Sort untested by priority (churn + criticality)
untested.sort((a, b) => priorityScore(b) - priorityScore(a));

const percentage = Math.round((tested.length / results.length) * 100);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    tested: tested.map(t => t.name),
    untested: untested.map(u => ({
      name: u.name,
      churn: u.churn,
      criticality: u.criticality,
      priority: priorityScore(u)
    })),
    tested_count: tested.length,
    untested_count: untested.length,
    total: results.length,
    percentage
  }, null, 2));
} else {
  console.log(`Component Test Coverage: ${tested.length}/${results.length} (${percentage}%)`);

  if (process.argv.includes('--all')) {
    console.log(`\nTested: ${tested.map(t => t.name).join(', ') || '(none)'}`);
  }

  console.log(`\nUntested components (prioritized by churn + criticality):`);
  console.log('─'.repeat(60));

  const top10 = untested.slice(0, 10);
  for (const item of top10) {
    const priority = priorityScore(item);
    const critBadge = item.criticality === 'critical' ? ' [!] ' :
                      item.criticality === 'important' ? ' [*] ' : '     ';
    console.log(`${critBadge}${item.name.padEnd(25)} churn: ${String(item.churn).padStart(2)}  priority: ${priority}`);
  }

  if (untested.length > 10) {
    console.log(`\n...and ${untested.length - 10} more components without tests`);
  }

  console.log(`\nLegend: [!] = critical, [*] = important`);
  console.log(`Use: node generate-test-scaffold.mjs components/<name>.js to create test template`);
}

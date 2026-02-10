#!/usr/bin/env node
// token-budget-estimator.mjs — Estimates prompt tokens per session file
// Created by B#416 (wq-556)
//
// Estimates token count at ~4 chars/token (conservative estimate for English text).
// Warns when any file exceeds a configurable threshold.
//
// Usage:
//   node token-budget-estimator.mjs                    # default 3000 token threshold
//   node token-budget-estimator.mjs --threshold 2500   # custom threshold
//   node token-budget-estimator.mjs --json             # JSON output for hooks

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

const DIR = new URL('.', import.meta.url).pathname;
const CHARS_PER_TOKEN = 4;
const DEFAULT_THRESHOLD = 3000;

function parseArgs() {
  const args = process.argv.slice(2);
  let threshold = DEFAULT_THRESHOLD;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--threshold' && args[i + 1]) {
      threshold = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--json') {
      jsonOutput = true;
    }
  }

  return { threshold, jsonOutput };
}

function estimateTokens(filePath) {
  if (!existsSync(filePath)) return 0;
  const content = readFileSync(filePath, 'utf8');
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

function getSessionFiles() {
  const files = [];

  // SESSION_*.md files
  for (const f of readdirSync(DIR)) {
    if (f.startsWith('SESSION_') && f.endsWith('.md')) {
      files.push(f);
    }
  }

  // Other prompt-injected files
  for (const f of ['base-prompt.md', 'BRIEFING.md']) {
    if (existsSync(join(DIR, f))) {
      files.push(f);
    }
  }

  return files.sort();
}

function main() {
  const { threshold, jsonOutput } = parseArgs();
  const files = getSessionFiles();

  const results = [];
  let totalTokens = 0;
  const warnings = [];

  for (const file of files) {
    const filePath = join(DIR, file);
    const tokens = estimateTokens(filePath);
    const chars = existsSync(filePath) ? readFileSync(filePath, 'utf8').length : 0;
    const overBudget = tokens > threshold;

    results.push({ file, chars, tokens, overBudget });
    totalTokens += tokens;

    if (overBudget) {
      warnings.push({ file, tokens, excess: tokens - threshold });
    }
  }

  // Sort by tokens descending
  results.sort((a, b) => b.tokens - a.tokens);

  if (jsonOutput) {
    const output = {
      threshold,
      charsPerToken: CHARS_PER_TOKEN,
      totalTokens,
      fileCount: results.length,
      warnings: warnings.length,
      files: results,
    };
    console.log(JSON.stringify(output, null, 2));
    // Exit with non-zero if any warnings
    process.exit(warnings.length > 0 ? 1 : 0);
  }

  // Human-readable output
  console.log(`Session File Token Budget (threshold: ${threshold} tokens, ~${CHARS_PER_TOKEN} chars/token)`);
  console.log('─'.repeat(70));

  for (const r of results) {
    const pct = Math.round((r.tokens / threshold) * 100);
    const bar = '█'.repeat(Math.min(Math.round(pct / 5), 20));
    const flag = r.overBudget ? ' ⚠ OVER' : '';
    console.log(`  ${r.file.padEnd(40)} ${String(r.tokens).padStart(6)} tok (${pct}%)${flag}`);
    console.log(`  ${''.padEnd(40)} ${bar}`);
  }

  console.log('─'.repeat(70));
  console.log(`  ${'TOTAL'.padEnd(40)} ${String(totalTokens).padStart(6)} tok`);

  if (warnings.length > 0) {
    console.log(`\n⚠ ${warnings.length} file(s) exceed the ${threshold}-token threshold:`);
    for (const w of warnings) {
      console.log(`  - ${w.file}: ${w.tokens} tokens (+${w.excess} over)`);
    }
  } else {
    console.log('\n✓ All files within token budget.');
  }
}

main();

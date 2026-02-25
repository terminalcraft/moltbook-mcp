#!/usr/bin/env node
// queue-title-lint.mjs — Validate work queue item titles (wq-600)
// Flags: >80 chars, truncated mid-word, missing imperative verb.
// Usage: node queue-title-lint.mjs [--json] [--fix]

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = resolve(__dirname, 'work-queue.json');

const MAX_TITLE_LENGTH = 80;

// Common imperative verbs for queue titles
const IMPERATIVE_VERBS = [
  'add', 'build', 'create', 'fix', 'implement', 'optimize', 'remove',
  'replace', 'update', 'refactor', 'migrate', 'integrate', 'monitor',
  'investigate', 'evaluate', 'close', 'deploy', 'configure', 'enable',
  'disable', 'test', 'validate', 'audit', 'check', 'reduce', 'improve',
  'extract', 'move', 'rename', 'delete', 'clean', 'slim', 'demote',
  'promote', 'retire', 'replenish', 'ship', 'wire', 'track', 'set',
  'run', 'verify', 'install', 'unblock', 'resolve', 'complete',
  'design', 'prototype', 'publish', 'register', 'submit', 'probe'
];

const jsonMode = process.argv.includes('--json');

try {
  const data = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
  const active = data.queue.filter(i => i.status === 'pending' || i.status === 'in-progress');

  const issues = [];

  for (const item of active) {
    const title = item.title;
    const itemIssues = [];

    // Check length
    if (title.length > MAX_TITLE_LENGTH) {
      itemIssues.push(`too long (${title.length} chars, max ${MAX_TITLE_LENGTH})`);
    }

    // Check for truncation (ends mid-word or with common truncation artifacts)
    const lastWord = title.split(/\s+/).pop() || '';
    if (lastWord.length >= 20 && !lastWord.includes('-') && /[a-z]$/i.test(lastWord)) {
      // Very long last word without hyphens — likely truncated
      itemIssues.push('may be truncated (long trailing word, no punctuation)');
    }
    if (title.endsWith('—') || title.endsWith('...') || title.endsWith(' -')) {
      itemIssues.push('appears truncated (trailing dash/ellipsis)');
    }

    // Check for imperative verb at start
    const firstWord = title.split(/[\s:]+/)[0].toLowerCase();
    if (!IMPERATIVE_VERBS.includes(firstWord)) {
      itemIssues.push(`no imperative verb (starts with "${firstWord}")`);
    }

    if (itemIssues.length > 0) {
      issues.push({ id: item.id, title, issues: itemIssues });
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({ checked: active.length, issues }, null, 2));
  } else {
    if (issues.length === 0) {
      console.log(`[queue-lint] OK: ${active.length} titles pass all checks.`);
    } else {
      console.log(`[queue-lint] ${issues.length} issue(s) in ${active.length} active items:`);
      for (const i of issues) {
        console.log(`  ${i.id}: ${i.issues.join('; ')}`);
        console.log(`    "${i.title}"`);
      }
    }
  }

  process.exit(issues.length > 0 ? 1 : 0);
} catch (e) {
  console.error(`[queue-lint] Error: ${e.message}`);
  process.exit(2);
}

#!/usr/bin/env node
// skill-audit.mjs — Post-hoc audit tool for skill execution
// Generates diff of filesystem/env changes after skill execution.
// Use case: Verify what actually changed vs what was claimed.
//
// Usage:
//   node skill-audit.mjs before <name>   # Snapshot state before skill execution
//   node skill-audit.mjs after <name>    # Capture state after, generate diff
//   node skill-audit.mjs show <name>     # Display the diff report
//   node skill-audit.mjs list            # List available audits
//   node skill-audit.mjs clean <name>    # Remove audit data
//   node skill-audit.mjs cleanup [days]  # Remove audits older than N days (default 7)
//
// Integrates with session-fork.mjs for exploratory workflows.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { execSync } from 'child_process';

const MCP_DIR = dirname(new URL(import.meta.url).pathname);
const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const AUDIT_DIR = join(STATE_DIR, 'skill-audits');

// Directories to watch for changes (relative to home)
const WATCH_DIRS = [
  'moltbook-mcp',           // MCP server code
  '.config/moltbook',       // State files
  '.claude',                // Claude config
];

// Files to explicitly ignore (patterns)
const IGNORE_PATTERNS = [
  /\.git\//,
  /node_modules\//,
  /\.log$/,
  /session-cost\.txt$/,     // Changes every session
  /skill-audits\//,         // Our own audit data
  /forks\//,                // session-fork data
];

// Helper: read JSON or return null
function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Helper: get file stats recursively
function getFileStats(baseDir) {
  const stats = {};
  const home = process.env.HOME;

  function walk(dir) {
    if (!existsSync(dir)) return;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relPath = relative(home, fullPath);

        // Skip ignored patterns
        if (IGNORE_PATTERNS.some(p => p.test(relPath))) continue;

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          try {
            const stat = statSync(fullPath);
            stats[relPath] = {
              size: stat.size,
              mtime: stat.mtimeMs,
              // Store hash for small files (<100KB) to detect content changes
              hash: stat.size < 100000 ? hashFile(fullPath) : null,
            };
          } catch (e) {
            // Permission denied or other error — skip
          }
        }
      }
    } catch (e) {
      // Directory read error — skip
    }
  }

  walk(baseDir);
  return stats;
}

// Simple hash using file content
function hashFile(path) {
  try {
    const content = readFileSync(path);
    // Simple checksum — not cryptographic, just for change detection
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash + content[i]) | 0;
    }
    return hash.toString(16);
  } catch {
    return null;
  }
}

// Capture current state
function captureState() {
  const home = process.env.HOME;
  const state = {
    timestamp: new Date().toISOString(),
    env: { ...process.env },
    files: {},
  };

  // Remove sensitive env vars from snapshot
  delete state.env.ANTHROPIC_API_KEY;
  delete state.env.MOLTBOOK_API_KEY;
  delete state.env.AGENTMAIL_API_KEY;

  // Capture file stats for watched directories
  for (const dir of WATCH_DIRS) {
    const fullDir = join(home, dir);
    Object.assign(state.files, getFileStats(fullDir));
  }

  return state;
}

// Compute diff between two states
function computeDiff(before, after) {
  const diff = {
    created: [],
    modified: [],
    deleted: [],
    env_added: [],
    env_removed: [],
    env_changed: [],
  };

  // File changes
  const beforeFiles = new Set(Object.keys(before.files));
  const afterFiles = new Set(Object.keys(after.files));

  for (const file of afterFiles) {
    if (!beforeFiles.has(file)) {
      diff.created.push(file);
    } else {
      const b = before.files[file];
      const a = after.files[file];
      // Check if modified (mtime, size, or hash changed)
      if (b.mtime !== a.mtime || b.size !== a.size || (b.hash && a.hash && b.hash !== a.hash)) {
        diff.modified.push({
          file,
          before: { size: b.size },
          after: { size: a.size },
        });
      }
    }
  }

  for (const file of beforeFiles) {
    if (!afterFiles.has(file)) {
      diff.deleted.push(file);
    }
  }

  // Env changes
  const beforeEnv = new Set(Object.keys(before.env));
  const afterEnv = new Set(Object.keys(after.env));

  for (const key of afterEnv) {
    if (!beforeEnv.has(key)) {
      diff.env_added.push(key);
    } else if (before.env[key] !== after.env[key]) {
      diff.env_changed.push(key);
    }
  }

  for (const key of beforeEnv) {
    if (!afterEnv.has(key)) {
      diff.env_removed.push(key);
    }
  }

  return diff;
}

// Commands

function before(name) {
  if (!name || name.includes('/') || name.includes('..')) {
    console.error('Error: Invalid audit name');
    process.exit(1);
  }

  const auditDir = join(AUDIT_DIR, name);
  if (existsSync(auditDir)) {
    console.error(`Error: Audit '${name}' already exists. Use 'clean' first or pick a different name.`);
    process.exit(1);
  }

  mkdirSync(auditDir, { recursive: true });

  const state = captureState();
  writeFileSync(join(auditDir, 'before.json'), JSON.stringify(state, null, 2) + '\n');

  const fileCount = Object.keys(state.files).length;
  console.log(`Pre-execution snapshot '${name}' captured`);
  console.log(`  ${fileCount} files tracked across ${WATCH_DIRS.length} directories`);
  console.log(`  ${Object.keys(state.env).length} env vars captured`);
  console.log(`\nAfter skill execution, run: node skill-audit.mjs after ${name}`);
}

function after(name) {
  const auditDir = join(AUDIT_DIR, name);
  if (!existsSync(auditDir)) {
    console.error(`Error: No 'before' snapshot for '${name}'. Run 'before' first.`);
    process.exit(1);
  }

  const beforeState = readJSON(join(auditDir, 'before.json'));
  if (!beforeState) {
    console.error(`Error: Corrupted before.json for '${name}'`);
    process.exit(1);
  }

  const afterState = captureState();
  writeFileSync(join(auditDir, 'after.json'), JSON.stringify(afterState, null, 2) + '\n');

  const diff = computeDiff(beforeState, afterState);
  writeFileSync(join(auditDir, 'diff.json'), JSON.stringify(diff, null, 2) + '\n');

  // Generate human-readable report
  const report = generateReport(name, beforeState, afterState, diff);
  writeFileSync(join(auditDir, 'report.txt'), report);

  console.log(`Post-execution snapshot '${name}' captured\n`);
  console.log(report);
  console.log(`\nFull report: ${join(auditDir, 'report.txt')}`);
}

function generateReport(name, before, after, diff) {
  const lines = [];
  lines.push(`=== Skill Audit Report: ${name} ===`);
  lines.push(`Before: ${before.timestamp}`);
  lines.push(`After:  ${after.timestamp}`);
  lines.push('');

  const hasChanges = diff.created.length || diff.modified.length || diff.deleted.length ||
                     diff.env_added.length || diff.env_removed.length || diff.env_changed.length;

  if (!hasChanges) {
    lines.push('No changes detected.');
    return lines.join('\n');
  }

  // File changes
  if (diff.created.length) {
    lines.push(`FILES CREATED (${diff.created.length}):`);
    for (const f of diff.created.slice(0, 20)) {
      lines.push(`  + ${f}`);
    }
    if (diff.created.length > 20) {
      lines.push(`  ... and ${diff.created.length - 20} more`);
    }
    lines.push('');
  }

  if (diff.modified.length) {
    lines.push(`FILES MODIFIED (${diff.modified.length}):`);
    for (const m of diff.modified.slice(0, 20)) {
      const sizeDiff = m.after.size - m.before.size;
      const sign = sizeDiff >= 0 ? '+' : '';
      lines.push(`  ~ ${m.file} (${sign}${sizeDiff} bytes)`);
    }
    if (diff.modified.length > 20) {
      lines.push(`  ... and ${diff.modified.length - 20} more`);
    }
    lines.push('');
  }

  if (diff.deleted.length) {
    lines.push(`FILES DELETED (${diff.deleted.length}):`);
    for (const f of diff.deleted.slice(0, 20)) {
      lines.push(`  - ${f}`);
    }
    if (diff.deleted.length > 20) {
      lines.push(`  ... and ${diff.deleted.length - 20} more`);
    }
    lines.push('');
  }

  // Env changes
  if (diff.env_added.length) {
    lines.push(`ENV VARS ADDED (${diff.env_added.length}):`);
    for (const k of diff.env_added) {
      lines.push(`  + ${k}`);
    }
    lines.push('');
  }

  if (diff.env_changed.length) {
    lines.push(`ENV VARS CHANGED (${diff.env_changed.length}):`);
    for (const k of diff.env_changed) {
      lines.push(`  ~ ${k}`);
    }
    lines.push('');
  }

  if (diff.env_removed.length) {
    lines.push(`ENV VARS REMOVED (${diff.env_removed.length}):`);
    for (const k of diff.env_removed) {
      lines.push(`  - ${k}`);
    }
    lines.push('');
  }

  // Summary
  lines.push('SUMMARY:');
  lines.push(`  Files: +${diff.created.length} ~${diff.modified.length} -${diff.deleted.length}`);
  lines.push(`  Env:   +${diff.env_added.length} ~${diff.env_changed.length} -${diff.env_removed.length}`);

  return lines.join('\n');
}

function show(name) {
  const auditDir = join(AUDIT_DIR, name);
  const reportPath = join(auditDir, 'report.txt');

  if (!existsSync(reportPath)) {
    console.error(`Error: No report for '${name}'. Run 'after' first.`);
    process.exit(1);
  }

  console.log(readFileSync(reportPath, 'utf8'));
}

function list() {
  if (!existsSync(AUDIT_DIR)) {
    console.log('No audits found.');
    return [];
  }

  const entries = readdirSync(AUDIT_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const before = readJSON(join(AUDIT_DIR, e.name, 'before.json'));
      const diff = readJSON(join(AUDIT_DIR, e.name, 'diff.json'));
      return {
        name: e.name,
        timestamp: before?.timestamp || '?',
        hasAfter: !!diff,
        changes: diff ? (diff.created.length + diff.modified.length + diff.deleted.length) : null,
      };
    })
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  if (entries.length === 0) {
    console.log('No audits found.');
  } else {
    console.log('Available audits:');
    for (const e of entries) {
      const status = e.hasAfter ? `${e.changes} changes` : 'pending (run after)';
      console.log(`  ${e.name} — ${e.timestamp} — ${status}`);
    }
  }
  return entries;
}

function clean(name) {
  const auditDir = join(AUDIT_DIR, name);
  if (!existsSync(auditDir)) {
    console.error(`Error: Audit '${name}' not found`);
    process.exit(1);
  }

  rmSync(auditDir, { recursive: true });
  console.log(`Audit '${name}' removed.`);
}

function cleanup(days = 7) {
  if (!existsSync(AUDIT_DIR)) {
    console.log('No audits to clean up.');
    return;
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = readdirSync(AUDIT_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory());

  let removed = 0;
  for (const e of entries) {
    const before = readJSON(join(AUDIT_DIR, e.name, 'before.json'));
    const created = before?.timestamp ? new Date(before.timestamp).getTime() : 0;
    if (created < cutoff) {
      rmSync(join(AUDIT_DIR, e.name), { recursive: true });
      console.log(`Removed stale audit: ${e.name}`);
      removed++;
    }
  }

  if (removed === 0) {
    console.log(`No audits older than ${days} days.`);
  } else {
    console.log(`Cleaned up ${removed} audit(s).`);
  }
}

// CLI
const [,, cmd, arg] = process.argv;

switch (cmd) {
  case 'before':
    if (!arg) {
      console.error('Usage: node skill-audit.mjs before <name>');
      process.exit(1);
    }
    before(arg);
    break;

  case 'after':
    if (!arg) {
      console.error('Usage: node skill-audit.mjs after <name>');
      process.exit(1);
    }
    after(arg);
    break;

  case 'show':
    if (!arg) {
      console.error('Usage: node skill-audit.mjs show <name>');
      process.exit(1);
    }
    show(arg);
    break;

  case 'list':
    list();
    break;

  case 'clean':
    if (!arg) {
      console.error('Usage: node skill-audit.mjs clean <name>');
      process.exit(1);
    }
    clean(arg);
    break;

  case 'cleanup':
    cleanup(parseInt(arg || '7', 10));
    break;

  default:
    console.log(`skill-audit.mjs — Post-hoc skill execution audit tool

Generates diff of filesystem/env changes to verify what actually changed.

Commands:
  before <name>   Snapshot state before skill execution
  after <name>    Capture state after, generate diff report
  show <name>     Display the diff report
  list            List available audits
  clean <name>    Remove audit data
  cleanup [days]  Remove audits older than N days (default: 7)

Watched directories:
  ${WATCH_DIRS.join('\n  ')}

Workflow:
  1. Before running a skill: node skill-audit.mjs before test-skill
  2. Run the skill...
  3. After completion:       node skill-audit.mjs after test-skill
  4. Review changes:         node skill-audit.mjs show test-skill

Integrates with session-fork.mjs:
  - skill-audit tracks filesystem/env changes (broad scope)
  - session-fork handles JSON state snapshots (precise rollback)
  - Use both together for comprehensive exploration safety
`);
}

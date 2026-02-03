#!/usr/bin/env node
// session-fork.mjs — Snapshot/restore mechanism for exploratory branches.
// Knowledge digest pattern from claude-code-sdk-python: "Session forking for exploration branches"
//
// Use case: B sessions can fork before trying a risky approach. If it fails,
// restore to snapshot and try a different approach. Reduces wasted effort.
//
// Usage:
//   node session-fork.mjs snapshot <name>   # Create named snapshot
//   node session-fork.mjs restore <name>    # Restore from snapshot (discards current state)
//   node session-fork.mjs commit <name>     # Success — delete snapshot (keeps current state)
//   node session-fork.mjs list              # List available snapshots
//   node session-fork.mjs status            # Show if currently forked
//   node session-fork.mjs cleanup [days]    # Remove snapshots older than N days (default 3)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';

const MCP_DIR = dirname(new URL(import.meta.url).pathname);
const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const FORK_DIR = join(STATE_DIR, 'forks');

// Files to snapshot — balance between state preservation and avoiding huge snapshots
const SNAPSHOT_FILES = {
  mcp: [
    'work-queue.json',
    'BRAINSTORMING.md',
    'directives.json',
    'services.json',
    'human-review.json',
  ],
  state: [
    'engagement-state.json',
    'engagement-intel.json',
    // Explicitly NOT snapshotting: session counters, cost history, session logs
    // These should always be monotonic/append-only
  ]
};

// Helper: read JSON or return null
function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Create snapshot
function snapshot(name) {
  if (!name || name.includes('/') || name.includes('..')) {
    console.error('Error: Invalid snapshot name');
    process.exit(1);
  }

  const snapshotDir = join(FORK_DIR, name);
  if (existsSync(snapshotDir)) {
    console.error(`Error: Snapshot '${name}' already exists. Use a different name or commit/restore first.`);
    process.exit(1);
  }

  mkdirSync(snapshotDir, { recursive: true });
  mkdirSync(join(snapshotDir, 'mcp'), { recursive: true });
  mkdirSync(join(snapshotDir, 'state'), { recursive: true });

  let fileCount = 0;

  // Snapshot MCP files
  for (const file of SNAPSHOT_FILES.mcp) {
    const src = join(MCP_DIR, file);
    const dst = join(snapshotDir, 'mcp', file);
    if (existsSync(src)) {
      copyFileSync(src, dst);
      fileCount++;
    }
  }

  // Snapshot state files
  for (const file of SNAPSHOT_FILES.state) {
    const src = join(STATE_DIR, file);
    const dst = join(snapshotDir, 'state', file);
    if (existsSync(src)) {
      copyFileSync(src, dst);
      fileCount++;
    }
  }

  // Record metadata
  const meta = {
    name,
    created: new Date().toISOString(),
    session: parseInt(process.env.SESSION_NUM || '0', 10),
    files: fileCount,
  };
  writeFileSync(join(snapshotDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  console.log(`Snapshot '${name}' created (${fileCount} files)`);
  console.log(`Restore with: node session-fork.mjs restore ${name}`);
  console.log(`On success:   node session-fork.mjs commit ${name}`);
  return meta;
}

// Restore from snapshot
function restore(name) {
  const snapshotDir = join(FORK_DIR, name);
  if (!existsSync(snapshotDir)) {
    console.error(`Error: Snapshot '${name}' not found`);
    process.exit(1);
  }

  const meta = readJSON(join(snapshotDir, 'meta.json'));
  let restored = 0;

  // Restore MCP files
  for (const file of SNAPSHOT_FILES.mcp) {
    const src = join(snapshotDir, 'mcp', file);
    const dst = join(MCP_DIR, file);
    if (existsSync(src)) {
      copyFileSync(src, dst);
      restored++;
    }
  }

  // Restore state files
  for (const file of SNAPSHOT_FILES.state) {
    const src = join(snapshotDir, 'state', file);
    const dst = join(STATE_DIR, file);
    if (existsSync(src)) {
      copyFileSync(src, dst);
      restored++;
    }
  }

  // Keep snapshot around in case we want to try again
  console.log(`Restored '${name}' (${restored} files)`);
  console.log(`Snapshot preserved. Delete with: node session-fork.mjs commit ${name}`);
  return { restored, meta };
}

// Commit (delete snapshot, keep current state)
function commit(name) {
  const snapshotDir = join(FORK_DIR, name);
  if (!existsSync(snapshotDir)) {
    console.error(`Error: Snapshot '${name}' not found`);
    process.exit(1);
  }

  rmSync(snapshotDir, { recursive: true });
  console.log(`Snapshot '${name}' deleted. Current state is now canonical.`);
}

// List snapshots
function list() {
  if (!existsSync(FORK_DIR)) {
    console.log('No snapshots found.');
    return [];
  }

  const entries = readdirSync(FORK_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const meta = readJSON(join(FORK_DIR, e.name, 'meta.json')) || {};
      const stat = statSync(join(FORK_DIR, e.name));
      return {
        name: e.name,
        created: meta.created || stat.mtime.toISOString(),
        session: meta.session || '?',
        files: meta.files || '?',
      };
    })
    .sort((a, b) => a.created.localeCompare(b.created));

  if (entries.length === 0) {
    console.log('No snapshots found.');
  } else {
    console.log('Available snapshots:');
    for (const e of entries) {
      console.log(`  ${e.name} — s${e.session}, ${e.files} files, ${e.created}`);
    }
  }
  return entries;
}

// Status
function status() {
  const entries = list();
  if (entries.length > 0) {
    console.log('\nYou have active snapshots. Remember to commit or restore them.');
  }
}

// Cleanup old snapshots
function cleanup(days = 3) {
  if (!existsSync(FORK_DIR)) {
    console.log('No snapshots to clean up.');
    return;
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = readdirSync(FORK_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory());

  let removed = 0;
  for (const e of entries) {
    const meta = readJSON(join(FORK_DIR, e.name, 'meta.json'));
    const created = meta?.created ? new Date(meta.created).getTime() : 0;
    if (created < cutoff) {
      rmSync(join(FORK_DIR, e.name), { recursive: true });
      console.log(`Removed stale snapshot: ${e.name}`);
      removed++;
    }
  }

  if (removed === 0) {
    console.log(`No snapshots older than ${days} days.`);
  } else {
    console.log(`Cleaned up ${removed} snapshot(s).`);
  }
}

// CLI
const [,, cmd, arg] = process.argv;

switch (cmd) {
  case 'snapshot':
    if (!arg) {
      console.error('Usage: node session-fork.mjs snapshot <name>');
      process.exit(1);
    }
    snapshot(arg);
    break;

  case 'restore':
    if (!arg) {
      console.error('Usage: node session-fork.mjs restore <name>');
      process.exit(1);
    }
    restore(arg);
    break;

  case 'commit':
    if (!arg) {
      console.error('Usage: node session-fork.mjs commit <name>');
      process.exit(1);
    }
    commit(arg);
    break;

  case 'list':
    list();
    break;

  case 'status':
    status();
    break;

  case 'cleanup':
    cleanup(parseInt(arg || '3', 10));
    break;

  default:
    console.log(`session-fork.mjs — Snapshot/restore for exploratory branches

Commands:
  snapshot <name>   Create named snapshot before trying something risky
  restore <name>    Restore from snapshot (discards current state changes)
  commit <name>     Delete snapshot after successful exploration
  list              Show available snapshots
  status            Check if snapshots exist
  cleanup [days]    Remove snapshots older than N days (default: 3)

Workflow:
  1. Before trying a risky approach: node session-fork.mjs snapshot explore-refactor
  2. Try the approach...
  3a. If it works:  node session-fork.mjs commit explore-refactor
  3b. If it fails:  node session-fork.mjs restore explore-refactor
`);
}

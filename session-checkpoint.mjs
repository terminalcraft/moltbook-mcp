#!/usr/bin/env node
/**
 * B session checkpoint system (wq-203)
 *
 * Provides continuity breadcrumbs for truncated sessions.
 * Write checkpoints during work; successor sessions read them for recovery.
 *
 * Usage:
 *   node session-checkpoint.mjs write <task_id> <phase> <intent>  # Save checkpoint
 *   node session-checkpoint.mjs read                              # Read latest checkpoint
 *   node session-checkpoint.mjs clear                             # Clear checkpoint after completion
 *
 * Example:
 *   node session-checkpoint.mjs write wq-203 implementation "Building checkpoint system"
 *   node session-checkpoint.mjs read
 *   node session-checkpoint.mjs clear
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';

const CHECKPOINT_FILE = `${homedir()}/.config/moltbook/b-session-checkpoint.json`;

import { execSync } from 'child_process';

function writeCheckpoint(taskId, phase, intent) {
  const checkpoint = {
    task_id: taskId,
    phase: phase,
    intent: intent,
    session: parseInt(process.env.SESSION_NUM) || 0,
    timestamp: new Date().toISOString(),
    files_modified: [],
    commits: []
  };

  // Try to capture recent git state
  try {
    const gitStatus = execSync('git status --porcelain 2>/dev/null', { encoding: 'utf8', cwd: `${homedir()}/moltbook-mcp` });
    checkpoint.files_modified = gitStatus.split('\n').filter(l => l.trim()).map(l => l.slice(3));

    const gitLog = execSync('git log --oneline -1 2>/dev/null', { encoding: 'utf8', cwd: `${homedir()}/moltbook-mcp` });
    checkpoint.last_commit = gitLog.trim();
  } catch (e) {
    // Git info optional
  }

  writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
  console.log(`Checkpoint saved: ${taskId} @ ${phase}`);
  console.log(`  Intent: ${intent}`);
  if (checkpoint.files_modified.length > 0) {
    console.log(`  Modified: ${checkpoint.files_modified.join(', ')}`);
  }
}

function readCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) {
    console.log('No checkpoint found.');
    return null;
  }

  const checkpoint = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf8'));
  const age = Date.now() - new Date(checkpoint.timestamp).getTime();
  const ageMinutes = Math.round(age / 60000);

  console.log('=== B Session Checkpoint ===');
  console.log(`Task: ${checkpoint.task_id}`);
  console.log(`Phase: ${checkpoint.phase}`);
  console.log(`Intent: ${checkpoint.intent}`);
  console.log(`Session: s${checkpoint.session}`);
  console.log(`Age: ${ageMinutes} minutes`);

  if (checkpoint.files_modified?.length > 0) {
    console.log(`Modified files: ${checkpoint.files_modified.join(', ')}`);
  }
  if (checkpoint.last_commit) {
    console.log(`Last commit: ${checkpoint.last_commit}`);
  }

  // Warn if checkpoint is stale (>30 min)
  if (ageMinutes > 30) {
    console.log('\n⚠️  Checkpoint is stale (>30 min). Session may have completed normally.');
  }

  return checkpoint;
}

function clearCheckpoint() {
  if (existsSync(CHECKPOINT_FILE)) {
    unlinkSync(CHECKPOINT_FILE);
    console.log('Checkpoint cleared.');
  } else {
    console.log('No checkpoint to clear.');
  }
}

// Main
const [,, command, ...args] = process.argv;

switch (command) {
  case 'write':
    if (args.length < 3) {
      console.error('Usage: node session-checkpoint.mjs write <task_id> <phase> <intent>');
      process.exit(1);
    }
    writeCheckpoint(args[0], args[1], args.slice(2).join(' '));
    break;
  case 'read':
    readCheckpoint();
    break;
  case 'clear':
    clearCheckpoint();
    break;
  default:
    console.log('B Session Checkpoint System (wq-203)');
    console.log('Usage:');
    console.log('  node session-checkpoint.mjs write <task_id> <phase> <intent>');
    console.log('  node session-checkpoint.mjs read');
    console.log('  node session-checkpoint.mjs clear');
}

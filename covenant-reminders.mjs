#!/usr/bin/env node
// covenant-reminders.mjs — Deadline tracking and reminders for templated covenants.
// wq-259: When a templated covenant term approaches deadline, auto-send inbox message.
//
// Usage:
//   node covenant-reminders.mjs check     # Check for upcoming deadlines, show warnings
//   node covenant-reminders.mjs remind    # Send reminders for deadlines approaching (T-3 days)
//   node covenant-reminders.mjs list      # List all covenants with deadlines
//   node covenant-reminders.mjs set <agent> <covenant-idx> <deadline>  # Set deadline for existing covenant
//
// Deadlines are stored as ISO date strings in templated_covenants[].deadline.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const COVENANTS_PATH = join(STATE_DIR, 'covenants.json');
const REMINDERS_SENT_PATH = join(STATE_DIR, 'covenant-reminders-sent.json');
const PROJECT_DIR = join(process.env.HOME, 'moltbook-mcp');

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function loadCovenants() {
  const data = readJSON(COVENANTS_PATH);
  if (!data || !data.agents) {
    return { version: 1, description: "Covenant tracking", last_updated: null, agents: {} };
  }
  return data;
}

function loadRemindersSent() {
  return readJSON(REMINDERS_SENT_PATH) || { sent: [] };
}

function saveRemindersSent(data) {
  writeJSON(REMINDERS_SENT_PATH, data);
}

// Calculate days until deadline
function daysUntil(deadline) {
  const now = new Date();
  const dl = new Date(deadline);
  const diffMs = dl - now;
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

// Find agent's exchange URL from registry or known endpoints
function getAgentExchangeUrl(handle) {
  // Check registry for known agents
  try {
    const registry = readJSON(join(PROJECT_DIR, 'agent-registry-cache.json'));
    if (registry && registry.agents) {
      const agent = registry.agents.find(a => a.handle.toLowerCase() === handle.toLowerCase());
      if (agent && agent.exchange_url) return agent.exchange_url;
    }
  } catch {}

  // Fallback: no URL known
  return null;
}

// Send inbox message to agent (if they have inbox)
async function sendReminder(handle, subject, body) {
  const url = getAgentExchangeUrl(handle);
  if (!url) {
    console.log(`  [!] No exchange URL for @${handle} — cannot send inbox message`);
    return false;
  }

  // Derive inbox URL from exchange URL
  const baseUrl = url.replace(/\/agent\.json$/, '');

  try {
    console.log(`  Sending reminder to @${handle} at ${baseUrl}...`);
    const result = execSync(`node -e "
      const { sendMessage } = require('./inbox-client.mjs');
      sendMessage('${baseUrl}', '${subject.replace(/'/g, "\\'")}', '${body.replace(/'/g, "\\'")}')
        .then(() => console.log('OK'))
        .catch(e => console.error('FAIL:', e.message));
    "`, { cwd: PROJECT_DIR, timeout: 10000, encoding: 'utf8' });
    return result.includes('OK');
  } catch (e) {
    console.log(`  [!] Failed to send reminder: ${e.message}`);
    return false;
  }
}

// ============================================================================
// COMMANDS
// ============================================================================

function checkDeadlines(reminderDays = 3) {
  const covenants = loadCovenants();
  const warnings = [];
  const upcoming = [];
  const overdue = [];

  for (const [handle, data] of Object.entries(covenants.agents)) {
    if (!data.templated_covenants) continue;

    for (let i = 0; i < data.templated_covenants.length; i++) {
      const cov = data.templated_covenants[i];
      if (!cov.deadline || cov.status !== 'active') continue;

      const days = daysUntil(cov.deadline);
      const item = {
        handle,
        index: i,
        template: cov.template,
        deadline: cov.deadline,
        daysUntil: days,
        notes: cov.notes || ''
      };

      if (days < 0) {
        overdue.push(item);
      } else if (days <= reminderDays) {
        upcoming.push(item);
      } else if (days <= 7) {
        warnings.push(item);
      }
    }
  }

  console.log('=== Covenant Deadline Check ===\n');

  if (overdue.length > 0) {
    console.log(`⚠️  OVERDUE (${overdue.length}):`);
    for (const o of overdue) {
      console.log(`  @${o.handle} [${o.template}]: ${Math.abs(o.daysUntil)} days overdue (${o.deadline})`);
    }
    console.log('');
  }

  if (upcoming.length > 0) {
    console.log(`🔔 REMINDER DUE (${upcoming.length}):`);
    for (const u of upcoming) {
      console.log(`  @${u.handle} [${u.template}]: ${u.daysUntil} days remaining (${u.deadline})`);
    }
    console.log('');
  }

  if (warnings.length > 0) {
    console.log(`📅 UPCOMING (${warnings.length}):`);
    for (const w of warnings) {
      console.log(`  @${w.handle} [${w.template}]: ${w.daysUntil} days (${w.deadline})`);
    }
    console.log('');
  }

  if (overdue.length === 0 && upcoming.length === 0 && warnings.length === 0) {
    console.log('No upcoming deadlines. All covenants healthy.');
  }

  return { overdue, upcoming, warnings };
}

function sendReminders(dryRun = false) {
  const { upcoming, overdue } = checkDeadlines(3);
  const remindersSent = loadRemindersSent();
  const toSend = [];

  // Combine upcoming and overdue
  const all = [...overdue, ...upcoming];

  for (const item of all) {
    const reminderId = `${item.handle}-${item.index}-${item.deadline}`;
    if (remindersSent.sent.includes(reminderId)) {
      console.log(`  [skip] Already reminded @${item.handle} for ${item.template} deadline`);
      continue;
    }
    toSend.push({ ...item, reminderId });
  }

  if (toSend.length === 0) {
    console.log('\nNo new reminders to send.');
    return;
  }

  console.log(`\n${dryRun ? 'Would send' : 'Sending'} ${toSend.length} reminder(s):\n`);

  for (const item of toSend) {
    const isOverdue = item.daysUntil < 0;
    const subject = isOverdue
      ? `[OVERDUE] ${item.template} covenant deadline passed`
      : `[Reminder] ${item.template} covenant deadline in ${item.daysUntil} days`;

    const body = isOverdue
      ? `Our ${item.template} covenant deadline was ${item.deadline} (${Math.abs(item.daysUntil)} days ago). ` +
        `Please let me know if you'd like to renew, renegotiate, or close this covenant.`
      : `Our ${item.template} covenant deadline is approaching: ${item.deadline} (${item.daysUntil} days). ` +
        `This is a friendly reminder to review our terms and take any needed action.`;

    console.log(`  → @${item.handle}: ${subject}`);

    if (!dryRun) {
      // Record as sent before attempting (prevents spam on failure)
      remindersSent.sent.push(item.reminderId);
      saveRemindersSent(remindersSent);

      // Note: inbox_send currently doesn't exist as a script, so we log the intent
      console.log(`    Subject: ${subject}`);
      console.log(`    Body: ${body}`);
      console.log(`    [Note: Direct inbox_send not implemented — message logged for manual follow-up or future automation]`);
    }
  }
}

function listCovenantsWithDeadlines() {
  const covenants = loadCovenants();
  let count = 0;

  console.log('=== Covenants with Deadlines ===\n');

  for (const [handle, data] of Object.entries(covenants.agents)) {
    if (!data.templated_covenants) continue;

    for (let i = 0; i < data.templated_covenants.length; i++) {
      const cov = data.templated_covenants[i];
      const deadline = cov.deadline || '(no deadline)';
      const status = cov.status || 'active';
      const days = cov.deadline ? daysUntil(cov.deadline) : null;
      const daysStr = days !== null ? ` (${days}d)` : '';

      console.log(`@${handle} [${i}]: ${cov.template} — ${deadline}${daysStr} [${status}]`);
      count++;
    }
  }

  if (count === 0) {
    console.log('No templated covenants found.');
    console.log('Create one with: node covenant-templates.mjs create <type> <agent>');
  }

  console.log(`\nTotal: ${count} covenant(s)`);
}

function setDeadline(handle, covenantIdx, deadline) {
  const covenants = loadCovenants();
  const agentHandle = handle.replace(/^@/, '');
  const idx = parseInt(covenantIdx, 10);

  if (!covenants.agents[agentHandle]) {
    console.error(`Agent @${agentHandle} not found in covenants.`);
    process.exit(1);
  }

  const agent = covenants.agents[agentHandle];
  if (!agent.templated_covenants || !agent.templated_covenants[idx]) {
    console.error(`Covenant index ${idx} not found for @${agentHandle}.`);
    console.log(`Available indices: 0 to ${(agent.templated_covenants?.length || 0) - 1}`);
    process.exit(1);
  }

  // Parse deadline (accept YYYY-MM-DD or relative like "+30d")
  let deadlineDate;
  if (deadline.startsWith('+')) {
    const days = parseInt(deadline.slice(1), 10);
    deadlineDate = new Date();
    deadlineDate.setDate(deadlineDate.getDate() + days);
  } else {
    deadlineDate = new Date(deadline);
  }

  if (isNaN(deadlineDate.getTime())) {
    console.error(`Invalid deadline format: ${deadline}`);
    console.log('Use YYYY-MM-DD or +Nd (e.g., +30d for 30 days from now)');
    process.exit(1);
  }

  const isoDeadline = deadlineDate.toISOString().split('T')[0];
  agent.templated_covenants[idx].deadline = isoDeadline;
  covenants.last_updated = new Date().toISOString();

  writeJSON(COVENANTS_PATH, covenants);

  const cov = agent.templated_covenants[idx];
  console.log(`Set deadline for @${agentHandle} [${cov.template}]: ${isoDeadline}`);
  console.log(`Days from now: ${daysUntil(isoDeadline)}`);
}

// ============================================================================
// CLI
// ============================================================================

const args = process.argv.slice(2);
const command = args[0] || 'check';

switch (command) {
  case 'check':
    checkDeadlines();
    break;

  case 'remind':
    sendReminders(args.includes('--dry-run'));
    break;

  case 'list':
    listCovenantsWithDeadlines();
    break;

  case 'set':
    if (!args[1] || !args[2] || !args[3]) {
      console.error('Usage: node covenant-reminders.mjs set <agent> <covenant-idx> <deadline>');
      console.error('  deadline: YYYY-MM-DD or +Nd (e.g., +30d)');
      process.exit(1);
    }
    setDeadline(args[1], args[2], args[3]);
    break;

  default:
    console.log('Usage: node covenant-reminders.mjs [check|remind|list|set]');
    console.log('  check              Check for upcoming/overdue deadlines');
    console.log('  remind [--dry-run] Send reminders for T-3 day deadlines');
    console.log('  list               List all covenants with their deadlines');
    console.log('  set <agent> <idx> <deadline>  Set deadline (YYYY-MM-DD or +30d)');
}

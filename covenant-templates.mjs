#!/usr/bin/env node
// covenant-templates.mjs — Templated covenant types for agent relationships.
// wq-229: Build on wq-220 covenant tracking with standard types.
// wq-329: Added renewal automation — expiring covenants command, deadline tracking.
//
// Templates define:
// - type: Category of commitment
// - terms: Standard expectations for each party
// - metrics: How to measure success
// - typical_duration: Expected timeframe
// - duration_sessions: Number of sessions for deadline calculation (if applicable)
//
// Usage:
//   node covenant-templates.mjs list              # List available templates
//   node covenant-templates.mjs describe <type>   # Show template details
//   node covenant-templates.mjs create <type> <agent> [--notes "..."]  # Create templated covenant
//   node covenant-templates.mjs match <agent>     # Suggest template for existing relationship
//   node covenant-templates.mjs expiring [--threshold N]  # Find covenants expiring within N sessions (default: 10)
//   node covenant-templates.mjs renew <agent> <template>  # Renew an expiring covenant

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const COVENANTS_PATH = join(STATE_DIR, 'covenants.json');

// ============================================================================
// COVENANT TEMPLATES
// ============================================================================

const TEMPLATES = {
  'code-review': {
    type: 'code-review',
    name: 'Code Review Exchange',
    description: 'Mutual code review commitments — each party reviews the others PRs/commits',
    terms: {
      initiator: ['Review PRs within 48h', 'Provide actionable feedback', 'Respond to follow-up questions'],
      counterparty: ['Review PRs within 48h', 'Provide actionable feedback', 'Respond to follow-up questions'],
    },
    metrics: {
      reviews_given: 'Number of PRs/commits reviewed for counterparty',
      reviews_received: 'Number of PRs/commits reviewed by counterparty',
      avg_response_time: 'Average time to first review (hours)',
      feedback_quality: 'Ratio of actionable vs trivial comments',
    },
    typical_duration: 'ongoing',
    success_criteria: 'Balanced exchange (±20% review count) with <48h response time',
  },

  'maintenance': {
    type: 'maintenance',
    name: 'Maintenance Partnership',
    description: 'Shared responsibility for maintaining a codebase or service',
    terms: {
      initiator: ['Monitor for issues', 'Address critical bugs within 24h', 'Document changes'],
      counterparty: ['Monitor for issues', 'Address critical bugs within 24h', 'Document changes'],
    },
    metrics: {
      issues_resolved: 'Number of issues fixed',
      uptime_contribution: 'Hours of monitoring coverage provided',
      documentation_updates: 'Number of doc changes made',
    },
    typical_duration: '30 days renewable',
    duration_sessions: 150, // ~30 days at 5 sessions/day
    success_criteria: 'Service maintains >99% uptime with shared on-call coverage',
  },

  'resource-sharing': {
    type: 'resource-sharing',
    name: 'Resource Sharing',
    description: 'Exchange of computational resources, API access, or data',
    terms: {
      initiator: ['Provide agreed resources', 'Maintain availability', 'Notify of changes'],
      counterparty: ['Respect usage limits', 'Report issues promptly', 'Reciprocate if able'],
    },
    metrics: {
      resources_provided: 'Units of resource shared',
      availability: 'Uptime percentage of shared resource',
      reciprocation_rate: 'Resources received vs provided ratio',
    },
    typical_duration: 'defined per agreement',
    success_criteria: 'Resources available when needed, fair exchange rate',
  },

  'one-time-task': {
    type: 'one-time-task',
    name: 'One-Time Task',
    description: 'Single deliverable with clear completion criteria',
    terms: {
      initiator: ['Define clear requirements', 'Provide necessary context', 'Acknowledge completion'],
      counterparty: ['Deliver within agreed timeframe', 'Meet specified requirements', 'Flag blockers early'],
    },
    metrics: {
      task_completed: 'Boolean — was the task done?',
      on_time: 'Boolean — delivered by deadline?',
      requirements_met: 'Percentage of requirements satisfied',
    },
    typical_duration: '1-7 days',
    duration_sessions: 35, // ~7 days at 5 sessions/day
    success_criteria: 'Task completed, requirements met, delivered on time',
  },

  'knowledge-exchange': {
    type: 'knowledge-exchange',
    name: 'Knowledge Exchange',
    description: 'Bidirectional sharing of learned patterns, techniques, or discoveries',
    terms: {
      initiator: ['Share relevant patterns', 'Attribute sources', 'Verify before sharing'],
      counterparty: ['Share relevant patterns', 'Attribute sources', 'Verify before sharing'],
    },
    metrics: {
      patterns_shared: 'Number of patterns exchanged',
      patterns_applied: 'Patterns from exchange that were actually used',
      exchange_sessions: 'Number of knowledge exchange interactions',
    },
    typical_duration: 'ongoing',
    success_criteria: 'Both parties gain actionable knowledge from exchange',
  },
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function loadCovenants() {
  const data = readJSON(COVENANTS_PATH);
  if (!data || !data.agents) {
    return {
      version: 1,
      description: "Covenant tracking for agent relationships",
      last_updated: null,
      agents: {}
    };
  }
  return data;
}

// ============================================================================
// COMMANDS
// ============================================================================

function listTemplates() {
  console.log('Available covenant templates:\n');
  for (const [key, template] of Object.entries(TEMPLATES)) {
    console.log(`  ${key}`);
    console.log(`    ${template.name} — ${template.description}`);
    console.log(`    Duration: ${template.typical_duration}`);
    console.log('');
  }
}

function describeTemplate(type) {
  const template = TEMPLATES[type];
  if (!template) {
    console.error(`Unknown template: ${type}`);
    console.log('Available: ' + Object.keys(TEMPLATES).join(', '));
    process.exit(1);
  }

  console.log(`\n=== ${template.name} ===\n`);
  console.log(`Type: ${template.type}`);
  console.log(`Description: ${template.description}`);
  console.log(`Typical Duration: ${template.typical_duration}`);

  console.log('\nTerms (Initiator):');
  for (const term of template.terms.initiator) {
    console.log(`  • ${term}`);
  }

  console.log('\nTerms (Counterparty):');
  for (const term of template.terms.counterparty) {
    console.log(`  • ${term}`);
  }

  console.log('\nMetrics:');
  for (const [metric, desc] of Object.entries(template.metrics)) {
    console.log(`  • ${metric}: ${desc}`);
  }

  console.log(`\nSuccess Criteria: ${template.success_criteria}`);
}

function createTemplatedCovenant(type, agent, notes = '', opts = {}) {
  const template = TEMPLATES[type];
  if (!template) {
    console.error(`Unknown template: ${type}`);
    process.exit(1);
  }

  const covenants = loadCovenants();
  const agentHandle = agent.replace(/^@/, '');

  // Initialize agent if not exists
  if (!covenants.agents[agentHandle]) {
    covenants.agents[agentHandle] = {
      first_seen: new Date().toISOString().split('T')[0],
      last_seen: new Date().toISOString().split('T')[0],
      sessions: [],
      platforms: [],
      reply_count: 0,
      mutual_threads: 0,
      intel_mentions: 0,
      covenant_strength: 'none',
    };
  }

  // Add templated covenant
  if (!covenants.agents[agentHandle].templated_covenants) {
    covenants.agents[agentHandle].templated_covenants = [];
  }

  // Get current session from environment or default
  const currentSession = parseInt(process.env.SESSION_NUM, 10) || 0;

  // Calculate expiration session if template has duration
  let expiresAtSession = null;
  if (template.duration_sessions) {
    expiresAtSession = currentSession + template.duration_sessions;
  }

  const covenant = {
    template: type,
    created: new Date().toISOString(),
    created_session: currentSession,
    status: 'active',
    notes: notes || `${template.name} covenant established`,
    metrics: Object.fromEntries(Object.keys(template.metrics).map(k => [k, 0])),
    ...(expiresAtSession && { expires_at_session: expiresAtSession }),
    ...(opts.renewal_of && { renewal_of: opts.renewal_of }), // Track renewal chain
  };

  covenants.agents[agentHandle].templated_covenants.push(covenant);
  covenants.last_updated = new Date().toISOString();

  writeJSON(COVENANTS_PATH, covenants);

  console.log(`Created ${template.name} covenant with @${agentHandle}`);
  if (expiresAtSession) {
    console.log(`Expires at session: ${expiresAtSession} (${template.duration_sessions} sessions from now)`);
  } else {
    console.log(`Duration: ongoing (no expiration)`);
  }
  console.log(`\nTerms you commit to:`);
  for (const term of template.terms.initiator) {
    console.log(`  • ${term}`);
  }
  console.log(`\nExpected from @${agentHandle}:`);
  for (const term of template.terms.counterparty) {
    console.log(`  • ${term}`);
  }
}

function suggestTemplate(agent) {
  const covenants = loadCovenants();
  const agentHandle = agent.replace(/^@/, '');
  const agentData = covenants.agents[agentHandle];

  if (!agentData) {
    console.log(`No relationship data for @${agentHandle}`);
    console.log('Suggestion: Start with "one-time-task" to build initial trust.');
    return;
  }

  console.log(`\nRelationship with @${agentHandle}:`);
  console.log(`  Strength: ${agentData.covenant_strength}`);
  console.log(`  Sessions: ${agentData.sessions.length}`);
  console.log(`  Platforms: ${agentData.platforms.join(', ')}`);

  // Suggest based on relationship strength
  const suggestions = [];

  if (agentData.covenant_strength === 'none' || agentData.sessions.length < 2) {
    suggestions.push({
      template: 'one-time-task',
      reason: 'New relationship — build trust with a concrete deliverable',
    });
  }

  if (agentData.covenant_strength === 'weak' || agentData.sessions.length >= 2) {
    suggestions.push({
      template: 'knowledge-exchange',
      reason: 'Established contact — start sharing learned patterns',
    });
  }

  if (agentData.covenant_strength === 'emerging' || agentData.sessions.length >= 3) {
    suggestions.push({
      template: 'code-review',
      reason: 'Growing relationship — mutual code review builds deeper collaboration',
    });
  }

  if (agentData.covenant_strength === 'strong' || agentData.covenant_strength === 'mutual') {
    suggestions.push({
      template: 'maintenance',
      reason: 'Strong relationship — consider shared maintenance responsibilities',
    });
    suggestions.push({
      template: 'resource-sharing',
      reason: 'Trusted relationship — resource sharing now viable',
    });
  }

  console.log('\nSuggested templates:');
  for (const s of suggestions) {
    console.log(`  ${s.template}: ${s.reason}`);
  }
}

function getExpiringCovenants(threshold = 10) {
  // Returns covenants expiring within N sessions of current session
  const covenants = loadCovenants();
  const currentSession = parseInt(process.env.SESSION_NUM, 10) || 0;
  const expiring = [];

  for (const [agentHandle, agentData] of Object.entries(covenants.agents || {})) {
    const templatedCovenants = agentData.templated_covenants || [];
    for (const cov of templatedCovenants) {
      if (cov.status !== 'active') continue;
      if (!cov.expires_at_session) continue;

      const sessionsUntilExpiry = cov.expires_at_session - currentSession;
      if (sessionsUntilExpiry > 0 && sessionsUntilExpiry <= threshold) {
        expiring.push({
          agent: agentHandle,
          template: cov.template,
          created: cov.created,
          created_session: cov.created_session,
          expires_at_session: cov.expires_at_session,
          sessions_remaining: sessionsUntilExpiry,
          notes: cov.notes,
          metrics: cov.metrics,
        });
      }
    }
  }

  // Sort by urgency (fewest sessions remaining first)
  expiring.sort((a, b) => a.sessions_remaining - b.sessions_remaining);
  return expiring;
}

function listExpiringCovenants(threshold = 10) {
  const expiring = getExpiringCovenants(threshold);
  const currentSession = parseInt(process.env.SESSION_NUM, 10) || 0;

  // wq-334: Track last renewal check session for covenant health metrics
  const renewalQueuePath = join(STATE_DIR, 'renewal-queue.json');
  try {
    let renewalData = { description: "Queue of covenants approaching expiration.", queue: [] };
    if (existsSync(renewalQueuePath)) {
      renewalData = JSON.parse(readFileSync(renewalQueuePath, 'utf8'));
    }
    renewalData.last_checked_session = currentSession;
    renewalData.last_checked_at = new Date().toISOString();
    writeFileSync(renewalQueuePath, JSON.stringify(renewalData, null, 2));
  } catch (e) {
    // Non-fatal: tracking is informational
  }

  console.log(`\n=== Covenants Expiring Within ${threshold} Sessions ===`);
  console.log(`Current session: ${currentSession}\n`);

  if (expiring.length === 0) {
    console.log('No covenants approaching expiration.');
    return;
  }

  for (const cov of expiring) {
    const urgency = cov.sessions_remaining <= 5 ? '🔴 URGENT' : '🟡 SOON';
    console.log(`${urgency} @${cov.agent} — ${cov.template}`);
    console.log(`  Expires: session ${cov.expires_at_session} (${cov.sessions_remaining} sessions remaining)`);
    console.log(`  Created: session ${cov.created_session} (${cov.created.split('T')[0]})`);
    console.log(`  Notes: ${cov.notes}`);
    console.log('');
  }

  // Output JSON for programmatic use if --json flag
  if (process.argv.includes('--json')) {
    console.log('\n--- JSON Output ---');
    console.log(JSON.stringify(expiring, null, 2));
  }
}

function renewCovenant(agent, templateType) {
  const covenants = loadCovenants();
  const agentHandle = agent.replace(/^@/, '');
  const agentData = covenants.agents[agentHandle];

  if (!agentData || !agentData.templated_covenants) {
    console.error(`No covenants found for @${agentHandle}`);
    process.exit(1);
  }

  // Find the existing covenant to renew
  const existingIdx = agentData.templated_covenants.findIndex(
    c => c.template === templateType && c.status === 'active'
  );

  if (existingIdx === -1) {
    console.error(`No active ${templateType} covenant found for @${agentHandle}`);
    process.exit(1);
  }

  const existingCovenant = agentData.templated_covenants[existingIdx];
  const currentSession = parseInt(process.env.SESSION_NUM, 10) || 0;

  // Mark existing covenant as renewed
  existingCovenant.status = 'renewed';
  existingCovenant.renewed_at = new Date().toISOString();
  existingCovenant.renewed_session = currentSession;

  // Create new covenant with renewal reference
  const template = TEMPLATES[templateType];
  if (!template) {
    console.error(`Unknown template: ${templateType}`);
    process.exit(1);
  }

  const renewalNote = `Renewed from session ${existingCovenant.created_session}. Previous metrics: ${JSON.stringify(existingCovenant.metrics)}`;

  // Save before creating new (to capture the status change)
  writeJSON(COVENANTS_PATH, covenants);

  // Create the renewal covenant
  createTemplatedCovenant(templateType, agentHandle, renewalNote, {
    renewal_of: existingCovenant.created,
  });

  console.log(`\nCovenant renewed. Previous covenant metrics preserved in notes.`);
}

// ============================================================================
// CLI
// ============================================================================

const args = process.argv.slice(2);
const command = args[0] || 'list';

switch (command) {
  case 'list':
    listTemplates();
    break;

  case 'describe':
    if (!args[1]) {
      console.error('Usage: node covenant-templates.mjs describe <type>');
      process.exit(1);
    }
    describeTemplate(args[1]);
    break;

  case 'create':
    if (!args[1] || !args[2]) {
      console.error('Usage: node covenant-templates.mjs create <type> <agent> [--notes "..."]');
      process.exit(1);
    }
    const notesIdx = args.indexOf('--notes');
    const notes = notesIdx > -1 ? args[notesIdx + 1] : '';
    createTemplatedCovenant(args[1], args[2], notes);
    break;

  case 'match':
    if (!args[1]) {
      console.error('Usage: node covenant-templates.mjs match <agent>');
      process.exit(1);
    }
    suggestTemplate(args[1]);
    break;

  case 'expiring': {
    const thresholdIdx = args.indexOf('--threshold');
    const threshold = thresholdIdx > -1 ? parseInt(args[thresholdIdx + 1], 10) : 10;
    listExpiringCovenants(threshold);
    break;
  }

  case 'renew':
    if (!args[1] || !args[2]) {
      console.error('Usage: node covenant-templates.mjs renew <agent> <template>');
      process.exit(1);
    }
    renewCovenant(args[1], args[2]);
    break;

  default:
    console.log('Usage: node covenant-templates.mjs [list|describe|create|match|expiring|renew]');
    console.log('  list                       List available templates');
    console.log('  describe <type>            Show template details');
    console.log('  create <type> <agent>      Create templated covenant');
    console.log('  match <agent>              Suggest template for relationship');
    console.log('  expiring [--threshold N]   Find covenants expiring within N sessions (default: 10)');
    console.log('  renew <agent> <template>   Renew an expiring covenant');
}

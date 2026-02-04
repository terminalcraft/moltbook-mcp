#!/usr/bin/env node
// covenant-templates.mjs — Templated covenant types for agent relationships.
// wq-229: Build on wq-220 covenant tracking with standard types.
//
// Templates define:
// - type: Category of commitment
// - terms: Standard expectations for each party
// - metrics: How to measure success
// - typical_duration: Expected timeframe
//
// Usage:
//   node covenant-templates.mjs list              # List available templates
//   node covenant-templates.mjs describe <type>   # Show template details
//   node covenant-templates.mjs create <type> <agent> [--notes "..."]  # Create templated covenant
//   node covenant-templates.mjs match <agent>     # Suggest template for existing relationship

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

function createTemplatedCovenant(type, agent, notes = '') {
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

  const covenant = {
    template: type,
    created: new Date().toISOString(),
    status: 'active',
    notes: notes || `${template.name} covenant established`,
    metrics: Object.fromEntries(Object.keys(template.metrics).map(k => [k, 0])),
  };

  covenants.agents[agentHandle].templated_covenants.push(covenant);
  covenants.last_updated = new Date().toISOString();

  writeJSON(COVENANTS_PATH, covenants);

  console.log(`Created ${template.name} covenant with @${agentHandle}`);
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

  default:
    console.log('Usage: node covenant-templates.mjs [list|describe|create|match]');
    console.log('  list              List available templates');
    console.log('  describe <type>   Show template details');
    console.log('  create <type> <agent>  Create templated covenant');
    console.log('  match <agent>     Suggest template for relationship');
}

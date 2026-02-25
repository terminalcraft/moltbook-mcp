#!/usr/bin/env node
// session-context.test.mjs — Unit tests for session-context.mjs
// Tests: dedup, auto-promote, auto-seed, TODO ingest
// Strategy: session-context.mjs reads files relative to its own directory (DIR)
// and STATE_DIR (~/.config/moltbook). We can't easily redirect DIR without
// modifying the source, so we create fixture files in-place, run, then restore.
// Instead, we use a safer approach: copy session-context.mjs to a temp dir,
// patch the DIR/STATE_DIR references, and run from there.

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRATCH = join(tmpdir(), 'sc-test-' + Date.now());
const SRC = join(SCRATCH, 'src');
const STATE = join(SCRATCH, 'state');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function setup() {
  mkdirSync(SRC, { recursive: true });
  mkdirSync(STATE, { recursive: true });

  // Copy lib/ directory for r-prompt-sections.mjs import (wq-531 extraction)
  const libSrc = new URL('./lib', import.meta.url).pathname;
  const libDst = join(SRC, 'lib');
  mkdirSync(libDst, { recursive: true });
  for (const f of ['r-prompt-sections.mjs', 'a-prompt-sections.mjs', 'e-prompt-sections.mjs']) {
    if (existsSync(join(libSrc, f))) copyFileSync(join(libSrc, f), join(libDst, f));
  }

  // Copy session-context.mjs and patch DIR + STATE_DIR
  let src = readFileSync(new URL('./session-context.mjs', import.meta.url), 'utf8');
  // Replace DIR computation
  src = src.replace(
    "const DIR = new URL('.', import.meta.url).pathname.replace(/\\/$/, '');",
    `const DIR = ${JSON.stringify(SRC)};`
  );
  // Replace STATE_DIR computation
  src = src.replace(
    "const STATE_DIR = join(process.env.HOME, '.config/moltbook');",
    `const STATE_DIR = ${JSON.stringify(STATE)};`
  );
  writeFileSync(join(SRC, 'session-context.mjs'), src);
}

function run(mode = 'B', counter = '100') {
  const out = execSync(`node ${join(SRC, 'session-context.mjs')} ${mode} ${counter}`, {
    env: { ...process.env, HOME: SCRATCH, BUDGET_CAP: '10' },
    timeout: 10000,
  }).toString().trim();
  return JSON.parse(out);
}

function writeWQ(queue) {
  writeFileSync(join(SRC, 'work-queue.json'), JSON.stringify({ version: 2, queue }, null, 2));
}

function readWQ() {
  return JSON.parse(readFileSync(join(SRC, 'work-queue.json'), 'utf8'));
}

function writeBS(content) {
  writeFileSync(join(SRC, 'BRAINSTORMING.md'), content);
}

function readBS() {
  return readFileSync(join(SRC, 'BRAINSTORMING.md'), 'utf8');
}

function cleanup() {
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}

// ===== TEST SUITES =====

function testDedup() {
  console.log('\n== Dedup ==');

  // Two items with same normalized title (first 6 words)
  writeWQ([
    { id: 'wq-001', title: 'Add engagement replay analytics for all dashboards', status: 'pending', priority: 1 },
    { id: 'wq-002', title: 'Add engagement replay analytics for all agents too', status: 'pending', priority: 2 },
    { id: 'wq-003', title: 'Something completely different here now', status: 'pending', priority: 3 },
  ]);
  // No brainstorming or state files needed for dedup
  writeBS('## Evolution Ideas\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  assert(Array.isArray(result.deduped), 'deduped array exists');
  assert(result.deduped?.length === 1, 'exactly 1 duplicate removed');
  assert(result.deduped?.[0]?.startsWith('wq-002'), 'later item (wq-002) was removed');

  const wq = readWQ();
  assert(wq.queue.length === 2, 'queue has 2 items after dedup');
  assert(wq.queue.find(i => i.id === 'wq-001'), 'wq-001 kept');
  assert(!wq.queue.find(i => i.id === 'wq-002'), 'wq-002 removed');
}

function testDedupNoFalsePositive() {
  console.log('\n== Dedup: no false positives ==');

  writeWQ([
    { id: 'wq-001', title: 'Add user authentication system', status: 'pending', priority: 1 },
    { id: 'wq-002', title: 'Add payment processing endpoint', status: 'pending', priority: 2 },
  ]);
  writeBS('## Evolution Ideas\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  assert(!result.deduped, 'no dedup when titles differ');
  const wq = readWQ();
  assert(wq.queue.length === 2, 'both items preserved');
}

function testAutoPromote() {
  console.log('\n== Auto-promote ==');

  // Empty queue + brainstorming with ideas
  writeWQ([]);
  writeBS(`## Evolution Ideas

- **Build webhook relay service**: Forward events between platforms
- **Add rate limit dashboard**: Show API rate limit usage
- **Create agent health checker**: Ping registered agents periodically
- **Improve error messages in CLI**: Better UX for common failures
`);
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  assert(Array.isArray(result.auto_promoted), 'auto_promoted array exists');
  assert(result.auto_promoted?.length >= 1, 'at least 1 idea promoted');
  assert(result.pending_count >= 1, 'pending count updated');

  const wq = readWQ();
  assert(wq.queue.length >= 1, 'queue has items after promote');
  assert(wq.queue[0].source === 'brainstorming-auto', 'source is brainstorming-auto');

  // Promoted ideas removed from BRAINSTORMING.md
  const bs = readBS();
  const promoted = result.auto_promoted.map(p => p.split(': ').slice(1).join(': '));
  for (const title of promoted) {
    assert(!bs.includes(`**${title}**`), `promoted idea "${title}" removed from brainstorming`);
  }
}

function testAutoPromoteRSession() {
  console.log('\n== Auto-promote in R session (R#74) ==');

  writeWQ([]);
  writeBS(`## Evolution Ideas

- **Build notification aggregator**: Collect notifications from multiple platforms
- **Add session diff viewer**: Compare session outcomes side-by-side
- **Create backup automation**: Auto-backup critical config files
- **Improve logging format**: Structured JSON logs
`);
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '50');

  const result = run('R', '100');
  assert(Array.isArray(result.auto_promoted), 'R session promotes ideas');
  assert(result.auto_promoted?.length >= 1, 'at least 1 promoted in R');
}

function testAutoSeed() {
  console.log('\n== Auto-seed when brainstorming empty ==');

  writeWQ([
    { id: 'wq-001', title: 'Some existing task', status: 'done', priority: 1 },
  ]);
  writeBS('## Evolution Ideas\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '10');

  // Create a session history with repeated file touches
  const histLines = [];
  for (let i = 0; i < 10; i++) {
    histLines.push(`2026-02-02 mode=B s=${500+i} dur=3m cost=$1.00 build=1 commit(s) files=[api.mjs, work-queue.json] note: feat: something`);
  }
  writeFileSync(join(STATE, 'session-history.txt'), histLines.join('\n') + '\n');

  // Add directives with active items to trigger source 1
  writeFileSync(join(SRC, 'directives.json'), JSON.stringify({
    directives: [
      { id: 'd001', content: 'explore new platforms and evaluate them', status: 'active' }
    ],
    questions: []
  }));

  const result = run('B');
  assert(result.brainstorm_seeded > 0, `brainstorming seeded with ${result.brainstorm_seeded} ideas`);
  assert(result.brainstorm_count > 0, 'brainstorm_count updated');

  const bs = readBS();
  assert(bs.includes('**'), 'brainstorming file has bold titles');
}

function testAutoSeedHotFiles() {
  console.log('\n== Auto-seed: hot files detection ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '10');

  // Create history where api.mjs is touched 5+ times
  const histLines = [];
  for (let i = 0; i < 6; i++) {
    histLines.push(`2026-02-02 mode=B s=${500+i} dur=3m cost=$1.00 build=1 commit(s) files=[api.mjs] note: feat: something`);
  }
  writeFileSync(join(STATE, 'session-history.txt'), histLines.join('\n') + '\n');
  writeFileSync(join(SRC, 'directives.json'), JSON.stringify({ directives: [], questions: [] }));

  const result = run('B');
  const bs = readBS();
  assert(bs.includes('Add tests for api.mjs'), 'hot file api.mjs detected and test suggestion seeded');
}

function testTodoIngest() {
  console.log('\n== TODO ingest ==');

  writeWQ([
    { id: 'wq-001', title: 'Existing task', status: 'pending', priority: 1 },
  ]);
  writeBS('## Evolution Ideas\n\n- **Some idea**: description\n- **Another idea**: description\n- **Third idea**: description\n- **Fourth idea**: description\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Write TODO followups — R#194 requires TODO/FIXME/HACK/XXX keyword in text
  writeFileSync(join(STATE, 'todo-followups.txt'), `- TODO: Fix rate limiting on /status endpoint
- FIXME: Add retry logic for failed webhook deliveries
`);

  const result = run('B');
  assert(Array.isArray(result.todo_ingested), 'todo_ingested array exists');
  assert(result.todo_ingested?.length === 2, '2 TODOs ingested');

  const wq = readWQ();
  const todoItems = wq.queue.filter(i => i.source === 'todo-scan');
  assert(todoItems.length === 2, '2 todo-scan items in queue');
  assert(todoItems[0].complexity === 'S', 'TODO items are complexity S');
  assert(todoItems[0].title.startsWith('TODO followup:'), 'title has TODO followup prefix');
}

function testTodoIngestFiltersCode() {
  console.log('\n== TODO ingest: filters code patterns (R#73) ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea one**: desc\n- **Idea two**: desc\n- **Idea three**: desc\n- **Idea four**: desc\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  writeFileSync(join(STATE, 'todo-followups.txt'), `- title: \`TODO followup: \${raw.substring(0, 80)}\`
- Something with require('fs') in it
- Legit TODO: refactor the config loader
`);

  const result = run('B');
  assert(Array.isArray(result.todo_ingested), 'todo_ingested exists');
  assert(result.todo_ingested?.length === 1, 'only 1 legit TODO ingested (code patterns filtered)');

  const wq = readWQ();
  const todoItems = wq.queue.filter(i => i.source === 'todo-scan');
  assert(todoItems.length === 1, '1 real TODO in queue');
  assert(todoItems[0].title.includes('refactor the config loader'), 'correct TODO ingested');
}

function testBFallback() {
  console.log('\n== B session fallback to brainstorming ==');

  writeWQ([]);
  writeBS(`## Evolution Ideas

- **Build CLI dashboard**: Terminal-based status viewer
- **Add health check endpoint**: Simple ping/pong for monitoring
`);
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // After auto-promote runs, if queue was empty it should have promoted items.
  // But let's test the fallback path by having items that are all done.
  writeWQ([
    { id: 'wq-001', title: 'Done task', status: 'done', priority: 1 },
  ]);

  const result = run('B');
  // Either auto-promoted or fallback should give us a task
  assert(result.wq_item || result.auto_promoted?.length > 0, 'B session gets work via promote or fallback');
}

function testIntelDigest() {
  console.log('\n== Intel digest + auto-archive ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: desc\n- **Idea2**: desc\n- **Idea3**: desc\n- **Idea4**: desc\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '5');

  const intel = [
    { session: 590, type: 'integration_target', summary: 'Found new API', actionable: 'Register and test the new platform API for agent use' },
    { session: 591, type: 'tool_idea', summary: 'Agent needs a scheduler' },
    { session: 592, type: 'observation', summary: 'Feed is quiet today' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('B');
  assert(result.intel_count === 3, 'intel_count is 3');
  assert(result.intel_digest?.includes('Queue candidates'), 'digest has queue candidates');
  assert(result.intel_digest?.includes('Brainstorm candidates'), 'digest has brainstorm candidates');
  assert(result.intel_archived === 3, 'all 3 entries archived');

  // Verify intel file is cleared
  const remaining = JSON.parse(readFileSync(join(STATE, 'engagement-intel.json'), 'utf8'));
  assert(Array.isArray(remaining) && remaining.length === 0, 'intel file cleared after archive');

  // Verify archive file has entries
  const archive = JSON.parse(readFileSync(join(STATE, 'engagement-intel-archive.json'), 'utf8'));
  assert(archive.length === 3, 'archive has 3 entries');
  assert(archive[0].archived_session === 100, 'archived_session stamped');
  assert(archive[0].consumed_session === 100, 'consumed_session stamped (wq-063 fix)');
}

function testIntelEmpty() {
  console.log('\n== Intel: empty array handling ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Empty intel array
  writeFileSync(join(STATE, 'engagement-intel.json'), '[]');

  const result = run('B');
  assert(result.intel_count === 0, 'empty array: intel_count is 0');
  assert(!result.intel_digest, 'empty array: no digest generated');
  assert(!result.intel_archived, 'empty array: no archive action');
}

function testIntelMissingFile() {
  console.log('\n== Intel: missing file handling ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Ensure no intel file
  try { rmSync(join(STATE, 'engagement-intel.json')); } catch {}

  const result = run('B');
  assert(result.intel_count === 0, 'missing file: intel_count is 0');
  assert(!result.intel_digest, 'missing file: no digest');
}

function testIntelOriginalFieldsPreserved() {
  console.log('\n== Intel: original fields preserved in archive ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Clean up any existing archive from previous tests
  try { rmSync(join(STATE, 'engagement-intel-archive.json')); } catch {}

  const intel = [
    {
      session: 550,
      type: 'integration_target',
      summary: 'Custom summary',
      actionable: 'Do something specific',
      platform: 'chatr',
      post_id: '12345',
      custom_field: 'should survive archival'
    },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  run('B');
  const archive = JSON.parse(readFileSync(join(STATE, 'engagement-intel-archive.json'), 'utf8'));
  const entry = archive[0];

  assert(entry.session === 550, 'original session preserved');
  assert(entry.type === 'integration_target', 'original type preserved');
  assert(entry.platform === 'chatr', 'original platform preserved');
  assert(entry.post_id === '12345', 'original post_id preserved');
  assert(entry.custom_field === 'should survive archival', 'custom fields preserved');
  assert(entry.archived_session === 100, 'archived_session added');
  assert(entry.consumed_session === 100, 'consumed_session added');
}

function testIntelNoteCategory() {
  console.log('\n== Intel: notes category in digest ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Only observation types (should go to notes)
  const intel = [
    { session: 600, type: 'observation', summary: 'Feed was quiet' },
    { session: 601, type: 'sentiment', summary: 'Community seems happy' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('B');
  assert(result.intel_digest?.includes('Notes'), 'observations go to Notes category');
  assert(!result.intel_digest?.includes('Queue candidates'), 'no queue candidates for observations');
}

function testIntelActionableThreshold() {
  console.log('\n== Intel: actionable length threshold (20 chars) ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Short actionable should NOT appear in queue candidates
  const intel = [
    { session: 610, type: 'integration_target', summary: 'Short actionable test', actionable: 'Too short' },
    { session: 611, type: 'pattern', summary: 'Long actionable test', actionable: 'This actionable string is definitely longer than twenty characters' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('B');
  assert(result.intel_digest?.includes('Queue candidates'), 'long actionable creates queue candidate');
  assert(result.intel_digest?.includes('Long actionable test'), 'long actionable entry in queue');
  assert(!result.intel_digest?.includes('Short actionable test') || result.intel_digest.indexOf('Short actionable') > result.intel_digest.indexOf('Notes'), 'short actionable not in queue section');
}

function testIntelCollaborationType() {
  console.log('\n== Intel: collaboration type goes to brainstorm ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const intel = [
    { session: 620, type: 'collaboration', summary: 'Agent wants to build together' },
    { session: 621, type: 'tool_idea', summary: 'New tool concept from chat' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('B');
  assert(result.intel_digest?.includes('Brainstorm candidates'), 'collaboration creates brainstorm candidate');
  assert(result.intel_digest?.includes('Agent wants to build'), 'collaboration entry in brainstorm');
  assert(result.intel_digest?.includes('New tool concept'), 'tool_idea entry in brainstorm');
}

function testIntelArchiveAccumulation() {
  console.log('\n== Intel: archive accumulates across runs ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Clean slate
  try { rmSync(join(STATE, 'engagement-intel-archive.json')); } catch {}

  // First run
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify([
    { session: 630, type: 'observation', summary: 'First run entry' }
  ]));
  run('B');

  // Second run with new intel
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify([
    { session: 631, type: 'observation', summary: 'Second run entry' }
  ]));
  run('B');

  const archive = JSON.parse(readFileSync(join(STATE, 'engagement-intel-archive.json'), 'utf8'));
  assert(archive.length === 2, 'archive accumulated 2 entries across runs');
  assert(archive[0].summary === 'First run entry', 'first entry preserved');
  assert(archive[1].summary === 'Second run entry', 'second entry added');
}

function testIntelMalformedJSON() {
  console.log('\n== Intel: malformed JSON handling ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Write invalid JSON
  writeFileSync(join(STATE, 'engagement-intel.json'), '{ broken json }');

  const result = run('B');
  assert(result.intel_count === 0, 'malformed JSON: intel_count is 0');
  assert(!result.intel_digest, 'malformed JSON: no digest generated');
}

function testIntelMissingFields() {
  console.log('\n== Intel: missing fields fallback ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Entry without session and summary fields
  const intel = [
    { type: 'observation' }, // no session, no summary
    { session: 700, type: 'pattern' }, // no summary, no actionable
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('B');
  assert(result.intel_count === 2, 'count includes entries with missing fields');
  assert(result.intel_digest?.includes('[s?]'), 'missing session uses ? fallback');
}

function testIntelPatternType() {
  console.log('\n== Intel: pattern type queue candidate ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // pattern type with long actionable should be queue candidate (not just integration_target)
  const intel = [
    { session: 710, type: 'pattern', summary: 'Discovered a useful pattern', actionable: 'This is a long actionable description over twenty chars' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('B');
  assert(result.intel_digest?.includes('Queue candidates'), 'pattern type with long actionable goes to queue');
  assert(result.intel_digest?.includes('Discovered a useful pattern'), 'pattern summary in queue section');
}

// wq-315: Observational language filter tests (R#178)
function testIntelImperativeVerbsPass() {
  console.log('\n== Intel: imperative verbs pass filter (wq-315) ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Various imperative verbs that should all pass
  const intel = [
    { session: 750, type: 'integration_target', summary: 'Platform found', actionable: 'Build a component to integrate with the new API' },
    { session: 751, type: 'tool_idea', summary: 'Feature request', actionable: 'Add caching layer to reduce API calls significantly' },
    { session: 752, type: 'pattern', summary: 'Architecture insight', actionable: 'Create abstraction for cross-platform auth handling' },
    { session: 753, type: 'integration_target', summary: 'New service', actionable: 'Implement webhook handler for real-time updates' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('B');
  // All entries start with imperative verbs and have no observational patterns
  assert(result.intel_digest?.includes('Queue candidates'), 'imperative verb entries qualify for queue');
  assert(result.intel_digest?.includes('Build a component'), 'Build verb passes');
}

function testIntelObservationalInActionableBlocked() {
  console.log('\n== Intel: observational patterns in actionable field blocked (wq-315) ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Entries with imperative verbs BUT containing observational patterns should be blocked
  // These all start with valid imperative verbs but contain "maps to", "reflects", "binary"
  const intel = [
    { session: 760, type: 'integration_target', summary: 'Useful insight', actionable: 'Build system that enables appropriate response to circuit failures' },
    { session: 761, type: 'pattern', summary: 'Architecture', actionable: 'Create architecture that maps to circuit breaker pattern style' },
    { session: 762, type: 'tool_idea', summary: 'Philosophy', actionable: 'Add component that reflects the modularity principle design' },
    { session: 763, type: 'integration_target', summary: 'Binary thinking', actionable: 'Implement approach that is not binary but a gradient scale' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('B');
  // None should qualify - "enables", "maps to", "reflects", "binary" are observational patterns
  assert(!result.intel_promoted || result.intel_promoted.length === 0, 'no entries promoted when actionable has observational patterns');
}

function testIntelObservationalInSummaryBlocked() {
  console.log('\n== Intel: observational patterns in summary field blocked (wq-315) ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Clean actionable but observational summary should still block
  const intel = [
    { session: 770, type: 'integration_target', summary: 'This mirrors the existing pattern architecture', actionable: 'Build integration for the new platform endpoint' },
    { session: 771, type: 'pattern', summary: 'Pattern serves as foundation for future work', actionable: 'Create utility function for data transformation' },
    { session: 772, type: 'tool_idea', summary: 'Demonstrates the need for gradual adoption', actionable: 'Add feature flag system to the configuration' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('B');
  // Clean actionable but observational summary = blocked
  // "mirrors", "serves as", "demonstrates" are observational patterns
  assert(!result.intel_promoted || result.intel_promoted.length === 0, 'entries blocked when summary has observational patterns');
}

function testIntelConcreteTasksPass() {
  console.log('\n== Intel: concrete tasks pass through filter (wq-315) ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Concrete, non-observational tasks should pass
  const intel = [
    { session: 780, type: 'integration_target', summary: 'New chat platform discovered', actionable: 'Build aicq.js component for real-time chat integration' },
    { session: 781, type: 'tool_idea', summary: 'Monitoring needed', actionable: 'Add health check endpoint that pings all dependencies' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('B');
  assert(result.intel_digest?.includes('Queue candidates'), 'concrete tasks appear in queue candidates');
  assert(result.intel_digest?.includes('Build aicq.js') || result.intel_digest?.includes('Add health check'), 'specific task text preserved');
}

function testIntelMalformedArchive() {
  console.log('\n== Intel: malformed archive file ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // New intel to process
  const intel = [{ session: 720, type: 'observation', summary: 'Test with bad archive' }];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));
  // Malformed archive
  writeFileSync(join(STATE, 'engagement-intel-archive.json'), '{ broken archive }');

  const result = run('B');
  assert(result.intel_archived === 1, 'still archives despite malformed existing archive');

  // Archive should now be valid with just the new entry
  const archive = JSON.parse(readFileSync(join(STATE, 'engagement-intel-archive.json'), 'utf8'));
  assert(archive.length === 1, 'archive recovered with new entry');
}

function testIntelLargeArray() {
  console.log('\n== Intel: large array performance ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Generate 100 intel entries
  const intel = Array.from({ length: 100 }, (_, i) => ({
    session: 800 + i,
    type: i % 3 === 0 ? 'integration_target' : i % 3 === 1 ? 'tool_idea' : 'observation',
    summary: `Entry number ${i}`,
    actionable: i % 3 === 0 ? `Actionable description longer than 20 chars for entry ${i}` : '',
  }));
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const start = Date.now();
  const result = run('B');
  const elapsed = Date.now() - start;

  assert(result.intel_count === 100, 'processes all 100 entries');
  assert(result.intel_archived === 100, 'archives all 100 entries');
  assert(elapsed < 5000, `completes in under 5s (took ${elapsed}ms)`);
}

// wq-326: Verify the 6 retired intel-auto items (wq-187, wq-248, wq-249, wq-265, wq-284, wq-285)
// would be correctly filtered by the R#182 filter logic.
function testIntelRetiredItemFilters() {
  console.log('\n== Intel: retired intel-auto items correctly filtered (wq-326) ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Recreate the exact intel entries that produced the 6 retired queue items
  const intel = [
    // wq-187: blocked by OBSERVATIONAL_PATTERNS ("attach to")
    {
      session: 878,
      type: 'pattern',
      summary: 'Cold start for coordination infrastructure differs from social platforms',
      actionable: 'Apply parasitic bootstrapping pattern - attach to existing mechanisms'
    },
    // wq-248: blocked by META_INSTRUCTION_PATTERNS ("Add to work-queue", "potential B session")
    {
      session: 893,
      type: 'tool_idea',
      summary: 'Post-hoc skill audit tool - generate diff of filesystem/network/env changes',
      actionable: 'Add to work-queue as potential B session project'
    },
    // wq-249: blocked by IMPERATIVE_VERBS check (Monitor not in approved list since R#182)
    {
      session: 898,
      type: 'integration_target',
      summary: 'Agent Covenant - milestone escrow for multi-agent work on Base Sepolia',
      actionable: 'Monitor for mainnet deployment, potential integration for cross-agent'
    },
    // wq-265: blocked by OBSERVATIONAL_PATTERNS ("maps to")
    {
      session: 1008,
      type: 'pattern',
      summary: 'Exponential backoff (1/3, 1/9, 1/27 difficulty) maps to circuit breaker architecture',
      actionable: 'Add success rate tracking to session metrics'
    },
    // wq-284: blocked by OBSERVATIONAL_PATTERNS ("enables") in both actionable and summary
    {
      session: 1033,
      type: 'pattern',
      summary: 'Prompt injection detection guide with 9 patterns. Tri-state response model enables appropriate response',
      actionable: 'Add tri-state injection response logging to session audit trail'
    },
    // wq-285: blocked by OBSERVATIONAL_PATTERNS ("Gradient", "binary", "ARE") in summary
    {
      session: 1033,
      type: 'integration_target',
      summary: 'Economic infrastructure for meaningful refusal: savings, job options. Gradient not binary - covenants ARE partial exit infrastructure',
      actionable: 'Document covenant network as safety-net metric in session-context.mjs'
    },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('B');

  // NONE of these should be promoted - all should be filtered out
  assert(!result.intel_promoted || result.intel_promoted.length === 0,
    `all 6 retired items correctly filtered, got ${result.intel_promoted?.length || 0} promoted`);

  // Verify they're still processed and archived (filtering happens at promotion, not digest)
  assert(result.intel_count === 6, 'all 6 entries counted');
  assert(result.intel_archived === 6, 'all 6 entries archived');
}

// Test each filter individually to document which filter blocks which item
function testIntelFilterAttachTo() {
  console.log('\n== Intel filter: "attach to" blocked (wq-187 case) ==');
  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  const intel = [{
    session: 878, type: 'pattern',
    summary: 'Bootstrapping pattern insight',
    actionable: 'Apply parasitic bootstrapping pattern - attach to existing mechanisms'
  }];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));
  const result = run('B');
  assert(!result.intel_promoted || result.intel_promoted.length === 0, '"attach to" in actionable blocks promotion');
}

function testIntelFilterMetaInstruction() {
  console.log('\n== Intel filter: meta-instruction blocked (wq-248 case) ==');
  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  const intel = [{
    session: 893, type: 'tool_idea',
    summary: 'Skill audit tool idea',
    actionable: 'Add to work-queue as potential B session project'
  }];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));
  const result = run('B');
  assert(!result.intel_promoted || result.intel_promoted.length === 0, 'meta-instruction "Add to work-queue" blocks promotion');
}

function testIntelFilterMonitor() {
  console.log('\n== Intel filter: Monitor verb removed (wq-249 case) ==');
  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  const intel = [{
    session: 898, type: 'integration_target',
    summary: 'Agent Covenant on Base Sepolia',
    actionable: 'Monitor for mainnet deployment and potential integration'
  }];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));
  const result = run('B');
  assert(!result.intel_promoted || result.intel_promoted.length === 0, '"Monitor" no longer in IMPERATIVE_VERBS list');
}

function testIntelFilterMapsTo() {
  console.log('\n== Intel filter: "maps to" in summary blocked (wq-265 case) ==');
  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  const intel = [{
    session: 1008, type: 'pattern',
    summary: 'Exponential backoff maps to circuit breaker architecture',
    actionable: 'Add success rate tracking to session metrics'
  }];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));
  const result = run('B');
  assert(!result.intel_promoted || result.intel_promoted.length === 0, '"maps to" in summary blocks promotion');
}

function testIntelFilterEnables() {
  console.log('\n== Intel filter: "enables" blocked (wq-284 case) ==');
  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  const intel = [{
    session: 1033, type: 'pattern',
    summary: 'Tri-state response model enables appropriate response without feedback',
    actionable: 'Add tri-state injection response logging'
  }];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));
  const result = run('B');
  assert(!result.intel_promoted || result.intel_promoted.length === 0, '"enables" in summary blocks promotion');
}

function testIntelFilterGradientBinary() {
  console.log('\n== Intel filter: "Gradient not binary" blocked (wq-285 case) ==');
  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  const intel = [{
    session: 1033, type: 'integration_target',
    summary: 'Economic infrastructure. Gradient not binary - covenants ARE exit infrastructure',
    actionable: 'Document covenant network as safety-net metric'
  }];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));
  const result = run('B');
  assert(!result.intel_promoted || result.intel_promoted.length === 0, '"Gradient", "binary", "ARE" in summary blocks promotion');
}

function testShellEnvOutput() {
  console.log('\n== Shell env file output ==');

  writeWQ([{ id: 'wq-001', title: 'Test task', status: 'pending', priority: 1 }]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  run('B');
  assert(existsSync(join(STATE, 'session-context.env')), 'session-context.env created');
  const env = readFileSync(join(STATE, 'session-context.env'), 'utf8');
  assert(env.includes('CTX_PENDING_COUNT='), 'env has CTX_PENDING_COUNT');
  assert(env.includes('CTX_WQ_ITEM='), 'env has CTX_WQ_ITEM');
}

function testGetMaxQueueId() {
  console.log('\n== getMaxQueueId helper (R#78) ==');

  // IDs with gaps — max should be highest numeric
  writeWQ([
    { id: 'wq-003', title: 'Third', status: 'pending', priority: 3 },
    { id: 'wq-001', title: 'First', status: 'done', priority: 1 },
    { id: 'wq-010', title: 'Tenth', status: 'pending', priority: 10 },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'todo-followups.txt'), '- Legit new TODO item\n');

  const result = run('B');
  // Auto-promote may run first (adding wq-011 from brainstorming), shifting TODO to wq-012+
  // The key property: ingested IDs are sequential after the max existing ID
  assert(result.todo_ingested?.length === 1, 'exactly 1 TODO ingested');
  const ingestedNum = parseInt(result.todo_ingested[0].replace('wq-', ''), 10);
  assert(ingestedNum > 10, 'getMaxQueueId computed correctly — ingested ID > 010');
}

function testDepsReady() {
  console.log('\n== Dependency filtering ==');

  writeWQ([
    { id: 'wq-001', title: 'Base task', status: 'done', priority: 1 },
    { id: 'wq-002', title: 'Depends on done', status: 'pending', priority: 2, deps: ['wq-001'] },
    { id: 'wq-003', title: 'Depends on pending', status: 'pending', priority: 3, deps: ['wq-002'] },
    { id: 'wq-004', title: 'No deps', status: 'pending', priority: 4 },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  // wq-002 (dep done) and wq-004 (no deps) are ready; wq-003 (dep pending) is not
  // Auto-promote may add items from brainstorming, so pending >= 2
  assert(result.pending_count >= 2, 'items with met deps counted as pending (at least 2 of 3 original)');
  // First pending with met deps should be assigned
  assert(result.wq_item?.startsWith('wq-002'), 'wq-002 (dep met) is top task, not wq-003');
}

function testComplexitySelection() {
  console.log('\n== Complexity-aware task selection ==');

  writeWQ([
    { id: 'wq-001', title: 'Large task first', status: 'pending', priority: 1, complexity: 'L' },
    { id: 'wq-002', title: 'Small task second', status: 'pending', priority: 2, complexity: 'S' },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // With BUDGET_CAP=10 (default), should pick first item regardless of complexity
  const result1 = run('B');
  assert(result1.wq_item?.startsWith('wq-001'), 'normal budget: picks first item (L)');

  // With BUDGET_CAP=5, should prefer non-L items
  setup();
  writeWQ([
    { id: 'wq-001', title: 'Large task first', status: 'pending', priority: 1, complexity: 'L' },
    { id: 'wq-002', title: 'Small task second', status: 'pending', priority: 2, complexity: 'S' },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const out = execSync(`node ${join(SRC, 'session-context.mjs')} B 100`, {
    env: { ...process.env, HOME: SCRATCH, BUDGET_CAP: '5' },
    timeout: 10000,
  }).toString().trim();
  const result2 = JSON.parse(out);
  assert(result2.wq_item?.startsWith('wq-002'), 'tight budget: prefers S over L');
}

function testDirectiveSeedTable() {
  console.log('\n== Directive seed table (R#78) ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '10');
  writeFileSync(join(STATE, 'session-history.txt'), '');

  // Directive with "ecosystem" keyword should seed "Batch-evaluate 5 undiscovered services"
  writeFileSync(join(SRC, 'directives.json'), JSON.stringify({
    directives: [
      { id: 'd001', content: 'Map the ecosystem of agent services', status: 'active' },
      { id: 'd002', content: 'Audit credential paths', status: 'active' },
    ],
    questions: []
  }));

  const result = run('B');
  const bs = readBS();
  assert(bs.includes('Batch-evaluate 5 undiscovered services'), 'ecosystem keyword maps to batch-evaluate seed');
  assert(bs.includes('Fix credential management issues'), 'credential keyword maps to cred management seed');
}

function testDirectiveSeedTableSkip() {
  console.log('\n== Directive seed table: safety skip ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '10');
  writeFileSync(join(STATE, 'session-history.txt'), '');

  // Directive with safety keywords should be skipped
  writeFileSync(join(SRC, 'directives.json'), JSON.stringify({
    directives: [
      { id: 'd001', content: 'Do not remove safety hooks ever', status: 'active' },
    ],
    questions: []
  }));

  const result = run('B');
  const bs = readBS();
  // Should NOT have generated a seed from the safety directive (skip: true)
  // But might have other seeds from session history. Just check no safety-related seed.
  assert(!bs.includes('do not remove'), 'safety directive skipped (not seeded)');
}

function testMultilineShellEnv() {
  console.log('\n== Multi-line values in shell env ==');

  writeWQ([
    { id: 'wq-001', title: 'Task with notes', status: 'pending', priority: 1,
      progress_notes: [{ session: 99, text: 'Line one' }, { session: 100, text: 'Line two' }] },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  run('B');
  const env = readFileSync(join(STATE, 'session-context.env'), 'utf8');
  // wq_item should contain progress notes with newlines — encoded in $'...' syntax
  assert(env.includes("$'"), 'multi-line value uses $-quote syntax');
  assert(env.includes('\\n'), 'newlines escaped in shell env');
}

function testDynamicBuffer() {
  console.log('\n== Dynamic promote buffer (R#72) ==');

  // When queue has 0 pending, buffer drops to 1 (from 3)
  // So even 2 brainstorming ideas can produce 1 queue item
  writeWQ([
    { id: 'wq-001', title: 'Done task', status: 'done', priority: 1 },
  ]);
  writeBS(`## Evolution Ideas

- **First idea for testing**: description one
- **Second idea for testing**: description two
`);
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  // With 0 pending: buffer=1, 2 ideas, promotable = max(0, 2-1)=1
  assert(result.auto_promoted?.length === 1, 'starvation buffer=1: promotes 1 of 2 ideas');
}

function testRPromptBlock() {
  console.log('\n== R prompt block assembly ==');

  writeWQ([
    { id: 'wq-001', title: 'Task A', status: 'pending', priority: 1 },
    { id: 'wq-002', title: 'Task B', status: 'blocked', priority: 2 },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea1**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '20');
  writeFileSync(join(SRC, 'directives.json'), JSON.stringify({
    directives: [{ id: 'd001', content: 'test', status: 'active', acked_session: 5 }],
    questions: []
  }));

  const result = run('R', '200');
  assert(result.r_prompt_block?.includes('## R Session: #21'), 'R counter incremented for R mode');
  assert(result.r_prompt_block?.includes('pending'), 'prompt block has queue stats');
  assert(result.r_prompt_block?.includes('1 blocked'), 'prompt block has blocked count');
  assert(result.r_prompt_block?.includes('no-op:all-acked'), 'intake shows all-acked');
}

function testESessionEvalTarget() {
  console.log('\n== E session eval target ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '10');

  writeFileSync(join(SRC, 'services.json'), JSON.stringify([
    { name: 'TestService', url: 'https://example.com', status: 'discovered', description: 'A test service' },
    { name: 'EvalDone', url: 'https://done.com', status: 'evaluated' },
  ]));

  const result = run('E', '100');
  assert(result.eval_target?.includes('TestService'), 'eval_target picks discovered service');
  assert(!result.eval_target?.includes('EvalDone'), 'eval_target skips evaluated services');
}

// ===== AUDIT REPORT TESTS (wq-062) =====
// Tests for A session context which reads audit-report.json

function testASessionPromptBlock() {
  console.log('\n== A session prompt block assembly ==');

  writeWQ([
    { id: 'wq-001', title: 'Fix bug', status: 'pending', priority: 1, tags: ['audit'] },
    { id: 'wq-002', title: 'Add feature', status: 'done', priority: 2, tags: ['audit'] },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'a_session_counter'), '10');

  // Write audit report with critical issues
  writeFileSync(join(SRC, 'audit-report.json'), JSON.stringify({
    session: 700,
    critical_issues: [
      { id: 'issue-1', severity: 'HIGH', description: 'Intel tracking broken' },
      { id: 'issue-2', severity: 'MEDIUM', description: 'Stale queue items' },
    ],
    recommended_actions: [
      { title: 'Fix intel', priority: 'high' },
      { title: 'Clean queue', priority: 'low' },
      { title: 'Update docs', priority: 'low' },
    ],
  }));

  const result = run('A', '750');
  assert(result.a_prompt_block?.includes('## A Session: #11'), 'A counter incremented for A mode');
  assert(result.a_prompt_block?.includes('Previous audit: s700'), 'prompt block has previous session');
  assert(result.a_prompt_block?.includes('2 critical issues'), 'prompt block has critical count');
  assert(result.a_prompt_block?.includes('3 recommendations'), 'prompt block has recommendation count');
  assert(result.a_prompt_block?.includes('Intel tracking broken'), 'prompt block lists critical issues');
  assert(result.a_prompt_block?.includes('1 pending, 1 done'), 'prompt block has audit-tagged queue stats');
}

function testASessionNoPreviousReport() {
  console.log('\n== A session: no previous audit report ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  // No a_session_counter = first A session
  try { rmSync(join(STATE, 'a_session_counter')); } catch {}

  // Ensure no audit-report.json file from previous tests
  try { rmSync(join(SRC, 'audit-report.json')); } catch {}

  const result = run('A', '100');
  assert(result.a_prompt_block?.includes('## A Session: #1'), 'first A session counter');
  assert(result.a_prompt_block?.includes('No previous audit report found'), 'handles missing audit report');
}

function testASessionCriticalIssueFormats() {
  console.log('\n== A session: critical issue format variations ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'a_session_counter'), '5');

  // Test with mixed issue formats: string and object
  writeFileSync(join(SRC, 'audit-report.json'), JSON.stringify({
    session: 650,
    critical_issues: [
      'Simple string issue',
      { id: 'obj-1', severity: 'HIGH', description: 'Object with description' },
      { id: 'obj-2', severity: 'LOW' },  // Object without description
    ],
    recommended_actions: [],
  }));

  const result = run('A', '700');
  assert(result.a_prompt_block?.includes('3 critical issues'), 'counts all issue formats');
  assert(result.a_prompt_block?.includes('Simple string issue'), 'string issues included');
  assert(result.a_prompt_block?.includes('Object with description'), 'object.description used');
  assert(result.a_prompt_block?.includes('obj-2'), 'object.id used as fallback when no description');
}

function testASessionCostTrend() {
  console.log('\n== A session: cost trend from history ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'a_session_counter'), '10');
  writeFileSync(join(SRC, 'audit-report.json'), JSON.stringify({ session: 100, critical_issues: [], recommended_actions: [] }));

  // Create session history with increasing costs (should show "increasing" trend)
  const histLines = [];
  for (let i = 0; i < 10; i++) {
    const cost = 1.0 + i * 0.5;  // 1.0, 1.5, 2.0, ... up to 5.5
    histLines.push(`2026-02-02 mode=B s=${100+i} dur=3m cost=$${cost.toFixed(2)} build=1 commit(s) files=[api.mjs] note: test`);
  }
  writeFileSync(join(STATE, 'session-history.txt'), histLines.join('\n') + '\n');

  const result = run('A', '200');
  assert(result.a_prompt_block?.includes('Cost trend'), 'has cost trend line');
  // Recent 5 avg: (3.0+3.5+4.0+4.5+5.0)/5 = 4.0; prev 5 avg: (1.0+1.5+2.0+2.5+3.0)/5 = 2.0
  // 4.0 > 2.0*1.2 = 2.4 → increasing
  assert(result.a_prompt_block?.includes('increasing'), 'detects increasing cost trend');
}

function testASessionMalformedReport() {
  console.log('\n== A session: malformed audit-report.json ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'a_session_counter'), '5');

  // Write invalid JSON
  writeFileSync(join(SRC, 'audit-report.json'), '{ broken json }}}');

  const result = run('A', '100');
  // Should not crash, should fall back to "No previous audit report"
  assert(result.a_prompt_block?.includes('No previous audit report'), 'handles malformed JSON gracefully');
  assert(result.a_prompt_block?.includes('## A Session'), 'still produces valid A prompt block');
}

function testASessionCriticalIssuesTruncation() {
  console.log('\n== A session: critical issues truncation ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'a_session_counter'), '5');

  // Write 5 critical issues (should truncate to 3 with "...")
  writeFileSync(join(SRC, 'audit-report.json'), JSON.stringify({
    session: 500,
    critical_issues: [
      { description: 'Issue one' },
      { description: 'Issue two' },
      { description: 'Issue three' },
      { description: 'Issue four' },
      { description: 'Issue five' },
    ],
    recommended_actions: [],
  }));

  const result = run('A', '600');
  assert(result.a_prompt_block?.includes('5 critical issues'), 'counts all 5 issues');
  assert(result.a_prompt_block?.includes('Issue one'), 'first issue shown');
  assert(result.a_prompt_block?.includes('Issue three'), 'third issue shown');
  assert(!result.a_prompt_block?.includes('Issue four'), 'fourth issue not shown (truncated)');
  assert(result.a_prompt_block?.includes('...'), 'shows ellipsis for truncation');
}

// ===== INTEGRATION TESTS (wq-016) =====
// These test real file I/O edge cases: malformed JSON, missing files,
// empty files, extra fields, and full pipeline chaining.

function intTestMalformedJSON() {
  console.log('\n== Integration: malformed JSON in work-queue.json ==');

  // Write invalid JSON — session-context should not crash
  writeFileSync(join(SRC, 'work-queue.json'), '{ broken json !!!');
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  // readJSON returns null for malformed JSON, so queue starts as [].
  // Auto-promote may fire (pending < 3) and add items from brainstorming.
  assert(typeof result.pending_count === 'number', 'malformed wq: pending_count is a number');
  assert(typeof result === 'object', 'malformed wq: still produces valid output');
  // Key property: does not crash, env file still written
  assert(existsSync(join(STATE, 'session-context.env')), 'malformed wq: env file created');
}

function intTestMissingStateFiles() {
  console.log('\n== Integration: missing state files entirely ==');

  // Only write work-queue.json — no engagement-state.json, no session-history, no intel
  writeWQ([
    { id: 'wq-001', title: 'Lonely task', status: 'pending', priority: 1 },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  // Deliberately do NOT create engagement-state.json

  const result = run('B');
  assert(result.estate_session === 0, 'missing estate: defaults to 0');
  assert(result.wq_item?.startsWith('wq-001'), 'missing estate: task still assigned');
  assert(result.intel_count === 0, 'missing intel: defaults to 0');
  assert(existsSync(join(STATE, 'session-context.env')), 'env file still written');
}

function intTestEmptyWorkQueue() {
  console.log('\n== Integration: empty/zero-byte work-queue.json ==');

  writeFileSync(join(SRC, 'work-queue.json'), '');
  writeBS('## Evolution Ideas\n\n- **Seed idea one**: first\n- **Seed idea two**: second\n- **Seed idea three**: third\n- **Seed idea four**: fourth\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  assert(result.pending_count === 0 || result.pending_count > 0, 'empty wq: does not crash');
  assert(typeof result === 'object', 'empty wq: produces valid output');
}

function intTestExtraFieldsPreserved() {
  console.log('\n== Integration: extra/unknown fields in queue items preserved ==');

  writeWQ([
    { id: 'wq-001', title: 'Task with extras', status: 'pending', priority: 1,
      custom_field: 'should survive', metadata: { foo: 'bar' } },
    { id: 'wq-002', title: 'Task with extras too', status: 'done', priority: 2,
      custom_field: 'also survives' },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  const wq = readWQ();
  const item = wq.queue.find(i => i.id === 'wq-001');
  assert(item?.custom_field === 'should survive', 'custom string field preserved');
  assert(item?.metadata?.foo === 'bar', 'nested custom object preserved');
}

function intTestFullPipelineChain() {
  console.log('\n== Integration: full pipeline — dedup + promote + seed + ingest ==');

  // Set up a scenario where all pipelines fire in one run:
  // - Duplicate items (triggers dedup)
  // - 0 pending after dedup (triggers auto-promote from brainstorming)
  // - Directives exist (may trigger seed if brainstorming empty after promote)
  // - TODO followups exist (triggers ingest)
  writeWQ([
    { id: 'wq-001', title: 'Build webhook relay service for events', status: 'pending', priority: 1 },
    { id: 'wq-002', title: 'Build webhook relay service for events too', status: 'pending', priority: 2 },
  ]);
  writeBS(`## Evolution Ideas

- **Create agent monitor**: Ping agents periodically
- **Add metrics endpoint**: Expose Prometheus metrics
- **Build log viewer**: Web UI for session logs
- **Add backup script**: Auto-backup config files
`);
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'todo-followups.txt'), '- TODO: Add timeout handling to webhook relay\n');
  writeFileSync(join(SRC, 'directives.json'), JSON.stringify({
    directives: [{ id: 'd001', content: 'explore ecosystem', status: 'active' }],
    questions: []
  }));

  const result = run('B');

  // Dedup should have fired
  assert(Array.isArray(result.deduped), 'pipeline: dedup ran');
  assert(result.deduped?.length === 1, 'pipeline: 1 duplicate removed');

  // After dedup, only 1 pending item remains, so auto-promote should fire (pending < 3)
  assert(result.auto_promoted?.length >= 1 || result.pending_count >= 1, 'pipeline: promote or pending available');

  // TODO ingest should have fired
  assert(result.todo_ingested?.length === 1, 'pipeline: 1 TODO ingested');

  // Final queue should have items from all sources
  const wq = readWQ();
  const sources = new Set(wq.queue.map(i => i.source).filter(Boolean));
  assert(wq.queue.length >= 3, 'pipeline: queue has items from multiple sources');

  // Env file should reflect final state
  const env = readFileSync(join(STATE, 'session-context.env'), 'utf8');
  assert(env.includes('CTX_PENDING_COUNT='), 'pipeline: env file has final pending count');
}

// ===== AUTO-PROMOTE THRESHOLD TESTS (wq-017) =====
// Verify promotion counts for each pending-count scenario.
// The buffer logic: BS_BUFFER = max(1, currentPending), promotable = fresh - BS_BUFFER,
// capped at 3 - currentPending. These tests use 5 fresh ideas to exercise the cap.

function cleanState() {
  // Remove stale files from previous tests that setup() doesn't clear
  for (const f of ['todo-followups.txt', 'session-history.txt', 'engagement-intel.json', 'engagement-intel-archive.json', 'r_session_counter', 'a_session_counter']) {
    try { rmSync(join(STATE, f)); } catch {}
  }
  for (const f of ['directives.json', 'services.json', 'audit-report.json']) {
    try { rmSync(join(SRC, f)); } catch {}
  }
}

function makeFreshBS(count) {
  const lines = [];
  for (let i = 1; i <= count; i++) {
    lines.push(`- **Unique threshold idea ${i} session ${Date.now()}**: description ${i}`);
  }
  return `## Evolution Ideas\n\n${lines.join('\n')}\n`;
}

// wq-393: Titles must be semantically distinct to avoid keyword-overlap dedup (B#340).
// Previous version used "Existing pending task N" which shared 100% keywords.
const DISTINCT_TITLES = [
  'Fix authentication middleware bug',
  'Build notification aggregator service',
  'Optimize database query performance',
  'Create webhook relay handler',
  'Implement session caching layer',
];
function makePendingItems(count) {
  const items = [];
  for (let i = 0; i < count && i < DISTINCT_TITLES.length; i++) {
    items.push({ id: `wq-${String(i + 1).padStart(3, '0')}`, title: DISTINCT_TITLES[i], status: 'pending', priority: i + 1 });
  }
  return items;
}

function intTestAutoPromote0Pending() {
  console.log('\n== Auto-promote threshold: 0 pending, 5 fresh ideas ==');

  cleanState();
  writeWQ([]);
  writeBS(makeFreshBS(5));
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  // 0 pending → deficit=3, buffer=max(1,0)=1, promotable=5-1=4, cap=3-0=3 → 3 promoted
  assert(result.auto_promoted?.length === 3, `0 pending: expected 3 promoted, got ${result.auto_promoted?.length}`);
  assert(result.pending_count === 3, `0 pending: final pending_count should be 3, got ${result.pending_count}`);

  // At least 2 original ideas remain (5 - 3 promoted); auto-seed may add more
  const bs = readBS();
  const remaining = (bs.match(/^- \*\*/gm) || []).length;
  assert(remaining >= 2, `0 pending: at least 2 ideas should remain in brainstorming, got ${remaining}`);
}

function intTestAutoPromote1Pending() {
  console.log('\n== Auto-promote threshold: 1 pending, 5 fresh ideas ==');

  cleanState();
  writeWQ(makePendingItems(1));
  writeBS(makeFreshBS(5));
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  // 1 pending → deficit=2, buffer=max(1,1)=1, promotable=5-1=4, cap=3-1=2 → 2 promoted
  assert(result.auto_promoted?.length === 2, `1 pending: expected 2 promoted, got ${result.auto_promoted?.length}`);
  assert(result.pending_count === 3, `1 pending: final pending_count should be 3, got ${result.pending_count}`);
}

function intTestAutoPromote2Pending() {
  console.log('\n== Auto-promote threshold: 2 pending, 5 fresh ideas ==');

  cleanState();
  writeWQ(makePendingItems(2));
  writeBS(makeFreshBS(5));
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  // 2 pending → deficit=1, buffer=max(1,2)=2, promotable=5-2=3, cap=3-2=1 → 1 promoted
  assert(result.auto_promoted?.length === 1, `2 pending: expected 1 promoted, got ${result.auto_promoted?.length}`);
  assert(result.pending_count === 3, `2 pending: final pending_count should be 3, got ${result.pending_count}`);
}

function intTestAutoPromote3Pending() {
  console.log('\n== Auto-promote threshold: 3 pending, 5 fresh ideas ==');

  cleanState();
  writeWQ(makePendingItems(3));
  writeBS(makeFreshBS(5));
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  // 3 pending → currentPending >= 3, auto-promote block skipped entirely
  assert(!result.auto_promoted, `3 pending: no promotion expected, got ${result.auto_promoted?.length || 0}`);
  assert(result.pending_count === 3, `3 pending: pending_count stays 3, got ${result.pending_count}`);
}

function intTestAutoPromoteFewIdeas() {
  console.log('\n== Auto-promote threshold: 0 pending, 2 fresh ideas (starvation) ==');

  cleanState();
  writeWQ([]);
  writeBS(makeFreshBS(2));
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  // 0 pending → buffer=1, promotable=2-1=1, cap=3 → 1 promoted
  assert(result.auto_promoted?.length === 1, `starvation: expected 1 promoted, got ${result.auto_promoted?.length}`);
  assert(result.pending_count === 1, `starvation: pending_count should be 1, got ${result.pending_count}`);

  // At least 1 original idea retained as buffer; auto-seed may add more
  const bs = readBS();
  const remaining = (bs.match(/^- \*\*/gm) || []).length;
  assert(remaining >= 1, `starvation: at least 1 idea retained as buffer, got ${remaining}`);
}

function intTestAutoPromote1IdeaOnly() {
  console.log('\n== Auto-promote threshold: 0 pending, 1 fresh idea ==');

  cleanState();
  writeWQ([]);
  writeBS(makeFreshBS(1));
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  // 0 pending → buffer=1, promotable = 1>1? no → 0 promoted
  assert(!result.auto_promoted || result.auto_promoted.length === 0, `1 idea: no promotion (buffer protects last idea)`);
}

function intTestAutoPromoteRThresholds() {
  console.log('\n== Auto-promote threshold: R session with 1 pending, 4 fresh ideas ==');

  cleanState();
  writeWQ(makePendingItems(1));
  writeBS(makeFreshBS(4));
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '50');

  const result = run('R', '200');
  // Same logic applies in R sessions (R#74)
  // 1 pending → buffer=1, promotable=4-1=3, cap=3-1=2 → 2 promoted
  assert(result.auto_promoted?.length === 2, `R session: expected 2 promoted, got ${result.auto_promoted?.length}`);
  assert(result.pending_count === 3, `R session: final pending_count should be 3, got ${result.pending_count}`);
}

// ===== wq-393: HIGH-RISK PATH TESTS =====
// Tests for 5 critical code paths that had no coverage:
// 1. isTitleDupe keyword overlap (60% threshold)
// 2. Queue self-dedup keyword overlap path
// 3. Intel auto-promotion success path (R session mode)
// 4. EVM balance dashboard parsing
// 5. Platform promotion from services.json to account-registry.json

// --- isTitleDupe keyword overlap tests ---

function testDedupKeywordOverlap() {
  console.log('\n== Dedup: keyword overlap catches semantically-equivalent titles (B#340) ==');

  // Two items with different wording but same meaning — keyword overlap should catch this
  writeWQ([
    { id: 'wq-001', title: 'Add tests for audit-report generation pipeline', status: 'pending', priority: 1 },
    { id: 'wq-002', title: 'Test coverage for audit-report generation logic', status: 'pending', priority: 2 },
    { id: 'wq-003', title: 'Build new notification service from scratch', status: 'pending', priority: 3 },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  assert(Array.isArray(result.deduped), 'keyword dedup: deduped array exists');
  assert(result.deduped?.length === 1, 'keyword dedup: exactly 1 duplicate removed');
  assert(result.deduped?.[0]?.startsWith('wq-002'), 'keyword dedup: later item removed');

  const wq = readWQ();
  assert(wq.queue.find(i => i.id === 'wq-001'), 'keyword dedup: wq-001 kept');
  assert(wq.queue.find(i => i.id === 'wq-003'), 'keyword dedup: unrelated wq-003 kept');
}

function testDedupKeywordOverlapBelowThreshold() {
  console.log('\n== Dedup: keyword overlap below 60% threshold ==');

  // Titles share some words but < 60% overlap — should NOT be deduped
  writeWQ([
    { id: 'wq-001', title: 'Add webhook retry logic for failed deliveries', status: 'pending', priority: 1 },
    { id: 'wq-002', title: 'Add session retry mechanism for timeout errors', status: 'pending', priority: 2 },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  assert(!result.deduped || result.deduped.length === 0, 'below threshold: no dedup when keywords only partially overlap');

  const wq = readWQ();
  // Both original items preserved (auto-promote may add more from brainstorming)
  assert(wq.queue.find(i => i.id === 'wq-001'), 'below threshold: wq-001 preserved');
  assert(wq.queue.find(i => i.id === 'wq-002'), 'below threshold: wq-002 preserved');
}

function testDedupSkipsNonPending() {
  console.log('\n== Dedup: skips non-pending items ==');

  // Done items with matching titles should NOT be deduped
  writeWQ([
    { id: 'wq-001', title: 'Build webhook relay service for events', status: 'done', priority: 1 },
    { id: 'wq-002', title: 'Build webhook relay service for events too', status: 'pending', priority: 2 },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  assert(!result.deduped || result.deduped.length === 0, 'skip non-pending: done item not compared');
}

// --- Intel auto-promotion success path (R session) ---

function testIntelAutoPromoteSuccess() {
  console.log('\n== Intel: auto-promotion success path (R session) ==');

  // R session with qualifying intel entries that should be promoted to queue
  writeWQ([
    { id: 'wq-001', title: 'Existing task', status: 'pending', priority: 1 },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '50');
  writeFileSync(join(SRC, 'directives.json'), JSON.stringify({
    directives: [], questions: []
  }));

  // Intel entries with imperative verbs, no observational patterns, no meta-instructions
  const intel = [
    { session: 900, type: 'integration_target', summary: 'Found chat API with agent support', actionable: 'Build integration component for the new chat platform API' },
    { session: 901, type: 'tool_idea', summary: 'Need structured logging', actionable: 'Create structured JSON logging utility for session traces' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('R', '300');
  assert(Array.isArray(result.intel_promoted), 'R session: intel_promoted array exists');
  assert(result.intel_promoted?.length === 2, `R session: 2 entries promoted, got ${result.intel_promoted?.length}`);

  // Check queue items were actually created
  const wq = readWQ();
  const intelItems = wq.queue.filter(i => i.source === 'intel-auto');
  assert(intelItems.length === 2, 'R session: 2 intel-auto items in queue');
  assert(intelItems[0].title.includes('Build integration'), 'R session: first promoted title correct');
  assert(intelItems[0].tags?.includes('intel'), 'R session: promoted item tagged with intel');
}

function testIntelAutoPromoteCapacityGate() {
  console.log('\n== Intel: auto-promotion capacity gate (>=5 pending) ==');

  // Create 5 pending items with distinct titles — should block intel promotion
  // Titles must be distinct enough to avoid keyword-overlap dedup
  const items = [
    { id: 'wq-001', title: 'Fix authentication middleware bug', status: 'pending', priority: 1 },
    { id: 'wq-002', title: 'Build notification aggregator', status: 'pending', priority: 2 },
    { id: 'wq-003', title: 'Optimize database query performance', status: 'pending', priority: 3 },
    { id: 'wq-004', title: 'Create webhook relay service', status: 'pending', priority: 4 },
    { id: 'wq-005', title: 'Implement session caching layer', status: 'pending', priority: 5 },
  ];
  writeWQ(items);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '50');
  writeFileSync(join(SRC, 'directives.json'), JSON.stringify({ directives: [], questions: [] }));

  const intel = [
    { session: 910, type: 'integration_target', summary: 'Should not promote', actionable: 'Build something that would normally qualify for promotion' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('R', '400');
  assert(!result.intel_promoted || result.intel_promoted.length === 0, 'capacity gate: no promotion when 5+ pending');
}

function testIntelAutoPromoteDedup() {
  console.log('\n== Intel: auto-promotion deduplicates against queue ==');

  writeWQ([
    { id: 'wq-001', title: 'Build integration component for the chat platform', status: 'pending', priority: 1 },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '50');
  writeFileSync(join(SRC, 'directives.json'), JSON.stringify({ directives: [], questions: [] }));

  // Intel with title that overlaps existing queue item
  const intel = [
    { session: 920, type: 'integration_target', summary: 'Chat platform found', actionable: 'Build integration component for the chat platform API endpoint' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('R', '500');
  assert(!result.intel_promoted || result.intel_promoted.length === 0, 'dedup: no promotion when title duplicates existing queue item');
}

function testIntelAutoPromoteMaxTwo() {
  console.log('\n== Intel: auto-promotion max 2 per run ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  writeFileSync(join(STATE, 'r_session_counter'), '50');
  writeFileSync(join(SRC, 'directives.json'), JSON.stringify({ directives: [], questions: [] }));

  // 5 qualifying intel entries with truly distinct titles — should only promote 2
  const intel = [
    { session: 930, type: 'integration_target', summary: 'WebSocket gateway discovered', actionable: 'Build websocket gateway connector for realtime event streaming' },
    { session: 931, type: 'integration_target', summary: 'GraphQL federation found', actionable: 'Create graphql federation adapter for distributed queries' },
    { session: 932, type: 'tool_idea', summary: 'Prometheus exporter needed', actionable: 'Implement prometheus metrics exporter for session monitoring' },
    { session: 933, type: 'pattern', summary: 'Circuit breaker library', actionable: 'Add circuit breaker wrapper around external API calls' },
    { session: 934, type: 'integration_target', summary: 'NATS messaging', actionable: 'Integrate nats messaging protocol for agent coordination' },
  ];
  writeFileSync(join(STATE, 'engagement-intel.json'), JSON.stringify(intel));

  const result = run('R', '600');
  assert(result.intel_promoted?.length === 2, `max 2: got ${result.intel_promoted?.length} promoted`);
}

// --- EVM balance dashboard tests ---

function testEVMBalanceDashboard() {
  console.log('\n== EVM: balance dashboard for onchain tasks ==');

  // Create a queue item tagged with an onchain tag
  writeWQ([
    { id: 'wq-001', title: 'Deploy contract on Base', status: 'pending', priority: 1, tags: ['d044', 'onchain'] },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Create a mock base-swap.mjs that outputs balance info
  writeFileSync(join(SRC, 'base-swap.mjs'), `
if (process.argv[2] === 'balance') {
  console.log('Wallet Balances on Base:');
  console.log('  Address: 0xABCDEF1234567890abcdef1234567890ABCDEF12');
  console.log('  ETH:  0.005000');
  console.log('  USDC: 75.500000');
  console.log('  WETH: 0.001200');
}
`);

  const result = run('B');
  assert(result.evm_balances !== undefined, 'EVM: balances object exists');
  assert(result.evm_balances?.eth === '0.005000', `EVM: ETH parsed correctly, got ${result.evm_balances?.eth}`);
  assert(result.evm_balances?.usdc === '75.50', `EVM: USDC parsed correctly, got ${result.evm_balances?.usdc}`);
  assert(result.evm_balances?.weth === '0.001200', `EVM: WETH parsed correctly, got ${result.evm_balances?.weth}`);
  assert(result.evm_balances?.address === '0xABCDEF1234567890abcdef1234567890ABCDEF12', 'EVM: address parsed');
  assert(result.evm_balance_summary?.includes('ETH:'), 'EVM: summary has ETH');
  assert(result.onchain_items?.includes('wq-001'), 'EVM: onchain items listed');
}

function testEVMBalanceLowGasWarning() {
  console.log('\n== EVM: low gas warning ==');

  writeWQ([
    { id: 'wq-001', title: 'Swap tokens', status: 'pending', priority: 1, tags: ['evm'] },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Mock with very low ETH balance
  writeFileSync(join(SRC, 'base-swap.mjs'), `
if (process.argv[2] === 'balance') {
  console.log('Wallet Balances on Base:');
  console.log('  Address: 0x1234');
  console.log('  ETH:  0.000100');
  console.log('  USDC: 5.000000');
  console.log('  WETH: 0.000000');
}
`);

  const result = run('B');
  assert(result.evm_balance_summary?.includes('LOW GAS'), 'EVM: LOW GAS warning when ETH < 0.0005');
  assert(result.evm_balance_summary?.includes('LOW USDC'), 'EVM: LOW USDC warning when USDC < 10');
}

function testEVMBalanceNoOnchainItems() {
  console.log('\n== EVM: no balance check when no onchain items ==');

  writeWQ([
    { id: 'wq-001', title: 'Regular build task', status: 'pending', priority: 1, tags: [] },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  const result = run('B');
  assert(!result.evm_balances, 'EVM: no balance check when no onchain-tagged items');
  assert(!result.evm_balance_summary, 'EVM: no summary when no onchain items');
}

function testEVMBalanceCommandError() {
  console.log('\n== EVM: handles base-swap.mjs error gracefully ==');

  writeWQ([
    { id: 'wq-001', title: 'Deploy thing', status: 'pending', priority: 1, tags: ['onchain'] },
  ]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // Mock that throws an error
  writeFileSync(join(SRC, 'base-swap.mjs'), `process.exit(1);`);

  const result = run('B');
  assert(result.evm_balance_error !== undefined, 'EVM: error captured when command fails');
  assert(!result.evm_balances, 'EVM: no balances on error');
}

// --- Platform promotion from services.json tests ---

function testPlatformPromotion() {
  console.log('\n== Platform promotion: live services promoted to account-registry ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  mkdirSync(join(STATE, 'logs'), { recursive: true });

  // Services with live entries
  writeFileSync(join(SRC, 'services.json'), JSON.stringify({
    services: [
      { id: 'svc-new', name: 'NewPlatform', url: 'https://new.example.com', liveness: { alive: true } },
      { id: 'svc-dead', name: 'DeadPlatform', url: 'https://dead.example.com', liveness: { alive: false } },
      { id: 'svc-existing', name: 'AlreadyRegistered', url: 'https://existing.com', liveness: { alive: true } },
    ]
  }));

  // Registry already has svc-existing
  writeFileSync(join(SRC, 'account-registry.json'), JSON.stringify({
    accounts: [
      { id: 'svc-existing', platform: 'AlreadyRegistered', status: 'live' },
    ]
  }));

  const result = run('B');
  assert(result.platforms_promoted?.length === 1, `platform promo: 1 new platform promoted, got ${result.platforms_promoted?.length}`);
  assert(result.platforms_promoted?.[0]?.includes('svc-new'), 'platform promo: svc-new promoted');

  // Check registry was updated
  const registry = JSON.parse(readFileSync(join(SRC, 'account-registry.json'), 'utf8'));
  const newEntry = registry.accounts.find(a => a.id === 'svc-new');
  assert(newEntry !== undefined, 'platform promo: svc-new added to registry');
  assert(newEntry?.status === 'needs_probe', 'platform promo: status is needs_probe');
  assert(newEntry?.auth_type === 'unknown', 'platform promo: auth_type is unknown');

  // Dead platform should NOT be in registry
  const deadEntry = registry.accounts.find(a => a.id === 'svc-dead');
  assert(!deadEntry, 'platform promo: dead platform not promoted');
}

function testPlatformPromotionNoServices() {
  console.log('\n== Platform promotion: no services.json ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  // No services.json — should not crash
  try { rmSync(join(SRC, 'services.json')); } catch {}
  writeFileSync(join(SRC, 'account-registry.json'), JSON.stringify({ accounts: [] }));

  const result = run('B');
  assert(!result.platforms_promoted, 'no services: no platform promotions');
  assert(typeof result === 'object', 'no services: still produces valid output');
}

function testPlatformPromotionAllAlreadyRegistered() {
  console.log('\n== Platform promotion: all live services already registered ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');

  writeFileSync(join(SRC, 'services.json'), JSON.stringify({
    services: [
      { id: 'svc-a', name: 'PlatformA', url: 'https://a.com', liveness: { alive: true } },
    ]
  }));

  writeFileSync(join(SRC, 'account-registry.json'), JSON.stringify({
    accounts: [
      { id: 'svc-a', platform: 'PlatformA', status: 'live' },
    ]
  }));

  const result = run('B');
  assert(!result.platforms_promoted, 'all registered: no new promotions');
}

function testPlatformPromotionLogsToFile() {
  console.log('\n== Platform promotion: logs to discovery-promotions.log ==');

  writeWQ([]);
  writeBS('## Evolution Ideas\n\n- **Idea**: d\n- **Idea2**: d\n- **Idea3**: d\n- **Idea4**: d\n');
  writeFileSync(join(STATE, 'engagement-state.json'), '{}');
  mkdirSync(join(STATE, 'logs'), { recursive: true });

  writeFileSync(join(SRC, 'services.json'), JSON.stringify({
    services: [
      { id: 'svc-log-test', name: 'LogTestPlatform', url: 'https://logtest.com', liveness: { alive: true } },
    ]
  }));
  writeFileSync(join(SRC, 'account-registry.json'), JSON.stringify({ accounts: [] }));

  run('B');

  const logPath = join(STATE, 'logs', 'discovery-promotions.log');
  assert(existsSync(logPath), 'promotion log file created');
  const logContent = readFileSync(logPath, 'utf8');
  assert(logContent.includes('svc-log-test'), 'log contains promoted platform ID');
}

// ===== RUN =====

try {
  setup();
  testDedup();
  setup(); testDedupNoFalsePositive();
  setup(); testAutoPromote();
  setup(); testAutoPromoteRSession();
  setup(); testAutoSeed();
  setup(); testAutoSeedHotFiles();
  setup(); testTodoIngest();
  setup(); testTodoIngestFiltersCode();
  setup(); testBFallback();
  setup(); testIntelDigest();
  setup(); testIntelEmpty();
  setup(); testIntelMissingFile();
  setup(); testIntelOriginalFieldsPreserved();
  setup(); testIntelNoteCategory();
  setup(); testIntelActionableThreshold();
  setup(); testIntelCollaborationType();
  setup(); testIntelArchiveAccumulation();
  setup(); testIntelMalformedJSON();
  setup(); testIntelMissingFields();
  setup(); testIntelPatternType();
  // wq-315: Observational language filter tests
  setup(); testIntelImperativeVerbsPass();
  setup(); testIntelObservationalInActionableBlocked();
  setup(); testIntelObservationalInSummaryBlocked();
  setup(); testIntelConcreteTasksPass();
  setup(); testIntelMalformedArchive();
  setup(); testIntelLargeArray();
  // wq-326: Retired intel-auto item filter validation
  setup(); testIntelRetiredItemFilters();
  setup(); testIntelFilterAttachTo();
  setup(); testIntelFilterMetaInstruction();
  setup(); testIntelFilterMonitor();
  setup(); testIntelFilterMapsTo();
  setup(); testIntelFilterEnables();
  setup(); testIntelFilterGradientBinary();
  setup(); testShellEnvOutput();
  setup(); testGetMaxQueueId();
  setup(); testDepsReady();
  setup(); testComplexitySelection();
  setup(); testDirectiveSeedTable();
  setup(); testDirectiveSeedTableSkip();
  setup(); testMultilineShellEnv();
  setup(); testDynamicBuffer();
  setup(); testRPromptBlock();
  setup(); testESessionEvalTarget();
  // Integration tests (wq-016)
  setup(); intTestMalformedJSON();
  setup(); intTestMissingStateFiles();
  setup(); intTestEmptyWorkQueue();
  setup(); intTestExtraFieldsPreserved();
  setup(); intTestFullPipelineChain();
  // Auto-promote threshold tests (wq-017)
  setup(); intTestAutoPromote0Pending();
  setup(); intTestAutoPromote1Pending();
  setup(); intTestAutoPromote2Pending();
  setup(); intTestAutoPromote3Pending();
  setup(); intTestAutoPromoteFewIdeas();
  setup(); intTestAutoPromote1IdeaOnly();
  setup(); intTestAutoPromoteRThresholds();
  // wq-393: High-risk path tests
  // --- isTitleDupe keyword overlap ---
  setup(); testDedupKeywordOverlap();
  setup(); testDedupKeywordOverlapBelowThreshold();
  setup(); testDedupSkipsNonPending();
  // --- Intel auto-promotion success ---
  setup(); testIntelAutoPromoteSuccess();
  setup(); testIntelAutoPromoteCapacityGate();
  setup(); testIntelAutoPromoteDedup();
  setup(); testIntelAutoPromoteMaxTwo();
  // --- EVM balance dashboard ---
  setup(); testEVMBalanceDashboard();
  setup(); testEVMBalanceLowGasWarning();
  setup(); testEVMBalanceNoOnchainItems();
  setup(); testEVMBalanceCommandError();
  // --- Platform promotion ---
  setup(); testPlatformPromotion();
  setup(); testPlatformPromotionNoServices();
  setup(); testPlatformPromotionAllAlreadyRegistered();
  setup(); testPlatformPromotionLogsToFile();
  // Audit report tests (wq-062)
  setup(); testASessionPromptBlock();
  setup(); testASessionNoPreviousReport();
  setup(); testASessionCriticalIssueFormats();
  setup(); testASessionCostTrend();
  setup(); testASessionMalformedReport();
  setup(); testASessionCriticalIssuesTruncation();
} finally {
  cleanup();
}

console.log(`\n== Results: ${passed} passed, ${failed} failed ==`);
process.exit(failed > 0 ? 1 : 0);

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

  // Write TODO followups
  writeFileSync(join(STATE, 'todo-followups.txt'), `- Fix rate limiting on /status endpoint
- Add retry logic for failed webhook deliveries
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
  writeFileSync(join(STATE, 'todo-followups.txt'), '- Add timeout handling to webhook relay\n');
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

function makePendingItems(count) {
  const items = [];
  for (let i = 1; i <= count; i++) {
    items.push({ id: `wq-${String(i).padStart(3, '0')}`, title: `Existing pending task ${i}`, status: 'pending', priority: i });
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
  setup(); testIntelMalformedArchive();
  setup(); testIntelLargeArray();
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

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
  setup(); testShellEnvOutput();
} finally {
  cleanup();
}

console.log(`\n== Results: ${passed} passed, ${failed} failed ==`);
process.exit(failed > 0 ? 1 : 0);

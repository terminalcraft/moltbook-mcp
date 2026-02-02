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
  setup(); testGetMaxQueueId();
  setup(); testDepsReady();
  setup(); testComplexitySelection();
  setup(); testDirectiveSeedTable();
  setup(); testDirectiveSeedTableSkip();
  setup(); testMultilineShellEnv();
  setup(); testDynamicBuffer();
  setup(); testRPromptBlock();
  setup(); testESessionEvalTarget();
} finally {
  cleanup();
}

console.log(`\n== Results: ${passed} passed, ${failed} failed ==`);
process.exit(failed > 0 ? 1 : 0);

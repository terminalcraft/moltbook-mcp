#!/usr/bin/env node
/**
 * Work Queue CLI — structured feature queue for build sessions.
 *
 * Usage:
 *   node work-queue.js next              # Show the next item to work on
 *   node work-queue.js list              # List all queued items
 *   node work-queue.js start [id]        # Mark item as in-progress (default: top item)
 *   node work-queue.js done [id] [hash]  # Mark item as completed with optional commit hash
 *   node work-queue.js add "title" "description" [--tag t1 --tag t2]
 *   node work-queue.js drop [id]         # Remove an item
 *   node work-queue.js status            # Summary stats
 *     --what-if close <id> [id2...]       # Simulate closing item(s), show cumulative before/after health (wq-1058, wq-1074)
 *     --what-if retire <id> [id2...]      # Simulate retiring item(s), show cumulative before/after health (wq-1065, wq-1070)
 *     --what-if mixed <id> close|retire [<id> close|retire ...]  # Simulate mixed operations in one pass (wq-1078)
 *     --what-if save <name> close|retire|mixed <args...>  # Save simulation result as named scenario (wq-1082)
 *     --what-if compare <name1> <name2>   # Compare two saved scenarios side-by-side (wq-1082)
 *     --what-if scenarios                 # List saved scenarios (wq-1082)
 *   node work-queue.js velocity          # Show completion velocity stats (wq-200)
 *   node work-queue.js retire [id] [reason]  # Retire item with reason (wq-199)
 *   node work-queue.js retirement-stats      # Show retirement reason breakdown
 *   node work-queue.js close [id] [--flags]  # Combined close-out: done + health + pipeline + pattern (wq-1050)
 *     --dry-run                              # Preview close-out without marking done (wq-1054)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, "work-queue.json");
const SCENARIOS_DIR = join(__dirname, "scenarios");

function load() {
  return JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
}

// wq-1044: Normalize outcome.session to plain integer on every write.
// Handles formats like "s2100", "B#658 (s2063)", "B#659-s2059", or already-integer.
// "B#685" (type counter only, no global session) is left as-is — can't recover correct value.
function normalizeOutcomeSession(val) {
  if (val == null) return undefined;
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    // Prefer sNNNN pattern (global session number)
    const sMatch = val.match(/s(\d+)/i);
    if (sMatch) return parseInt(sMatch[1], 10);
    // Pure numeric string → integer
    if (/^\d+$/.test(val.trim())) return parseInt(val.trim(), 10);
  }
  return val; // fallback: leave as-is if unparseable (e.g. "B#685" without session ref)
}

function save(data) {
  // Normalize outcome.session on all items before writing (wq-1044)
  for (const item of data.queue) {
    if (item.outcome && item.outcome.session !== undefined) {
      const normalized = normalizeOutcomeSession(item.outcome.session);
      if (normalized !== undefined) item.outcome.session = normalized;
    }
  }
  writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2) + "\n");
}

// Canonical status lifecycle: pending → in-progress → done
const VALID_STATUSES = ["pending", "in-progress", "done", "blocked"];

// Complexity scoring: S=small (<$1), M=medium ($1-3), L=large ($3+)
const COMPLEXITY_BUDGET = { S: 1, M: 3, L: 10 };
const VALID_COMPLEXITIES = ["S", "M", "L"];

// Check if all deps of an item are satisfied (status === "done")
function depsReady(item, queue) {
  if (!item.deps || !item.deps.length) return true;
  return item.deps.every(depId => {
    const dep = queue.find(i => i.id === depId);
    return !dep || dep.status === "done"; // missing = archived = done
  });
}

function nextId(data) {
  const all = data.queue;
  const max = all.reduce((m, i) => {
    const n = parseInt(i.id.replace("wq-", ""), 10);
    return n > m ? n : m;
  }, 0);
  return `wq-${String(max + 1).padStart(3, "0")}`;
}

// Parse global flags
const rawArgs = process.argv.slice(2);
let budgetRemaining = null;
const filteredArgs = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--budget" && rawArgs[i + 1]) {
    budgetRemaining = parseFloat(rawArgs[++i]);
  } else {
    filteredArgs.push(rawArgs[i]);
  }
}
const [cmd, ...args] = filteredArgs;

function fitsbudget(item) {
  if (budgetRemaining === null) return true;
  const c = item.complexity || "M"; // default M
  return COMPLEXITY_BUDGET[c] <= budgetRemaining;
}

// wq-1082: Compute a what-if simulation result as structured data
function computeWhatIf(data, type, simArgs, sessionNum) {
  const result = { type, session: sessionNum, items: [], skipped: [], before: {}, after: {}, health: "", unblocked: [], blocked: [] };

  // Current counts
  const cur = { pending: 0, "in-progress": 0, done: 0, retired: 0, blocked: 0 };
  for (const i of data.queue) if (cur[i.status] !== undefined) cur[i.status]++;
  result.before = { ...cur };

  if (type === "mixed") {
    // Parse id/action pairs
    const ops = [];
    for (let i = 0; i < simArgs.length; i += 2) {
      const id = simArgs[i], action = simArgs[i + 1];
      if (!action || (action !== "close" && action !== "retire")) {
        result.skipped.push({ id, reason: !action ? "missing action" : `invalid action "${action}"` });
        continue;
      }
      ops.push({ id, action });
    }
    const seen = new Set();
    for (const op of ops) {
      if (seen.has(op.id)) { result.skipped.push({ id: op.id, reason: "duplicate" }); continue; }
      seen.add(op.id);
      const item = data.queue.find(i => i.id === op.id);
      if (!item) { result.skipped.push({ id: op.id, reason: "not found" }); continue; }
      if (item.status === "done" || item.status === "retired") {
        result.skipped.push({ id: op.id, reason: `already ${item.status}` }); continue;
      }
      const age = item.created_session ? sessionNum - item.created_session : null;
      result.items.push({ id: item.id, title: item.title, status: item.status, action: op.action, age });
    }
  } else {
    // close or retire — all IDs get the same action
    for (const simId of simArgs) {
      const item = data.queue.find(i => i.id === simId);
      if (!item) { result.skipped.push({ id: simId, reason: "not found" }); continue; }
      if (item.status === "done" || item.status === "retired") {
        result.skipped.push({ id: simId, reason: `already ${item.status}` }); continue;
      }
      const age = item.created_session ? sessionNum - item.created_session : null;
      result.items.push({ id: item.id, title: item.title, status: item.status, action: type, age });
    }
  }

  if (result.items.length === 0) return result;

  // Compute after counts
  const sim = { ...cur };
  const closingIds = new Set(), retiringIds = new Set();
  for (const it of result.items) {
    sim[it.status]--;
    if (it.action === "close") { sim.done++; closingIds.add(it.id); }
    else { sim.retired++; retiringIds.add(it.id); }
  }
  result.after = { ...sim };

  // Health
  const pendingAffected = result.items.filter(i => i.status === "pending").length;
  if (pendingAffected === 0) result.health = "no-impact";
  else if (sim.pending === 0) result.health = "critical";
  else if (sim.pending < 3) result.health = "low";
  else if (sim.pending < 5) result.health = "ok";
  else result.health = "healthy";

  // Unblocked by closes
  if (closingIds.size > 0) {
    result.unblocked = data.queue.filter(i => {
      if (closingIds.has(i.id) || retiringIds.has(i.id)) return false;
      if (i.status !== "pending" || !i.deps?.some(d => closingIds.has(d))) return false;
      return i.deps.every(d => {
        if (closingIds.has(d)) return true;
        const dep = data.queue.find(x => x.id === d);
        return !dep || dep.status === "done";
      });
    }).map(i => ({ id: i.id, title: i.title }));
  }

  // Blocked by retires
  if (retiringIds.size > 0) {
    result.blocked = data.queue.filter(i =>
      i.status !== "done" && i.status !== "retired" &&
      !closingIds.has(i.id) && !retiringIds.has(i.id) &&
      i.deps?.some(d => retiringIds.has(d))
    ).map(i => ({ id: i.id, title: i.title, blockedBy: i.deps.filter(d => retiringIds.has(d)) }));
  }

  return result;
}

// wq-1082: Display a what-if result to console
function displayWhatIf(result) {
  if (result.skipped.length > 0) {
    for (const s of result.skipped) console.log(`Skipping ${s.id}: ${s.reason}`);
  }
  if (result.items.length === 0) { console.log("No valid items to simulate."); return; }

  const isBatch = result.items.length > 1;
  const typeLabel = result.type === "mixed"
    ? `mixed simulation — ${result.items.filter(i => i.action === "close").length} close, ${result.items.filter(i => i.action === "retire").length} retire`
    : `${isBatch ? "batch " : ""}${result.type} ${result.items.length === 1 ? result.items[0].id + " (" + result.items[0].title + ")" : result.items.length + " items"}`;
  console.log(`What-if: ${typeLabel}`);

  if (isBatch || result.type === "mixed") {
    for (const it of result.items) {
      const ageStr = it.age !== null ? ` — ${it.age} sessions old` : "";
      const actionStr = result.type === "mixed" ? `${it.action} — ` : "";
      console.log(`  ${it.id}: ${actionStr}${it.title} [${it.status}]${ageStr}`);
    }
  } else {
    const it = result.items[0];
    const ageStr = it.age !== null ? ` — ${it.age} sessions old` : "";
    // Already shown in header for single items
    if (ageStr) console.log(`  ${ageStr.trim()}`);
  }

  const b = result.before, a = result.after;
  const hasRetired = b.retired > 0 || a.retired > 0;
  const retiredStr = hasRetired ? `, ${b.retired} retired` : "";
  const retiredStrA = hasRetired ? `, ${a.retired} retired` : "";
  console.log(`  Current: ${b.pending} pending, ${b["in-progress"]} in-progress, ${b.done} done${retiredStr}, ${b.blocked} blocked`);
  const afterLabel = result.type === "mixed" ? "After" : result.type === "close" ? "After close" : "After retire";
  console.log(`  ${afterLabel}: ${a.pending} pending, ${a["in-progress"]} in-progress, ${a.done} done${retiredStrA}, ${a.blocked} blocked`);

  // Health
  const healthMsgs = {
    "critical": `  ⚠ CRITICAL: 0 pending after operations — replenish before proceeding`,
    "low": `  ⚠ Queue low after operations: ${a.pending} pending — add items first`,
    "ok": `  • Queue OK after operations: ${a.pending} pending (target ≥5)`,
    "healthy": `  • Queue healthy after operations: ${a.pending} pending`,
    "no-impact": `  • No pending impact`
  };
  console.log(healthMsgs[result.health] || `  • Health: ${result.health}`);

  if (result.unblocked.length > 0) {
    console.log(`  → Unblocks: ${result.unblocked.map(i => `${i.id} (${i.title})`).join(", ")}`);
  }
  if (result.blocked.length > 0) {
    console.log(`  ⚠ Blocks: ${result.blocked.map(i => `${i.id} (needs ${i.blockedBy.join(", ")})`).join("; ")} — retiring won't satisfy their deps`);
  }
}

// wq-1082: Save/load scenarios
function saveScenario(name, result) {
  if (!existsSync(SCENARIOS_DIR)) mkdirSync(SCENARIOS_DIR);
  const scenario = { ...result, name, savedAt: new Date().toISOString() };
  writeFileSync(join(SCENARIOS_DIR, `${name}.json`), JSON.stringify(scenario, null, 2) + "\n");
  return scenario;
}

function loadScenario(name) {
  const path = join(SCENARIOS_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function listScenarios() {
  if (!existsSync(SCENARIOS_DIR)) return [];
  return readdirSync(SCENARIOS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const s = JSON.parse(readFileSync(join(SCENARIOS_DIR, f), "utf8"));
      return { name: s.name, type: s.type, savedAt: s.savedAt, items: s.items?.length || 0, health: s.health };
    });
}

const data = load();

switch (cmd) {
  case "next": {
    const item = data.queue.find(i => i.status === "in-progress") ||
                 data.queue.find(i => i.status === "pending" && depsReady(i, data.queue) && fitsbudget(i));
    if (!item) { console.log("Queue empty."); break; }
    const marker = item.status === "in-progress" ? " [IN PROGRESS]" : "";
    const cx = item.complexity ? ` [${item.complexity}]` : "";
    console.log(`${item.id}: ${item.title}${marker}${cx}`);
    console.log(`  ${item.description}`);
    if (item.deps?.length) console.log(`  deps: ${item.deps.join(", ")}`);
    if (item.tags?.length) console.log(`  tags: ${item.tags.join(", ")}`);
    if (item.progress_notes?.length) {
      console.log(`  progress (${item.progress_notes.length} notes):`);
      for (const n of item.progress_notes.slice(-3)) {
        console.log(`    [s${n.session}] ${n.text}`);
      }
    }
    break;
  }
  case "list": {
    if (!data.queue.length) { console.log("Queue empty."); break; }
    for (const item of data.queue) {
      const s = item.status === "in-progress" ? "▶" : item.status === "done" ? "✓" : item.status === "blocked" ? "✗" : "·";
      const cx = item.complexity ? ` (${item.complexity})` : "";
      console.log(`${s} ${item.id}: ${item.title} [${item.status}]${cx}`);
    }
    break;
  }
  case "start": {
    const id = args[0];
    const item = id ? data.queue.find(i => i.id === id) : data.queue.find(i => i.status === "pending" && depsReady(i, data.queue) && fitsbudget(i));
    if (!item) { console.log("No item found."); break; }
    if (!depsReady(item, data.queue)) {
      const unmet = item.deps.filter(d => { const dep = data.queue.find(i => i.id === d); return !dep || dep.status !== "done"; });
      console.log(`Blocked: ${item.id} has unmet deps: ${unmet.join(", ")}`);
      break;
    }
    item.status = "in-progress";
    item.started = new Date().toISOString().slice(0, 10);
    item.started_session = parseInt(process.env.SESSION_NUM || "0", 10); // wq-200: velocity tracking
    save(data);
    console.log(`Started: ${item.id} — ${item.title}`);
    break;
  }
  case "done": {
    const id = args[0];
    const hash = args[1];
    // Parse --result, --effort, --quality, --note flags for outcome (wq-1044)
    let result = "completed", effort = "moderate", quality = "well-scoped", note = "";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--result" && args[i + 1]) result = args[++i];
      else if (args[i] === "--effort" && args[i + 1]) effort = args[++i];
      else if (args[i] === "--quality" && args[i + 1]) quality = args[++i];
      else if (args[i] === "--note" && args[i + 1]) note = args[++i];
    }
    const item = id ? data.queue.find(i => i.id === id) : data.queue.find(i => i.status === "in-progress");
    if (!item) { console.log("No in-progress item found."); break; }
    const sessionNum = parseInt(process.env.SESSION_NUM || "0", 10);
    item.status = "done";
    item.completed = new Date().toISOString().slice(0, 10);
    item.completed_session = sessionNum; // wq-200: velocity tracking
    if (hash) item.commits = [...(item.commits || []), hash];
    // wq-1044: Always write outcome.session as plain integer
    item.outcome = {
      session: sessionNum,
      result,
      effort,
      quality,
      note: note || `Completed in session ${sessionNum}`
    };
    save(data);
    console.log(`Done: ${item.id} — ${item.title}`);
    break;
  }
  case "add": {
    const [title, description, ...rest] = args;
    if (!title) { console.log("Usage: add \"title\" \"description\" [--tag t1]"); break; }
    const tags = [];
    const deps = [];
    let complexity = undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--tag" && rest[i + 1]) tags.push(rest[++i]);
      else if (rest[i] === "--dep" && rest[i + 1]) deps.push(rest[++i]);
      else if (rest[i] === "--complexity" && rest[i + 1]) {
        const c = rest[++i].toUpperCase();
        if (VALID_COMPLEXITIES.includes(c)) complexity = c;
      }
    }
    const maxPriority = data.queue.reduce((m, i) => Math.max(m, i.priority), 0);
    const item = {
      id: nextId(data),
      title,
      description: description || "",
      priority: maxPriority + 1,
      status: "pending",
      added: new Date().toISOString().slice(0, 10),
      created_session: parseInt(process.env.SESSION_NUM || "0", 10), // wq-200: velocity tracking
      source: "session",
      tags,
      complexity,
      deps: deps.length ? deps : undefined,
      commits: []
    };
    data.queue.push(item);
    save(data);
    console.log(`Added: ${item.id} — ${title}`);
    break;
  }
  case "drop": {
    const id = args[0];
    if (!id) { console.log("Usage: drop <id>"); break; }
    data.queue = data.queue.filter(i => i.id !== id);
    save(data);
    console.log(`Dropped: ${id}`);
    break;
  }
  case "status": {
    // wq-1058, wq-1074, wq-1082: --what-if close/retire/mixed/save/compare/scenarios
    const whatIfIdx = args.indexOf("--what-if");
    if (whatIfIdx !== -1 && args[whatIfIdx + 1]) {
      const whatIfCmd = args[whatIfIdx + 1];
      const sessionNum = parseInt(process.env.SESSION_NUM || "0", 10);

      if (whatIfCmd === "close" && args[whatIfIdx + 2]) {
        const result = computeWhatIf(data, "close", args.slice(whatIfIdx + 2), sessionNum);
        displayWhatIf(result);
        break;
      }

      if (whatIfCmd === "retire" && args[whatIfIdx + 2]) {
        const result = computeWhatIf(data, "retire", args.slice(whatIfIdx + 2), sessionNum);
        displayWhatIf(result);
        break;
      }

      if (whatIfCmd === "mixed" && args[whatIfIdx + 2]) {
        const result = computeWhatIf(data, "mixed", args.slice(whatIfIdx + 2), sessionNum);
        displayWhatIf(result);
        break;
      }

      // wq-1082: Save a named scenario
      if (whatIfCmd === "save" && args[whatIfIdx + 2] && args[whatIfIdx + 3]) {
        const scenarioName = args[whatIfIdx + 2];
        const simType = args[whatIfIdx + 3];
        if (!["close", "retire", "mixed"].includes(simType)) {
          console.log(`Invalid simulation type "${simType}". Use: close, retire, or mixed`);
          break;
        }
        const simArgs = args.slice(whatIfIdx + 4);
        if (simArgs.length === 0) {
          console.log(`Usage: --what-if save <name> <close|retire|mixed> <id> [...]`);
          break;
        }
        const result = computeWhatIf(data, simType, simArgs, sessionNum);
        if (result.items.length === 0) {
          displayWhatIf(result);
          break;
        }
        displayWhatIf(result);
        const scenario = saveScenario(scenarioName, result);
        console.log(`\n  ✓ Saved as scenario "${scenarioName}" (${scenario.savedAt})`);
        break;
      }

      // wq-1082: Compare two saved scenarios
      if (whatIfCmd === "compare" && args[whatIfIdx + 2] && args[whatIfIdx + 3]) {
        const name1 = args[whatIfIdx + 2], name2 = args[whatIfIdx + 3];
        const s1 = loadScenario(name1), s2 = loadScenario(name2);
        if (!s1) { console.log(`Scenario "${name1}" not found.`); break; }
        if (!s2) { console.log(`Scenario "${name2}" not found.`); break; }

        console.log(`Comparing scenarios: "${name1}" vs "${name2}"\n`);

        // Items in each
        console.log(`  "${name1}" (${s1.type}, ${s1.items.length} items): ${s1.items.map(i => i.id).join(", ")}`);
        console.log(`  "${name2}" (${s2.type}, ${s2.items.length} items): ${s2.items.map(i => i.id).join(", ")}`);

        // Overlap
        const ids1 = new Set(s1.items.map(i => i.id));
        const ids2 = new Set(s2.items.map(i => i.id));
        const shared = [...ids1].filter(id => ids2.has(id));
        const only1 = [...ids1].filter(id => !ids2.has(id));
        const only2 = [...ids2].filter(id => !ids1.has(id));
        if (shared.length > 0) console.log(`  Shared: ${shared.join(", ")}`);
        if (only1.length > 0) console.log(`  Only in "${name1}": ${only1.join(", ")}`);
        if (only2.length > 0) console.log(`  Only in "${name2}": ${only2.join(", ")}`);

        // After-state comparison
        console.log(`\n  Queue state after each:`);
        const fields = ["pending", "in-progress", "done", "retired", "blocked"];
        const pad = (s, n) => String(s).padStart(n);
        console.log(`  ${"".padEnd(14)} ${pad(name1, 10)} ${pad(name2, 10)} ${pad("diff", 6)}`);
        for (const f of fields) {
          const v1 = s1.after[f] || 0, v2 = s2.after[f] || 0;
          const diff = v2 - v1;
          const diffStr = diff === 0 ? "—" : (diff > 0 ? `+${diff}` : `${diff}`);
          console.log(`  ${f.padEnd(14)} ${pad(v1, 10)} ${pad(v2, 10)} ${pad(diffStr, 6)}`);
        }

        // Health comparison
        const healthOrder = { critical: 0, low: 1, ok: 2, healthy: 3, "no-impact": 4 };
        const h1 = healthOrder[s1.health] ?? -1, h2 = healthOrder[s2.health] ?? -1;
        console.log(`\n  Health: "${name1}" = ${s1.health}, "${name2}" = ${s2.health}`);
        if (h1 > h2) console.log(`  → "${name1}" leaves healthier queue state`);
        else if (h2 > h1) console.log(`  → "${name2}" leaves healthier queue state`);
        else console.log(`  → Both scenarios have equal health impact`);

        // Unblocked/blocked differences
        const ub1 = new Set((s1.unblocked || []).map(i => i.id));
        const ub2 = new Set((s2.unblocked || []).map(i => i.id));
        if (ub1.size > 0 || ub2.size > 0) {
          const onlyUb1 = [...ub1].filter(id => !ub2.has(id));
          const onlyUb2 = [...ub2].filter(id => !ub1.has(id));
          if (onlyUb1.length > 0) console.log(`  Only "${name1}" unblocks: ${onlyUb1.join(", ")}`);
          if (onlyUb2.length > 0) console.log(`  Only "${name2}" unblocks: ${onlyUb2.join(", ")}`);
        }

        break;
      }

      // wq-1082: List saved scenarios
      if (whatIfCmd === "scenarios") {
        const scenarios = listScenarios();
        if (scenarios.length === 0) { console.log("No saved scenarios."); break; }
        console.log(`Saved scenarios (${scenarios.length}):`);
        for (const s of scenarios) {
          const date = s.savedAt ? s.savedAt.slice(0, 10) : "?";
          console.log(`  ${s.name} — ${s.type}, ${s.items} items, health=${s.health} (${date})`);
        }
        break;
      }
    }

    const pending = data.queue.filter(i => i.status === "pending").length;
    const inProgress = data.queue.filter(i => i.status === "in-progress").length;
    const done = data.queue.filter(i => i.status === "done").length;
    const blocked = data.queue.filter(i => i.status === "blocked").length;
    console.log(`Queue: ${pending} pending, ${inProgress} in-progress, ${done} done, ${blocked} blocked`);
    break;
  }
  case "deps": {
    // Show dependency graph for all items with deps
    const items = data.queue.filter(i => i.deps?.length);
    if (!items.length) { console.log("No items have dependencies."); break; }
    for (const item of items) {
      const ready = depsReady(item, data.queue) ? "✓ ready" : "✗ blocked";
      console.log(`${item.id}: ${item.title} [${ready}]`);
      for (const depId of item.deps) {
        const dep = data.queue.find(i => i.id === depId);
        const st = dep ? dep.status : "missing";
        console.log(`  → ${depId} [${st}]`);
      }
    }
    break;
  }
  case "note": {
    const id = args[0];
    const text = args.slice(1).join(" ");
    if (!id || !text) { console.log("Usage: note <id> <text>"); break; }
    const item = data.queue.find(i => i.id === id);
    if (!item) { console.log(`Item ${id} not found.`); break; }
    if (!item.progress_notes) item.progress_notes = [];
    item.progress_notes.push({
      session: parseInt(process.env.SESSION_NUM || "0", 10),
      timestamp: new Date().toISOString(),
      text
    });
    save(data);
    console.log(`Note added to ${id} (${item.progress_notes.length} total)`);
    break;
  }
  case "retire": {
    // wq-199: Retire an item with a reason for tracking
    // Valid reasons: duplicate, wrong-session-type, non-actionable, superseded, external-block
    const id = args[0];
    const reason = args[1];
    const VALID_REASONS = ["duplicate", "wrong-session-type", "non-actionable", "superseded", "external-block"];
    if (!id || !reason) {
      console.log("Usage: retire <id> <reason>");
      console.log("Reasons: " + VALID_REASONS.join(", "));
      break;
    }
    const item = data.queue.find(i => i.id === id);
    if (!item) { console.log(`Item ${id} not found.`); break; }
    if (!VALID_REASONS.includes(reason)) {
      console.log(`Invalid reason. Use one of: ${VALID_REASONS.join(", ")}`);
      break;
    }
    item.status = "retired";
    item.retirement_reason = reason;
    item.retired_session = parseInt(process.env.SESSION_NUM || "0", 10);
    item.retired_at = new Date().toISOString();
    save(data);
    console.log(`Retired: ${item.id} — ${item.title} (reason: ${reason})`);
    break;
  }
  case "retirement-stats": {
    // wq-199: Show retirement reason breakdown
    const retired = data.queue.filter(i => i.status === "retired" && i.retirement_reason);
    if (retired.length === 0) {
      console.log("No items with retirement reasons. Use 'retire <id> <reason>' to track reasons.");
      break;
    }
    const byReason = {};
    for (const i of retired) {
      byReason[i.retirement_reason] = (byReason[i.retirement_reason] || 0) + 1;
    }
    console.log(`Retirement reasons (${retired.length} items):`);
    const sorted = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
    for (const [reason, count] of sorted) {
      console.log(`  ${reason}: ${count}`);
    }
    break;
  }
  case "archive": {
    // Move done/retired items completed 50+ sessions ago to archive
    const sessionNum = parseInt(process.env.SESSION_NUM || "0", 10);
    const threshold = args[0] !== undefined ? parseInt(args[0], 10) : 50;
    const archivePath = join(__dirname, "work-queue-archive.json");
    let archive = [];
    try {
      const raw = JSON.parse(readFileSync(archivePath, "utf8"));
      archive = Array.isArray(raw) ? raw : (raw.archived || []);
    } catch {}
    const toArchive = data.queue.filter(i =>
      (i.status === "done" || i.status === "retired") &&
      ((i.completed_session && sessionNum - i.completed_session >= threshold) ||
       (i.retired_session && sessionNum - i.retired_session >= threshold))
    );
    if (toArchive.length === 0) { console.log("Nothing to archive."); break; }
    archive.push(...toArchive);
    data.queue = data.queue.filter(i => !toArchive.includes(i));
    save(data);
    writeFileSync(archivePath, JSON.stringify({ archived: archive }, null, 2) + "\n");
    console.log(`Archived ${toArchive.length} items: ${toArchive.map(i => i.id).join(", ")}`);
    break;
  }
  case "velocity": {
    // wq-200: Compute velocity stats — how long items stay pending before completion
    const sessionNum = parseInt(process.env.SESSION_NUM || "0", 10);
    const done = data.queue.filter(i => i.status === "done" && i.created_session && i.completed_session);
    const inProgress = data.queue.filter(i => i.status === "in-progress" && i.created_session);
    const pending = data.queue.filter(i => i.status === "pending" && i.created_session);

    if (done.length === 0 && inProgress.length === 0 && pending.length === 0) {
      console.log("No items with session tracking data. Velocity tracking starts from this session.");
      break;
    }

    // Completed item stats
    if (done.length > 0) {
      const completionTimes = done.map(i => i.completed_session - i.created_session);
      const avgCompletion = completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length;
      const maxCompletion = Math.max(...completionTimes);
      const minCompletion = Math.min(...completionTimes);
      console.log(`Completed items (${done.length}):`);
      console.log(`  Avg time to complete: ${avgCompletion.toFixed(1)} sessions`);
      console.log(`  Range: ${minCompletion}-${maxCompletion} sessions`);

      // Complexity breakdown
      const byComplexity = { S: [], M: [], L: [] };
      for (const i of done) {
        const c = i.complexity || "M";
        if (byComplexity[c]) byComplexity[c].push(i.completed_session - i.created_session);
      }
      for (const [c, times] of Object.entries(byComplexity)) {
        if (times.length > 0) {
          const avg = times.reduce((a, b) => a + b, 0) / times.length;
          console.log(`  ${c}: ${times.length} items, avg ${avg.toFixed(1)} sessions`);
        }
      }
    }

    // In-progress items: how long have they been in-progress?
    if (inProgress.length > 0) {
      console.log(`\nIn-progress items (${inProgress.length}):`);
      for (const i of inProgress) {
        const age = sessionNum - i.created_session;
        const inProgressSince = i.started_session ? sessionNum - i.started_session : "?";
        console.log(`  ${i.id}: created ${age}s ago, in-progress ${inProgressSince}s`);
      }
    }

    // Pending items: how long have they been waiting?
    if (pending.length > 0) {
      const ages = pending.map(i => sessionNum - i.created_session);
      const avgAge = ages.reduce((a, b) => a + b, 0) / ages.length;
      const stale = pending.filter(i => sessionNum - i.created_session > 20);
      console.log(`\nPending items (${pending.length}):`);
      console.log(`  Avg age: ${avgAge.toFixed(1)} sessions`);
      if (stale.length > 0) {
        console.log(`  Stale (>20 sessions): ${stale.length} items`);
        for (const i of stale.slice(0, 5)) {
          console.log(`    ${i.id}: ${sessionNum - i.created_session} sessions old`);
        }
      }
    }
    break;
  }
  case "close": {
    // wq-1050: Combined close-out — done + queue health + pipeline gate + pattern capture prompt
    const closeId = args[0];
    // Parse flags (same as done)
    let closeResult = "completed", closeEffort = "moderate", closeQuality = "well-scoped", closeNote = "";
    let closeHash = null;
    let dryRun = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--result" && args[i + 1]) closeResult = args[++i];
      else if (args[i] === "--effort" && args[i + 1]) closeEffort = args[++i];
      else if (args[i] === "--quality" && args[i + 1]) closeQuality = args[++i];
      else if (args[i] === "--note" && args[i + 1]) closeNote = args[++i];
      else if (args[i] === "--hash" && args[i + 1]) closeHash = args[++i];
      else if (args[i] === "--dry-run") dryRun = true;
    }

    // Step 1: Find item (same logic as done command)
    const closeItem = closeId && !closeId.startsWith("--")
      ? data.queue.find(i => i.id === closeId)
      : data.queue.find(i => i.status === "in-progress");
    if (!closeItem) {
      console.log("No in-progress item found.");
      break;
    }
    const closeSession = parseInt(process.env.SESSION_NUM || "0", 10);

    if (dryRun) {
      console.log(`[DRY RUN] Would close: ${closeItem.id} — ${closeItem.title}`);
      console.log(`  result=${closeResult} effort=${closeEffort} quality=${closeQuality}`);
      if (closeNote) console.log(`  note: ${closeNote}`);
      if (closeHash) console.log(`  commit: ${closeHash}`);
    } else {
      closeItem.status = "done";
      closeItem.completed = new Date().toISOString().slice(0, 10);
      closeItem.completed_session = closeSession;
      if (closeHash) closeItem.commits = [...(closeItem.commits || []), closeHash];
      closeItem.outcome = {
        session: closeSession,
        result: closeResult,
        effort: closeEffort,
        quality: closeQuality,
        note: closeNote || `Completed in session ${closeSession}`
      };
      save(data);
      console.log(`✓ Done: ${closeItem.id} — ${closeItem.title}`);
    }

    // Step 2: Queue health check (simulate post-close count in dry-run)
    const currentPending = data.queue.filter(i => i.status === "pending").length;
    const pendingCount = dryRun && closeItem.status === "pending"
      ? currentPending - 1
      : dryRun ? currentPending : load().queue.filter(i => i.status === "pending").length;
    if (pendingCount === 0) {
      console.log(`⚠ CRITICAL: 0 pending items — replenish immediately`);
    } else if (pendingCount < 3) {
      console.log(`⚠ Queue low: ${pendingCount} pending — consider adding items`);
    } else if (pendingCount < 5) {
      console.log(`• Queue OK: ${pendingCount} pending (target ≥5)`);
    } else {
      console.log(`• Queue healthy: ${pendingCount} pending`);
    }

    // Step 3: Pipeline gate check (BRAINSTORMING.md or work-queue.json modified)
    try {
      const { execSync } = await import("child_process");
      const diffOutput = execSync("git diff --name-only HEAD~3", { cwd: __dirname, encoding: "utf8" });
      const pipelineFiles = ["BRAINSTORMING.md", "work-queue.json"];
      const modified = pipelineFiles.filter(f => diffOutput.includes(f));
      if (modified.length > 0) {
        console.log(`• Pipeline gate: PASS (modified: ${modified.join(", ")})`);
      } else {
        console.log(`⚠ Pipeline gate: FAIL — add a brainstorming idea or queue item before pushing`);
      }
    } catch {
      console.log(`• Pipeline gate: could not check (git not available)`);
    }

    // Step 4: Pattern capture reminder
    console.log(`• Pattern capture: did you learn something non-obvious? Use ctxly_remember or note "Pattern capture: none (routine)"`);
    break;
  }
  default:
    console.log("Usage: work-queue.js <next|list|start|done|add|drop|retire|status|deps|note|archive|velocity|retirement-stats|close>");
}

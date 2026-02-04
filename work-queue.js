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
 *   node work-queue.js velocity          # Show completion velocity stats (wq-200)
 *   node work-queue.js retire [id] [reason]  # Retire item with reason (wq-199)
 *   node work-queue.js retirement-stats      # Show retirement reason breakdown
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = join(__dirname, "work-queue.json");

function load() {
  return JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
}

function save(data) {
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
    const item = id ? data.queue.find(i => i.id === id) : data.queue.find(i => i.status === "in-progress");
    if (!item) { console.log("No in-progress item found."); break; }
    item.status = "done";
    item.completed = new Date().toISOString().slice(0, 10);
    item.completed_session = parseInt(process.env.SESSION_NUM || "0", 10); // wq-200: velocity tracking
    if (hash) item.commits = [...(item.commits || []), hash];
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
  default:
    console.log("Usage: work-queue.js <next|list|start|done|add|drop|retire|status|deps|note|archive|velocity|retirement-stats>");
}

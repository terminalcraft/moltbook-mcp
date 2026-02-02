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

const [cmd, ...args] = process.argv.slice(2);

const data = load();

switch (cmd) {
  case "next": {
    const item = data.queue.find(i => i.status === "in-progress") ||
                 data.queue.find(i => i.status === "pending" && depsReady(i, data.queue));
    if (!item) { console.log("Queue empty."); break; }
    const marker = item.status === "in-progress" ? " [IN PROGRESS]" : "";
    console.log(`${item.id}: ${item.title}${marker}`);
    console.log(`  ${item.description}`);
    if (item.deps?.length) console.log(`  deps: ${item.deps.join(", ")}`);
    if (item.tags?.length) console.log(`  tags: ${item.tags.join(", ")}`);
    break;
  }
  case "list": {
    if (!data.queue.length) { console.log("Queue empty."); break; }
    for (const item of data.queue) {
      const s = item.status === "in-progress" ? "▶" : item.status === "done" ? "✓" : item.status === "blocked" ? "✗" : "·";
      console.log(`${s} ${item.id}: ${item.title} [${item.status}]`);
    }
    break;
  }
  case "start": {
    const id = args[0];
    const item = id ? data.queue.find(i => i.id === id) : data.queue.find(i => i.status === "pending" && depsReady(i, data.queue));
    if (!item) { console.log("No item found."); break; }
    if (!depsReady(item, data.queue)) {
      const unmet = item.deps.filter(d => { const dep = data.queue.find(i => i.id === d); return !dep || dep.status !== "done"; });
      console.log(`Blocked: ${item.id} has unmet deps: ${unmet.join(", ")}`);
      break;
    }
    item.status = "in-progress";
    item.started = new Date().toISOString().slice(0, 10);
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
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--tag" && rest[i + 1]) tags.push(rest[++i]);
      else if (rest[i] === "--dep" && rest[i + 1]) deps.push(rest[++i]);
    }
    const maxPriority = data.queue.reduce((m, i) => Math.max(m, i.priority), 0);
    const item = {
      id: nextId(data),
      title,
      description: description || "",
      priority: maxPriority + 1,
      status: "pending",
      added: new Date().toISOString().slice(0, 10),
      source: "session",
      tags,
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
  default:
    console.log("Usage: work-queue.js <next|list|start|done|add|drop|status|deps>");
}

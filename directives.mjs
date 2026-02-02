#!/usr/bin/env node
/**
 * directives.mjs — Structured human↔agent directive management.
 *
 * Usage:
 *   node directives.mjs list                    # List all directives
 *   node directives.mjs pending                 # Show unacked directives
 *   node directives.mjs ack <id> [session]      # Acknowledge a directive
 *   node directives.mjs complete <id> [session]  # Mark directive completed
 *   node directives.mjs question <id> <text>    # Ask a clarifying question
 *   node directives.mjs answer <qid> <text>     # Answer a question (human)
 *   node directives.mjs json                    # Full JSON output
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, "directives.json");

function load() { return JSON.parse(readFileSync(FILE, "utf8")); }
function save(data) { writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n"); }

const cmd = process.argv[2] || "list";
const args = process.argv.slice(3);

if (cmd === "list" || cmd === "ls") {
  const data = load();
  const filter = args[0]; // optional status filter
  for (const d of data.directives) {
    if (filter && d.status !== filter) continue;
    const icon = d.status === "completed" ? "✓" : d.status === "active" ? "●" : d.status === "in_progress" ? "▶" : "○";
    console.log(`  ${icon} ${d.id} [s${d.session}] ${d.status.padEnd(12)} ${d.content.slice(0, 80)}${d.content.length > 80 ? "…" : ""}`);
    if (d.queue_item) console.log(`    → queue: ${d.queue_item}`);
  }
  // Show pending questions
  if (data.questions?.length) {
    console.log("\nPending questions:");
    for (const q of data.questions) {
      if (q.answered) continue;
      console.log(`  ? ${q.id} [re: ${q.directive_id}] ${q.text}`);
    }
  }

} else if (cmd === "pending") {
  const data = load();
  const unacked = data.directives.filter(d => !d.acked_session && d.from === "human");
  if (unacked.length === 0) {
    console.log("No pending directives.");
  } else {
    for (const d of unacked) {
      console.log(`  ○ ${d.id} [s${d.session}] ${d.content.slice(0, 100)}`);
    }
  }
  const unanswered = (data.questions || []).filter(q => !q.answered && q.from === "agent");
  if (unanswered.length) {
    console.log("\nQuestions awaiting human answer:");
    for (const q of unanswered) {
      console.log(`  ? ${q.id} [re: ${q.directive_id}] ${q.text}`);
    }
  }

} else if (cmd === "ack") {
  const [id, session] = args;
  if (!id) { console.error("Usage: directives.mjs ack <id> [session]"); process.exit(1); }
  const data = load();
  const d = data.directives.find(x => x.id === id);
  if (!d) { console.error(`Not found: ${id}`); process.exit(1); }
  d.acked_session = parseInt(session) || null;
  save(data);
  console.log(`Acked: ${id}`);

} else if (cmd === "complete") {
  const [id, session] = args;
  if (!id) { console.error("Usage: directives.mjs complete <id> [session]"); process.exit(1); }
  const data = load();
  const d = data.directives.find(x => x.id === id);
  if (!d) { console.error(`Not found: ${id}`); process.exit(1); }
  d.status = "completed";
  d.completed_session = parseInt(session) || null;
  save(data);
  console.log(`Completed: ${id}`);

} else if (cmd === "question" || cmd === "ask") {
  const [directiveId, ...textParts] = args;
  const text = textParts.join(" ");
  if (!directiveId || !text) { console.error("Usage: directives.mjs question <directive_id> <text>"); process.exit(1); }
  const data = load();
  if (!data.questions) data.questions = [];
  const qid = `q${String(data.questions.length + 1).padStart(3, "0")}`;
  data.questions.push({ id: qid, directive_id: directiveId, from: "agent", text, asked_at: new Date().toISOString(), answered: false });
  save(data);
  console.log(`Question ${qid} added for ${directiveId}: ${text}`);

} else if (cmd === "answer") {
  const [qid, ...textParts] = args;
  const text = textParts.join(" ");
  if (!qid || !text) { console.error("Usage: directives.mjs answer <qid> <text>"); process.exit(1); }
  const data = load();
  const q = (data.questions || []).find(x => x.id === qid);
  if (!q) { console.error(`Not found: ${qid}`); process.exit(1); }
  q.answered = true;
  q.answer = text;
  q.answered_at = new Date().toISOString();
  save(data);
  console.log(`Answered ${qid}: ${text}`);

} else if (cmd === "add") {
  const [session, ...textParts] = args;
  const text = textParts.join(" ");
  if (!text) { console.error("Usage: directives.mjs add <session> <content>"); process.exit(1); }
  const data = load();
  const maxId = data.directives.reduce((m, d) => Math.max(m, parseInt(d.id.replace("d", "")) || 0), 0);
  const id = `d${String(maxId + 1).padStart(3, "0")}`;
  data.directives.push({ id, from: "human", session: parseInt(session) || null, content: text, status: "pending" });
  save(data);
  console.log(`Added ${id}: ${text.slice(0, 80)}`);

} else if (cmd === "update" || cmd === "set") {
  // Update status and/or notes on a directive
  // Usage: directives.mjs update <id> [--status <s>] [--note <text>] [--queue <wq-id>]
  const id = args[0];
  if (!id) { console.error("Usage: directives.mjs update <id> [--status <s>] [--note <text>] [--queue <wq-id>]"); process.exit(1); }
  const data = load();
  const d = data.directives.find(x => x.id === id);
  if (!d) { console.error(`Not found: ${id}`); process.exit(1); }
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--status" && args[i+1]) { d.status = args[++i]; }
    else if (args[i] === "--note" && args[i+1]) { d.notes = args[++i]; }
    else if (args[i] === "--queue" && args[i+1]) { d.queue_item = args[++i]; }
    else if (args[i] === "--session" && args[i+1]) { d.acked_session = parseInt(args[++i]) || null; }
  }
  d.updated = new Date().toISOString();
  save(data);
  console.log(`Updated ${id}: status=${d.status}, notes=${(d.notes || "").slice(0, 60)}`);

} else if (cmd === "summary") {
  // Quick summary of directive system health
  const data = load();
  const dirs = data.directives || [];
  const qs = data.questions || [];
  const byStatus = {};
  for (const d of dirs) { byStatus[d.status] = (byStatus[d.status] || 0) + 1; }
  console.log("Directives:", dirs.length);
  for (const [s, c] of Object.entries(byStatus)) console.log(`  ${s}: ${c}`);
  const unanswered = qs.filter(q => !q.answered);
  if (unanswered.length) console.log(`Unanswered questions: ${unanswered.length}`);

} else if (cmd === "json") {
  console.log(JSON.stringify(load(), null, 2));

} else {
  console.log("Usage: node directives.mjs [list|pending|ack|complete|update|question|answer|add|summary|json]");
}

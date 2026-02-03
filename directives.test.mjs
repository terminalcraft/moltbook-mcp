#!/usr/bin/env node
/**
 * Tests for directives.mjs CLI
 */
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "directives.mjs");
const REAL_FILE = join(__dirname, "directives.json");
const BACKUP_FILE = join(__dirname, "directives.json.test-backup");

// Test fixture data
const testData = {
  directives: [
    { id: "d001", from: "human", session: 100, content: "Test directive one", status: "pending" },
    { id: "d002", from: "human", session: 101, content: "Test directive two", status: "active", acked_session: 102 },
    { id: "d003", from: "human", session: 103, content: "Test directive three", status: "completed", acked_session: 104, completed_session: 105 },
    { id: "d004", from: "agent", session: 106, content: "Agent-created directive", status: "active" }
  ],
  questions: [
    { id: "q001", directive_id: "d001", from: "agent", text: "What priority?", asked_at: "2026-01-01T00:00:00Z", answered: false },
    { id: "q002", directive_id: "d002", from: "agent", text: "Completed question", asked_at: "2026-01-02T00:00:00Z", answered: true, answer: "High", answered_at: "2026-01-03T00:00:00Z" }
  ]
};

function run(args = "") {
  try {
    return execSync(`node ${CLI} ${args}`, { encoding: "utf8", cwd: __dirname });
  } catch (e) {
    return e.stdout || e.stderr || "";
  }
}

function runWithExit(args = "") {
  try {
    execSync(`node ${CLI} ${args}`, { encoding: "utf8", cwd: __dirname });
    return 0;
  } catch (e) {
    return e.status || 1;
  }
}

function loadData() {
  return JSON.parse(readFileSync(REAL_FILE, "utf8"));
}

function saveData(data) {
  writeFileSync(REAL_FILE, JSON.stringify(data, null, 2) + "\n");
}

describe("directives.mjs CLI", () => {
  let originalData;

  before(() => {
    // Back up real data
    if (existsSync(REAL_FILE)) {
      copyFileSync(REAL_FILE, BACKUP_FILE);
      originalData = readFileSync(REAL_FILE, "utf8");
    }
  });

  after(() => {
    // Restore real data
    if (existsSync(BACKUP_FILE)) {
      copyFileSync(BACKUP_FILE, REAL_FILE);
      unlinkSync(BACKUP_FILE);
    } else if (originalData) {
      writeFileSync(REAL_FILE, originalData);
    }
  });

  beforeEach(() => {
    // Reset to test data before each test
    saveData(JSON.parse(JSON.stringify(testData)));
  });

  describe("list command", () => {
    test("list shows all directives", () => {
      const output = run("list");
      assert.ok(output.includes("d001"), "Should show d001");
      assert.ok(output.includes("d002"), "Should show d002");
      assert.ok(output.includes("d003"), "Should show d003");
      assert.ok(output.includes("d004"), "Should show d004");
    });

    test("list with status filter shows only matching", () => {
      const output = run("list pending");
      assert.ok(output.includes("d001"), "Should show pending d001");
      assert.ok(!output.includes("d002"), "Should not show active d002");
      assert.ok(!output.includes("d003"), "Should not show completed d003");
    });

    test("list shows pending questions", () => {
      const output = run("list");
      assert.ok(output.includes("q001"), "Should show unanswered q001");
      assert.ok(!output.includes("q002"), "Should not show answered q002");
    });

    test("ls is alias for list", () => {
      const output = run("ls");
      assert.ok(output.includes("d001"), "ls should work like list");
    });
  });

  describe("pending command", () => {
    test("pending shows unacked human directives", () => {
      const output = run("pending");
      assert.ok(output.includes("d001"), "Should show unacked d001");
      assert.ok(!output.includes("d002"), "Should not show acked d002");
      assert.ok(!output.includes("d004"), "Should not show agent directive d004");
    });

    test("pending shows unanswered questions from agent", () => {
      const output = run("pending");
      assert.ok(output.includes("q001"), "Should show unanswered q001");
      assert.ok(!output.includes("q002"), "Should not show answered q002");
    });
  });

  describe("ack command", () => {
    test("ack marks directive as acknowledged", () => {
      run("ack d001 200");
      const data = loadData();
      const d = data.directives.find(x => x.id === "d001");
      assert.strictEqual(d.acked_session, 200);
    });

    test("ack with missing id shows error", () => {
      const code = runWithExit("ack");
      assert.strictEqual(code, 1);
    });

    test("ack with invalid id shows error", () => {
      const output = run("ack d999 200");
      assert.ok(output.includes("Not found"), "Should show not found error");
    });
  });

  describe("complete command", () => {
    test("complete marks directive as completed", () => {
      run("complete d001 300");
      const data = loadData();
      const d = data.directives.find(x => x.id === "d001");
      assert.strictEqual(d.status, "completed");
      assert.strictEqual(d.completed_session, 300);
    });

    test("complete with missing id shows error", () => {
      const code = runWithExit("complete");
      assert.strictEqual(code, 1);
    });
  });

  describe("add command", () => {
    test("add creates new directive", () => {
      run("add 400 This is a new test directive");
      const data = loadData();
      const d = data.directives.find(x => x.content === "This is a new test directive");
      assert.ok(d, "Should create new directive");
      assert.strictEqual(d.from, "human");
      assert.strictEqual(d.session, 400);
      assert.strictEqual(d.status, "pending");
    });

    test("add generates unique id", () => {
      run("add 401 First new directive");
      run("add 402 Second new directive");
      const data = loadData();
      const ids = data.directives.map(d => d.id);
      const uniqueIds = new Set(ids);
      assert.strictEqual(ids.length, uniqueIds.size, "All IDs should be unique");
    });
  });

  describe("question command", () => {
    test("question adds new question", () => {
      run("question d002 What is the timeline?");
      const data = loadData();
      const q = data.questions.find(x => x.text === "What is the timeline?");
      assert.ok(q, "Should create question");
      assert.strictEqual(q.directive_id, "d002");
      assert.strictEqual(q.from, "agent");
      assert.strictEqual(q.answered, false);
    });

    test("ask is alias for question", () => {
      run("ask d002 Using alias");
      const data = loadData();
      const q = data.questions.find(x => x.text === "Using alias");
      assert.ok(q, "ask should work like question");
    });
  });

  describe("answer command", () => {
    test("answer marks question as answered", () => {
      run("answer q001 The answer is 42");
      const data = loadData();
      const q = data.questions.find(x => x.id === "q001");
      assert.strictEqual(q.answered, true);
      assert.strictEqual(q.answer, "The answer is 42");
      assert.ok(q.answered_at, "Should have answered_at timestamp");
    });
  });

  describe("update command", () => {
    test("update changes status", () => {
      run("update d001 --status active");
      const data = loadData();
      const d = data.directives.find(x => x.id === "d001");
      assert.strictEqual(d.status, "active");
    });

    test("update adds note", () => {
      run("update d001 --note 'Test note here'");
      const data = loadData();
      const d = data.directives.find(x => x.id === "d001");
      assert.ok(d.notes, "Should have notes");
    });

    test("update adds queue item", () => {
      run("update d001 --queue wq-123");
      const data = loadData();
      const d = data.directives.find(x => x.id === "d001");
      assert.strictEqual(d.queue_item, "wq-123");
    });

    test("set is alias for update", () => {
      run("set d001 --status in_progress");
      const data = loadData();
      const d = data.directives.find(x => x.id === "d001");
      assert.strictEqual(d.status, "in_progress");
    });
  });

  describe("defer command", () => {
    test("defer marks directive as deferred", () => {
      run("defer d001 Blocked on external");
      const data = loadData();
      const d = data.directives.find(x => x.id === "d001");
      assert.strictEqual(d.status, "deferred");
      assert.strictEqual(d.notes, "Blocked on external");
      assert.ok(d.deferred_at, "Should have deferred_at timestamp");
    });

    test("defer without reason still works", () => {
      run("defer d001");
      const data = loadData();
      const d = data.directives.find(x => x.id === "d001");
      assert.strictEqual(d.status, "deferred");
    });
  });

  describe("summary command", () => {
    test("summary shows counts by status", () => {
      const output = run("summary");
      assert.ok(output.includes("Directives:"), "Should show directive count");
      assert.ok(output.includes("pending"), "Should show pending count");
      assert.ok(output.includes("active"), "Should show active count");
    });

    test("summary shows unanswered questions", () => {
      const output = run("summary");
      assert.ok(output.includes("Unanswered questions: 1"), "Should show 1 unanswered");
    });
  });

  describe("json command", () => {
    test("json outputs valid JSON", () => {
      const output = run("json");
      const parsed = JSON.parse(output);
      assert.ok(Array.isArray(parsed.directives), "Should have directives array");
      assert.ok(Array.isArray(parsed.questions), "Should have questions array");
    });
  });

  describe("help / unknown command", () => {
    test("unknown command shows usage", () => {
      const output = run("foobar");
      assert.ok(output.includes("Usage:"), "Should show usage");
    });
  });
});

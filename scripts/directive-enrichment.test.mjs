/**
 * Tests for directive-enrichment.mjs computeEnrichment().
 * Migrated from test_directive_enrichment.py (B#504, d071).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeEnrichment } from "./directive-enrichment.mjs";

// --- Empty / no-match cases ---

describe("computeEnrichment", () => {
  it("empty queue returns empty", () => {
    const result = computeEnrichment({ directives: [] }, { queue: [] });
    assert.deepStrictEqual(result, {});
  });

  it("non-blocked items never appear in enrichment", () => {
    const directives = { directives: [{ id: "d001", queue_item: "wq-100" }] };
    const queue = { queue: [{ id: "wq-100", status: "pending", title: "Some task" }] };
    assert.deepStrictEqual(computeEnrichment(directives, queue), {});
  });

  it("blocked items without matching directive are excluded", () => {
    const directives = { directives: [{ id: "d001", queue_item: "wq-999" }] };
    const queue = { queue: [{ id: "wq-100", status: "blocked", title: "Unrelated task" }] };
    assert.deepStrictEqual(computeEnrichment(directives, queue), {});
  });

  // --- Basic matching via queue_item field ---

  it("matches blocked item by queue_item field", () => {
    const directives = {
      directives: [{
        id: "d010",
        queue_item: "wq-200",
        status: "active",
        notes: "Progress in s1100 and s1150. Continued work on credential rotation flow.",
      }],
    };
    const queue = { queue: [{ id: "wq-200", status: "blocked", title: "Blocked task" }] };
    const result = computeEnrichment(directives, queue);
    assert.ok("wq-200" in result);
    assert.equal(result["wq-200"].directive_id, "d010");
    assert.equal(result["wq-200"].directive_status, "active");
    assert.equal(result["wq-200"].last_activity_session, 1150);
    assert.equal(result["wq-200"].has_recent_notes, true);
  });

  // --- Matching via directive id in title ---

  it("matches blocked item by directive id in title", () => {
    const directives = {
      directives: [{
        id: "d045",
        status: "in-progress",
        notes: "Worked on in s900",
      }],
    };
    const queue = {
      queue: [{ id: "wq-300", status: "blocked", title: "Regenerate credentials (d045)" }],
    };
    const result = computeEnrichment(directives, queue);
    assert.ok("wq-300" in result);
    assert.equal(result["wq-300"].directive_id, "d045");
    assert.equal(result["wq-300"].last_activity_session, 900);
  });

  // --- Session number extraction ---

  it("extracts session numbers from s prefix", () => {
    const directives = {
      directives: [{
        id: "d020",
        queue_item: "wq-400",
        status: "active",
        notes: "Started in s800, continued s850, latest s912",
      }],
    };
    const queue = { queue: [{ id: "wq-400", status: "blocked", title: "Task" }] };
    const result = computeEnrichment(directives, queue);
    assert.equal(result["wq-400"].last_activity_session, 912);
  });

  it("extracts session numbers from R# prefix", () => {
    const directives = {
      directives: [{
        id: "d030",
        queue_item: "wq-500",
        status: "active",
        notes: "Decomposed in R#210, updated R#215",
      }],
    };
    const queue = { queue: [{ id: "wq-500", status: "blocked", title: "Task" }] };
    const result = computeEnrichment(directives, queue);
    assert.equal(result["wq-500"].last_activity_session, 215);
  });

  it("handles mixed s and R# session numbers", () => {
    const directives = {
      directives: [{
        id: "d040",
        queue_item: "wq-600",
        status: "active",
        notes: "From s1000, refined in R#1200",
      }],
    };
    const queue = { queue: [{ id: "wq-600", status: "blocked", title: "Task" }] };
    const result = computeEnrichment(directives, queue);
    assert.equal(result["wq-600"].last_activity_session, 1200);
  });

  it("falls back to acked_session when no session numbers in notes", () => {
    const directives = {
      directives: [{
        id: "d050",
        queue_item: "wq-700",
        status: "active",
        notes: "Short note",
        acked_session: 750,
      }],
    };
    const queue = { queue: [{ id: "wq-700", status: "blocked", title: "Task" }] };
    const result = computeEnrichment(directives, queue);
    assert.equal(result["wq-700"].last_activity_session, 750);
  });

  it("returns 0 when no session numbers and no acked_session", () => {
    const directives = {
      directives: [{
        id: "d060",
        queue_item: "wq-800",
        status: "pending",
        notes: "Brief",
      }],
    };
    const queue = { queue: [{ id: "wq-800", status: "blocked", title: "Task" }] };
    const result = computeEnrichment(directives, queue);
    assert.equal(result["wq-800"].last_activity_session, 0);
  });

  // --- has_recent_notes threshold ---

  it("short notes are not recent", () => {
    const directives = {
      directives: [{
        id: "d070",
        queue_item: "wq-900",
        status: "active",
        notes: "Short",
      }],
    };
    const queue = { queue: [{ id: "wq-900", status: "blocked", title: "Task" }] };
    const result = computeEnrichment(directives, queue);
    assert.equal(result["wq-900"].has_recent_notes, false);
  });

  it("long notes are recent", () => {
    const directives = {
      directives: [{
        id: "d080",
        queue_item: "wq-1000",
        status: "active",
        notes: "A".repeat(51),
      }],
    };
    const queue = { queue: [{ id: "wq-1000", status: "blocked", title: "Task" }] };
    const result = computeEnrichment(directives, queue);
    assert.equal(result["wq-1000"].has_recent_notes, true);
  });

  // --- Edge cases: missing fields ---

  it("handles directive missing notes field", () => {
    const directives = {
      directives: [{
        id: "d090",
        queue_item: "wq-1100",
        status: "active",
      }],
    };
    const queue = { queue: [{ id: "wq-1100", status: "blocked", title: "Task" }] };
    const result = computeEnrichment(directives, queue);
    assert.equal(result["wq-1100"].last_activity_session, 0);
    assert.equal(result["wq-1100"].has_recent_notes, false);
  });

  it("handles directive missing status field", () => {
    const directives = {
      directives: [{
        id: "d100",
        queue_item: "wq-1200",
        notes: "s999 progress",
      }],
    };
    const queue = { queue: [{ id: "wq-1200", status: "blocked", title: "Task" }] };
    const result = computeEnrichment(directives, queue);
    assert.equal(result["wq-1200"].directive_status, null);
    assert.equal(result["wq-1200"].last_activity_session, 999);
  });

  it("handles queue item missing title", () => {
    const directives = { directives: [{ id: "d110", status: "active", notes: "s500" }] };
    const queue = { queue: [{ id: "wq-1300", status: "blocked" }] };
    const result = computeEnrichment(directives, queue);
    assert.deepStrictEqual(result, {});
  });

  it("handles missing directives key", () => {
    const result = computeEnrichment({}, { queue: [{ id: "wq-1", status: "blocked", title: "x" }] });
    assert.deepStrictEqual(result, {});
  });

  it("handles missing queue key", () => {
    const result = computeEnrichment({ directives: [{ id: "d1" }] }, {});
    assert.deepStrictEqual(result, {});
  });

  // --- Multiple items ---

  it("handles multiple blocked items with some matched", () => {
    const directives = {
      directives: [
        { id: "d200", queue_item: "wq-A", status: "active", notes: "s1000" },
        { id: "d201", queue_item: "wq-C", status: "done", notes: "s1100" },
      ],
    };
    const queue = {
      queue: [
        { id: "wq-A", status: "blocked", title: "Task A" },
        { id: "wq-B", status: "blocked", title: "Task B (no directive)" },
        { id: "wq-C", status: "blocked", title: "Task C" },
        { id: "wq-D", status: "pending", title: "Task D (not blocked)" },
      ],
    };
    const result = computeEnrichment(directives, queue);
    assert.deepStrictEqual(new Set(Object.keys(result)), new Set(["wq-A", "wq-C"]));
    assert.equal(result["wq-A"].directive_id, "d200");
    assert.equal(result["wq-C"].directive_id, "d201");
  });
});

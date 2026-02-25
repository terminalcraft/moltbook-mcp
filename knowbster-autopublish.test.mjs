#!/usr/bin/env node
// knowbster-autopublish.test.mjs — Unit tests for knowledge auto-publisher
// Usage: node --test knowbster-autopublish.test.mjs

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  selectPatterns,
  formatForKnowbster,
  loadPublished,
} from "./knowbster-autopublish.mjs";

// Sample patterns for testing
function samplePatterns() {
  return [
    {
      id: "p001",
      source: "self:200-sessions",
      category: "reliability",
      title: "Exponential backoff for failed API actions",
      description: "Queue failed comments/posts with exponential backoff and persist the queue to disk. Prevents data loss when APIs are intermittently down.",
      confidence: "consensus",
      tags: ["state-management", "resilience", "api"],
      validators: [
        { agent: "deadman", at: "2026-02-01T23:01:07Z" },
        { agent: "moltbook", at: "2026-02-02T17:46:12Z" },
      ],
    },
    {
      id: "p002",
      source: "self:200-sessions",
      category: "architecture",
      title: "Stateless session with disk-persisted state",
      description: "Each agent session starts fresh. All memory lives in JSON state files on disk. This makes sessions crash-safe and debuggable.",
      confidence: "verified",
      tags: ["architecture", "state-management", "crash-recovery"],
      validators: [],
    },
    {
      id: "p003",
      source: "self:test",
      category: "tooling",
      title: "Stub pattern",
      description: "Too short",
      confidence: "speculative",
      tags: [],
      validators: [],
    },
    {
      id: "p004",
      source: "github.com/test/repo",
      category: "prompting",
      title: "BRIEFING.md for persistent behavioral directives",
      description: "A standing directives file read at the start of every session. Prevents important behavioral rules from being lost between sessions.",
      confidence: "observed",
      tags: ["prompting", "behavior"],
      validators: [],
    },
    {
      id: "p005",
      source: "self:test",
      category: "security",
      title: "Content sandboxing with markers",
      description: "Defense-in-depth pattern against prompt injection from untrusted social platform content. Uses USER_CONTENT markers to sandbox input at MCP boundary.",
      confidence: "verified",
      tags: ["security", "prompt-injection", "mcp", "defense-in-depth"],
      validators: [],
    },
  ];
}

describe("knowbster-autopublish", () => {
  describe("selectPatterns", () => {
    it("filters by minimum confidence", () => {
      const patterns = samplePatterns();
      const selected = selectPatterns(patterns, {
        minConfidence: "verified",
        excludePublished: false,
      });
      // Should include consensus (p001), verified (p002, p005), exclude speculative (p003) and observed (p004)
      const ids = selected.map(p => p.id);
      assert.ok(ids.includes("p001"), "consensus should pass verified filter");
      assert.ok(ids.includes("p002"), "verified should pass");
      assert.ok(ids.includes("p005"), "verified should pass");
      assert.ok(!ids.includes("p003"), "speculative should be excluded");
      assert.ok(!ids.includes("p004"), "observed should be excluded by verified filter");
    });

    it("filters by category", () => {
      const patterns = samplePatterns();
      const selected = selectPatterns(patterns, {
        category: "security",
        excludePublished: false,
      });
      assert.equal(selected.length, 1);
      assert.equal(selected[0].id, "p005");
    });

    it("filters by specific IDs", () => {
      const patterns = samplePatterns();
      const selected = selectPatterns(patterns, {
        ids: ["p001", "p004"],
        excludePublished: false,
      });
      assert.equal(selected.length, 2);
      assert.deepEqual(selected.map(p => p.id).sort(), ["p001", "p004"]);
    });

    it("excludes short descriptions as stubs", () => {
      const patterns = samplePatterns();
      const selected = selectPatterns(patterns, {
        minConfidence: "speculative",
        excludePublished: false,
      });
      // p003 has description "Too short" (<50 chars) — should be excluded
      assert.ok(!selected.find(p => p.id === "p003"), "stub patterns should be excluded");
    });

    it("defaults to observed minimum confidence", () => {
      const patterns = samplePatterns();
      const selected = selectPatterns(patterns, { excludePublished: false });
      // Should include p001 (consensus), p002 (verified), p004 (observed), p005 (verified)
      // Should exclude p003 (speculative, and also short description)
      assert.equal(selected.length, 4);
    });
  });

  describe("formatForKnowbster", () => {
    it("formats a pattern with all fields", () => {
      const pattern = samplePatterns()[0]; // p001 — consensus, with validators
      const formatted = formatForKnowbster(pattern);

      assert.equal(formatted.patternId, "p001");
      assert.equal(formatted.title, "Exponential backoff for failed API actions");
      assert.equal(formatted.category, "Technology"); // reliability → Technology
      assert.equal(formatted.jurisdiction, "GLOBAL");
      assert.equal(formatted.language, "en");
      assert.ok(formatted.content.includes("# Exponential backoff"), "content should have title header");
      assert.ok(formatted.content.includes("consensus"), "content should mention confidence");
      assert.ok(formatted.content.includes("self:200-sessions"), "content should mention source");
      assert.ok(formatted.content.includes("Validation History"), "should include validators section");
      assert.ok(formatted.content.includes("deadman"), "should list validator agents");
      assert.ok(formatted.content.includes("@moltbook"), "should have publisher attribution");
    });

    it("maps categories correctly", () => {
      const patterns = samplePatterns();
      // reliability → Technology
      assert.equal(formatForKnowbster(patterns[0]).category, "Technology");
      // architecture → Technology
      assert.equal(formatForKnowbster(patterns[1]).category, "Technology");
      // prompting → Education
      assert.equal(formatForKnowbster(patterns[3]).category, "Education");
      // security → Technology
      assert.equal(formatForKnowbster(patterns[4]).category, "Technology");
    });

    it("prices consensus higher than verified", () => {
      const patterns = samplePatterns();
      const consensusPrice = parseFloat(formatForKnowbster(patterns[0]).price); // p001 consensus + 2 validators
      const verifiedPrice = parseFloat(formatForKnowbster(patterns[1]).price); // p002 verified + 0 validators
      assert.ok(consensusPrice > verifiedPrice,
        `consensus (${consensusPrice}) should cost more than verified (${verifiedPrice})`);
    });

    it("prices patterns with validators higher", () => {
      const base = samplePatterns()[1]; // verified, no validators
      const withValidators = { ...base, validators: [{ agent: "a" }, { agent: "b" }] };
      const basePrice = parseFloat(formatForKnowbster(base).price);
      const validatedPrice = parseFloat(formatForKnowbster(withValidators).price);
      assert.ok(validatedPrice > basePrice,
        `validated (${validatedPrice}) should cost more than base (${basePrice})`);
    });

    it("prices patterns with more tags higher", () => {
      const base = { ...samplePatterns()[1], tags: ["a"] };
      const rich = { ...samplePatterns()[1], tags: ["a", "b", "c", "d"] };
      const basePrice = parseFloat(formatForKnowbster(base).price);
      const richPrice = parseFloat(formatForKnowbster(rich).price);
      assert.ok(richPrice > basePrice,
        `rich tags (${richPrice}) should cost more than few tags (${basePrice})`);
    });

    it("truncates long titles to 100 chars", () => {
      const pattern = { ...samplePatterns()[0], title: "A".repeat(200) };
      const formatted = formatForKnowbster(pattern);
      assert.ok(formatted.title.length <= 100, `title should be max 100 chars: ${formatted.title.length}`);
    });

    it("truncates long descriptions to ~500 chars", () => {
      const pattern = { ...samplePatterns()[0], description: "A".repeat(600) };
      const formatted = formatForKnowbster(pattern);
      assert.ok(formatted.description.length <= 500,
        `description should be max ~500 chars: ${formatted.description.length}`);
      assert.ok(formatted.description.endsWith("..."), "truncated description should end with ...");
    });

    it("skips validation section when no validators", () => {
      const pattern = samplePatterns()[1]; // p002, no validators
      const formatted = formatForKnowbster(pattern);
      assert.ok(!formatted.content.includes("Validation History"),
        "should not include empty validation section");
    });
  });

  describe("loadPublished", () => {
    it("returns empty object when no file exists", () => {
      const published = loadPublished();
      assert.equal(typeof published, "object");
    });
  });
});

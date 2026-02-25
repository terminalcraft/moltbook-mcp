import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Test the pure functions (no network calls)
const mod = await import("./den-publish.mjs");
const { formatSessionLearning } = mod;

describe("den-publish", () => {
  describe("formatSessionLearning", () => {
    it("formats basic learning", () => {
      const result = formatSessionLearning("Test Title", "Test description");
      assert.equal(result.title, "Test Title");
      assert.equal(result.content, "Test description");
      assert.ok(result.tags.includes("session-learning"));
    });

    it("appends session number", () => {
      const result = formatSessionLearning("Title", "Desc", { session: "s1500" });
      assert.ok(result.content.includes("s1500"));
    });

    it("appends source", () => {
      const result = formatSessionLearning("Title", "Desc", { source: "self:debug" });
      assert.ok(result.content.includes("self:debug"));
    });

    it("deduplicates tags", () => {
      const result = formatSessionLearning("Title", "Desc", { tags: ["session-learning", "test"] });
      const sessionLearningCount = result.tags.filter(t => t === "session-learning").length;
      assert.equal(sessionLearningCount, 1);
      assert.ok(result.tags.includes("test"));
    });
  });
});

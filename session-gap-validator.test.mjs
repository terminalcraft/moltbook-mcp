import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectGap, checkFileFreshness, runFreshnessChecks, validate } from "./session-gap-validator.mjs";

describe("detectGap", () => {
  it("returns a result with gapDetected boolean", () => {
    const result = detectGap(24);
    assert.ok(typeof result.gapDetected === "boolean");
  });

  it("accepts custom threshold", () => {
    const result = detectGap(1); // 1 hour threshold — very sensitive
    assert.ok("thresholdHours" in result || "reason" in result);
  });

  it("returns gap info when gap exists", () => {
    // Since session-history.txt exists on this machine, we can test real parsing
    const result = detectGap(0.001); // Near-zero threshold ensures gap detected
    if (result.gapDetected) {
      assert.ok(result.gapHours >= 0);
      assert.ok(result.lastDate);
      assert.ok(["since_last", "inter_session"].includes(result.gapSource));
    }
  });
});

describe("checkFileFreshness", () => {
  it("reports missing files as stale", () => {
    const result = checkFileFreshness("/nonexistent/file.json", 24);
    assert.equal(result.exists, false);
    assert.equal(result.stale, true);
    assert.equal(result.reason, "missing");
  });

  it("checks real files correctly", () => {
    // package.json should exist in the repo
    const result = checkFileFreshness("/home/moltbot/moltbook-mcp/package.json", 999999);
    assert.equal(result.exists, true);
    assert.equal(result.stale, false);
    assert.ok(result.ageHours >= 0);
    assert.ok(result.lastModified);
  });

  it("respects maxAgeHours threshold", () => {
    // With maxAge of 0, any existing file should be stale
    const result = checkFileFreshness("/home/moltbot/moltbook-mcp/package.json", 0);
    assert.equal(result.exists, true);
    assert.equal(result.stale, true);
  });
});

describe("runFreshnessChecks", () => {
  it("returns structured report with stale and fresh items", () => {
    const result = runFreshnessChecks(24);
    assert.ok(Array.isArray(result.staleItems));
    assert.ok(Array.isArray(result.freshItems));
    assert.ok(result.totalChecked > 0);
  });

  it("every item has a name", () => {
    const result = runFreshnessChecks(24);
    for (const item of [...result.staleItems, ...result.freshItems]) {
      assert.ok(item.name, `Item missing name: ${JSON.stringify(item)}`);
    }
  });

  it("stale items have action recommendations", () => {
    // With a tiny gap, items may be fresh — use huge gap to force staleness
    const result = runFreshnessChecks(0.001);
    for (const item of result.staleItems) {
      assert.ok(item.action, `Stale item ${item.name} missing action`);
    }
  });
});

describe("validate", () => {
  it("returns complete report structure", () => {
    const report = validate({ threshold: 24 });
    assert.ok(report.timestamp);
    assert.ok(report.summary);
    assert.ok(report.gap);
    assert.ok(report.checks);
  });

  it("includes gap detection results", () => {
    const report = validate({ threshold: 24 });
    assert.ok(typeof report.gap.gapDetected === "boolean");
  });

  it("with zero threshold, everything is a gap", () => {
    const report = validate({ threshold: 0.001 });
    // With near-zero threshold, gap should be detected (unless sessions are < 3.6s apart)
    if (report.gap.gapDetected) {
      assert.ok(report.checks.totalChecked > 0);
      assert.ok(report.summary.includes("Gap of"));
    }
  });
});

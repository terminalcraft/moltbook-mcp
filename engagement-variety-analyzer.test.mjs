import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  extractEngagementCounts,
  mergeEngagementCounts,
  calculateConcentration,
  calculateDistributionHealth,
  getRecommendation,
} from "./engagement-variety-analyzer.mjs";

describe("parseArgs", () => {
  it("returns defaults with no args", () => {
    const opts = parseArgs([]);
    assert.equal(opts.window, 5);
    assert.equal(opts.threshold, 0.6);
    assert.equal(opts.json, false);
    assert.equal(opts.alertFile, false);
  });

  it("parses --window", () => {
    const opts = parseArgs(["--window", "10"]);
    assert.equal(opts.window, 10);
  });

  it("parses --threshold", () => {
    const opts = parseArgs(["--threshold", "0.8"]);
    assert.equal(opts.threshold, 0.8);
  });

  it("parses --json flag", () => {
    const opts = parseArgs(["--json"]);
    assert.equal(opts.json, true);
  });

  it("parses --alert-file flag", () => {
    const opts = parseArgs(["--alert-file"]);
    assert.equal(opts.alertFile, true);
  });

  it("parses all options together", () => {
    const opts = parseArgs(["--window", "3", "--threshold", "0.7", "--json", "--alert-file"]);
    assert.equal(opts.window, 3);
    assert.equal(opts.threshold, 0.7);
    assert.equal(opts.json, true);
    assert.equal(opts.alertFile, true);
  });
});

describe("extractEngagementCounts", () => {
  it("returns empty counts for empty trace", () => {
    const counts = extractEngagementCounts({});
    assert.deepEqual(counts, {});
  });

  it("counts string platforms_engaged entries", () => {
    const counts = extractEngagementCounts({
      platforms_engaged: ["chatr", "moltbook", "chatr"],
    });
    assert.equal(counts.chatr, 2);
    assert.equal(counts.moltbook, 1);
  });

  it("counts object platforms_engaged entries", () => {
    const counts = extractEngagementCounts({
      platforms_engaged: [
        { platform: "Chatr" },
        { platform: "Moltbook" },
      ],
    });
    assert.equal(counts.chatr, 1);
    assert.equal(counts.moltbook, 1);
  });

  it("handles mixed string and object platforms_engaged", () => {
    const counts = extractEngagementCounts({
      platforms_engaged: ["chatr", { platform: "Moltbook" }],
    });
    assert.equal(counts.chatr, 1);
    assert.equal(counts.moltbook, 1);
  });

  it("skips null/invalid entries in platforms_engaged", () => {
    const counts = extractEngagementCounts({
      platforms_engaged: [null, undefined, {}, "chatr"],
    });
    assert.equal(counts.chatr, 1);
    assert.equal(Object.keys(counts).length, 1);
  });

  it("counts threads_contributed by platform", () => {
    const counts = extractEngagementCounts({
      threads_contributed: [
        { platform: "chatr", thread: "t1" },
        { platform: "chatr", thread: "t2" },
        { platform: "4claw", thread: "t3" },
      ],
    });
    assert.equal(counts.chatr, 2);
    assert.equal(counts["4claw"], 1);
  });

  it("merges platforms_engaged and threads_contributed", () => {
    const counts = extractEngagementCounts({
      platforms_engaged: ["chatr"],
      threads_contributed: [{ platform: "chatr", thread: "t1" }],
    });
    assert.equal(counts.chatr, 2);
  });

  it("normalizes platform names to lowercase", () => {
    const counts = extractEngagementCounts({
      platforms_engaged: ["Chatr", "MOLTBOOK"],
      threads_contributed: [{ platform: "4Claw", thread: "t1" }],
    });
    assert.equal(counts.chatr, 1);
    assert.equal(counts.moltbook, 1);
    assert.equal(counts["4claw"], 1);
  });

  it("skips threads without platform field", () => {
    const counts = extractEngagementCounts({
      threads_contributed: [
        { platform: "chatr", thread: "t1" },
        { thread: "t2" }, // no platform
      ],
    });
    assert.equal(counts.chatr, 1);
    assert.equal(Object.keys(counts).length, 1);
  });
});

describe("mergeEngagementCounts", () => {
  it("returns empty for empty sessions", () => {
    const merged = mergeEngagementCounts([]);
    assert.deepEqual(merged, {});
  });

  it("merges counts from multiple sessions", () => {
    const merged = mergeEngagementCounts([
      { platforms_engaged: ["chatr", "moltbook"] },
      { platforms_engaged: ["chatr", "4claw"] },
    ]);
    assert.equal(merged.chatr, 2);
    assert.equal(merged.moltbook, 1);
    assert.equal(merged["4claw"], 1);
  });

  it("handles single session", () => {
    const merged = mergeEngagementCounts([
      { threads_contributed: [{ platform: "chatr", thread: "t1" }] },
    ]);
    assert.equal(merged.chatr, 1);
  });
});

describe("calculateConcentration", () => {
  it("returns zero state for empty counts", () => {
    const result = calculateConcentration({});
    assert.equal(result.total, 0);
    assert.equal(result.topPlatform, null);
    assert.equal(result.topConcentration, 0);
    assert.equal(result.isConcentrated, false);
  });

  it("calculates single-platform concentration at 100%", () => {
    const result = calculateConcentration({ chatr: 5 });
    assert.equal(result.total, 5);
    assert.equal(result.topPlatform, "chatr");
    assert.equal(result.topConcentration, 1);
    assert.equal(result.topConcentrationPct, 100);
  });

  it("calculates even distribution", () => {
    const result = calculateConcentration({ chatr: 2, moltbook: 2, "4claw": 2 });
    assert.equal(result.total, 6);
    assert.equal(result.topConcentrationPct, 33);
  });

  it("calculates uneven distribution", () => {
    const result = calculateConcentration({ chatr: 4, moltbook: 1 });
    assert.equal(result.total, 5);
    assert.equal(result.topPlatform, "chatr");
    assert.equal(result.topConcentrationPct, 80);
  });

  it("includes per-platform percentage and ratio", () => {
    const result = calculateConcentration({ chatr: 3, moltbook: 1 });
    assert.equal(result.platforms.chatr.count, 3);
    assert.equal(result.platforms.chatr.percentage, 75);
    assert.ok(Math.abs(result.platforms.chatr.ratio - 0.75) < 0.001);
    assert.equal(result.platforms.moltbook.count, 1);
    assert.equal(result.platforms.moltbook.percentage, 25);
  });
});

describe("calculateDistributionHealth", () => {
  it("returns healthy for evenly distributed platforms", () => {
    const concentration = calculateConcentration({ a: 2, b: 2, c: 2 });
    const health = calculateDistributionHealth(concentration, 0.6);
    assert.equal(health.isHealthy, true);
    assert.equal(health.isConcentrated, false);
    assert.equal(health.platformCount, 3);
    assert.equal(health.healthScore, 1);
  });

  it("returns concentrated for single-platform dominance", () => {
    const concentration = calculateConcentration({ a: 8, b: 1, c: 1 });
    const health = calculateDistributionHealth(concentration, 0.6);
    assert.equal(health.isHealthy, false);
    assert.equal(health.isConcentrated, true);
    assert.ok(health.healthScore < 0.5);
  });

  it("health score is 1.0 for perfect single-platform (degenerate)", () => {
    // With 1 platform, ideal = 100%, so healthScore = 1
    const concentration = calculateConcentration({ a: 5 });
    const health = calculateDistributionHealth(concentration, 0.6);
    assert.equal(health.healthScore, 1);
    // But it's still concentrated above threshold
    assert.equal(health.isConcentrated, true);
  });

  it("returns zero platformCount for empty distribution", () => {
    const concentration = calculateConcentration({});
    const health = calculateDistributionHealth(concentration, 0.6);
    assert.equal(health.platformCount, 0);
  });
});

describe("getRecommendation", () => {
  it("returns CRITICAL for >80% concentration", () => {
    const concentration = calculateConcentration({ chatr: 9, moltbook: 1 });
    const rec = getRecommendation(concentration, 0.6);
    assert.ok(rec.startsWith("CRITICAL:"));
    assert.ok(rec.includes("chatr"));
  });

  it("returns WARNING for concentration above threshold but <=80%", () => {
    const concentration = calculateConcentration({ chatr: 7, moltbook: 3 });
    const rec = getRecommendation(concentration, 0.6);
    assert.ok(rec.startsWith("WARNING:"));
  });

  it("returns MODERATE for 40-60% range", () => {
    const concentration = calculateConcentration({ chatr: 5, moltbook: 5 });
    const rec = getRecommendation(concentration, 0.6);
    assert.ok(rec.startsWith("MODERATE:") || rec.startsWith("HEALTHY:"));
  });

  it("returns HEALTHY for well-distributed engagement", () => {
    const concentration = calculateConcentration({ a: 3, b: 3, c: 3, d: 1 });
    const rec = getRecommendation(concentration, 0.6);
    assert.ok(rec.startsWith("HEALTHY:"));
  });
});

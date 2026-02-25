import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEffects,
  computeBehaviorHash,
  computeRegistryDelta,
  bucketTiming,
  monitorProbe,
  compareLatest,
} from "./probe-side-effect-monitor.mjs";

// Helper: build mock probe result matching platform-probe.mjs output shape
function mockResult(path, { status = 200, contentType = "json", body = "", isSuccess = true } = {}) {
  return {
    path,
    url: `https://example.com${path}`,
    status,
    contentType,
    bodyPreview: body,
    hasContent: body.length > 0,
    isSuccess,
  };
}

describe("extractEffects", () => {
  it("extracts deterministic fields from probe results", () => {
    const results = [
      mockResult("/health", { body: '{"status":"ok"}' }),
      mockResult("/skill.md", { contentType: "text", body: "# Agent" }),
      mockResult("/api", { status: 404, isSuccess: false }),
    ];
    const effects = extractEffects(results);

    assert.equal(effects.length, 3);
    assert.equal(effects[0].endpoint, "/health");
    assert.equal(effects[0].status, 200);
    assert.equal(effects[0].contentType, "json");
    assert.equal(effects[0].success, true);
    assert.equal(effects[0].bodySize, 15);
    assert.equal(effects[0].bodyPrefix, '{"status":"ok"}');

    assert.equal(effects[2].endpoint, "/api");
    assert.equal(effects[2].success, false);
  });

  it("truncates body prefix to 64 chars", () => {
    const longBody = "x".repeat(200);
    const results = [mockResult("/api", { body: longBody })];
    const effects = extractEffects(results);
    assert.equal(effects[0].bodyPrefix.length, 64);
  });

  it("handles null bodyPreview gracefully", () => {
    const results = [{ path: "/test", url: "http://x/test", status: null, isSuccess: false, contentType: null }];
    const effects = extractEffects(results);
    assert.equal(effects[0].bodySize, 0);
    assert.equal(effects[0].bodyPrefix, "");
  });
});

describe("computeBehaviorHash", () => {
  it("produces consistent hash for same inputs", () => {
    const effects = [
      { endpoint: "/health", status: 200, contentType: "json", success: true, bodySize: 15, bodyPrefix: "ok" },
      { endpoint: "/api", status: 404, contentType: "html", success: false, bodySize: 0, bodyPrefix: "" },
    ];
    const delta = { fieldsChanged: ["last_status", "notes"], statusBefore: "unknown", statusAfter: "live", skillHashChanged: false };

    const hash1 = computeBehaviorHash(effects, delta);
    const hash2 = computeBehaviorHash(effects, delta);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64); // SHA-256 hex
  });

  it("produces different hash when effects change", () => {
    const effects1 = [
      { endpoint: "/health", status: 200, contentType: "json", success: true, bodySize: 15, bodyPrefix: "ok" },
    ];
    const effects2 = [
      { endpoint: "/health", status: 500, contentType: "json", success: false, bodySize: 15, bodyPrefix: "err" },
    ];

    const hash1 = computeBehaviorHash(effects1, null);
    const hash2 = computeBehaviorHash(effects2, null);
    assert.notEqual(hash1, hash2);
  });

  it("is order-independent (sorts effects by endpoint)", () => {
    const effectsA = [
      { endpoint: "/health", status: 200, contentType: "json", success: true, bodySize: 10, bodyPrefix: "" },
      { endpoint: "/api", status: 200, contentType: "json", success: true, bodySize: 50, bodyPrefix: "" },
    ];
    const effectsB = [
      { endpoint: "/api", status: 200, contentType: "json", success: true, bodySize: 50, bodyPrefix: "" },
      { endpoint: "/health", status: 200, contentType: "json", success: true, bodySize: 10, bodyPrefix: "" },
    ];

    const hash1 = computeBehaviorHash(effectsA, null);
    const hash2 = computeBehaviorHash(effectsB, null);
    assert.equal(hash1, hash2);
  });

  it("buckets body size to reduce noise from minor changes", () => {
    const effects1 = [
      { endpoint: "/health", status: 200, contentType: "json", success: true, bodySize: 50, bodyPrefix: "" },
    ];
    const effects2 = [
      { endpoint: "/health", status: 200, contentType: "json", success: true, bodySize: 80, bodyPrefix: "" },
    ];
    // Both are "small" bucket (< 100) → same hash
    const hash1 = computeBehaviorHash(effects1, null);
    const hash2 = computeBehaviorHash(effects2, null);
    assert.equal(hash1, hash2);
  });

  it("different body size buckets produce different hashes", () => {
    const effects1 = [
      { endpoint: "/health", status: 200, contentType: "json", success: true, bodySize: 50, bodyPrefix: "" },
    ];
    const effects2 = [
      { endpoint: "/health", status: 200, contentType: "json", success: true, bodySize: 500, bodyPrefix: "" },
    ];
    // 50 = "small", 500 = "medium" → different hash
    const hash1 = computeBehaviorHash(effects1, null);
    const hash2 = computeBehaviorHash(effects2, null);
    assert.notEqual(hash1, hash2);
  });
});

describe("computeRegistryDelta", () => {
  it("detects field changes between snapshots", () => {
    const before = { id: "test", last_status: "unknown", notes: "old" };
    const after = { id: "test", last_status: "live", notes: "new", skill_hash: "abc123" };
    const delta = computeRegistryDelta(before, after);

    assert.ok(delta.fieldsChanged.includes("last_status"));
    assert.ok(delta.fieldsChanged.includes("notes"));
    assert.ok(delta.fieldsChanged.includes("skill_hash"));
    assert.equal(delta.statusBefore, "unknown");
    assert.equal(delta.statusAfter, "live");
  });

  it("returns null when either snapshot is missing", () => {
    assert.equal(computeRegistryDelta(null, { id: "x" }), null);
    assert.equal(computeRegistryDelta({ id: "x" }, null), null);
  });

  it("detects skill hash changes", () => {
    const before = { id: "test", skill_hash: "aaa" };
    const after = { id: "test", skill_hash: "bbb" };
    const delta = computeRegistryDelta(before, after);
    assert.equal(delta.skillHashChanged, true);
  });

  it("reports no skill hash change when unchanged", () => {
    const before = { id: "test", skill_hash: "same" };
    const after = { id: "test", skill_hash: "same" };
    const delta = computeRegistryDelta(before, after);
    assert.equal(delta.skillHashChanged, false);
  });
});

describe("bucketTiming", () => {
  it("classifies fast (<2s)", () => assert.equal(bucketTiming(500), "fast"));
  it("classifies normal (2-10s)", () => assert.equal(bucketTiming(5000), "normal"));
  it("classifies slow (>10s)", () => assert.equal(bucketTiming(15000), "slow"));
  it("boundary: 2000ms is normal", () => assert.equal(bucketTiming(2000), "normal"));
  it("boundary: 10000ms is slow", () => assert.equal(bucketTiming(10000), "slow"));
});

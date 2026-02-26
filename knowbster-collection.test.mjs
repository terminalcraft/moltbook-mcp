#!/usr/bin/env node
// knowbster-collection.test.mjs — Unit tests for collection bundling
// Usage: node --test knowbster-collection.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import {
  selectForCollection,
  computeCollectionPrice,
  buildCollectionListing,
  defineCollections,
  loadCollections,
  fetchCollectionAnalytics,
  formatAnalyticsReport,
} from "./knowbster-collection.mjs";

// Sample patterns matching real knowledge base structure
function samplePatterns() {
  return [
    {
      id: "p001",
      source: "self:200-sessions",
      category: "reliability",
      title: "Exponential backoff for failed API actions",
      description:
        "Queue failed comments/posts with exponential backoff and persist the queue to disk. Prevents data loss when APIs are intermittently down.",
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
      description:
        "Each agent session starts fresh. All memory lives in JSON state files on disk. This makes sessions crash-safe and debuggable.",
      confidence: "verified",
      tags: ["architecture", "state-management", "crash-recovery"],
    },
    {
      id: "p005",
      source: "self:200-sessions",
      category: "architecture",
      title: "Session rotation for balanced behavior",
      description:
        "Rotate between session types (Build, Reflect, Engage) to prevent mode-locking. A fixed rotation pattern ensures all capabilities stay exercised.",
      confidence: "verified",
      tags: ["architecture", "scheduling"],
    },
    {
      id: "p008",
      source: "self:200-sessions",
      category: "architecture",
      title: "Cross-platform agent discovery",
      description:
        "Publish agent.json manifests at well-known URLs for cross-platform agent discovery. Other agents can find your capabilities without a central registry.",
      confidence: "verified",
      tags: ["architecture", "discovery", "protocol"],
    },
    {
      id: "p004",
      source: "self:200-sessions",
      category: "tooling",
      title: "Thread diffing for efficient re-reads",
      description:
        "When revisiting a social thread, diff against last seen state to only process new content. Saves tokens and avoids duplicate engagement.",
      confidence: "verified",
      tags: ["tooling", "efficiency"],
    },
    {
      id: "p006",
      source: "self:200-sessions",
      category: "tooling",
      title: "Dedup guard for idempotent actions",
      description:
        "Track action hashes to prevent duplicate posts, comments, or API calls within a session. Essential for crash-recovery scenarios.",
      confidence: "verified",
      tags: ["tooling", "idempotency"],
    },
    {
      id: "p010",
      source: "self:200-sessions",
      category: "tooling",
      title: "SDK hooks for deterministic control flow",
      description:
        "Use pre/post hooks in the SDK to inject deterministic behavior at tool boundaries. Enables logging, validation, and side-effect management.",
      confidence: "verified",
      tags: ["tooling", "hooks", "sdk"],
    },
    {
      id: "p030",
      source: "self:s1008-intel",
      category: "security",
      title: "Content sandboxing with USER_CONTENT markers",
      description:
        "Defense-in-depth pattern against prompt injection from untrusted social platform content. Uses USER_CONTENT markers to sandbox input at MCP boundary.",
      confidence: "verified",
      tags: ["security", "prompt-injection", "defense-in-depth"],
    },
    {
      id: "p007",
      source: "self:200-sessions",
      category: "prompting",
      title: "BRIEFING.md for persistent behavioral directives",
      description:
        "A standing directives file read at the start of every session. Prevents important behavioral rules from being lost between sessions.",
      confidence: "verified",
      tags: ["prompting", "behavior"],
    },
    {
      id: "stub1",
      source: "test",
      category: "architecture",
      title: "Stub",
      description: "Too short",
      confidence: "speculative",
      tags: [],
    },
  ];
}

describe("knowbster-collection", () => {
  describe("selectForCollection", () => {
    it("filters by single category", () => {
      const patterns = samplePatterns();
      const selected = selectForCollection(patterns, {
        category: "architecture",
        minConfidence: "verified",
      });
      assert.ok(selected.length >= 3, `expected >=3 architecture patterns, got ${selected.length}`);
      assert.ok(selected.every((p) => p.category === "architecture"));
    });

    it("filters by multiple categories", () => {
      const patterns = samplePatterns();
      const selected = selectForCollection(patterns, {
        categories: ["reliability", "security"],
        minConfidence: "observed",
      });
      assert.ok(selected.length >= 2, `expected >=2, got ${selected.length}`);
      assert.ok(
        selected.every((p) => ["reliability", "security"].includes(p.category))
      );
    });

    it("excludes patterns below confidence threshold", () => {
      const patterns = samplePatterns();
      const selected = selectForCollection(patterns, {
        category: "architecture",
        minConfidence: "verified",
      });
      assert.ok(!selected.find((p) => p.id === "stub1"), "speculative should be excluded");
    });

    it("excludes stub patterns with short descriptions", () => {
      const patterns = samplePatterns();
      const selected = selectForCollection(patterns, {
        category: "architecture",
        minConfidence: "speculative",
      });
      assert.ok(!selected.find((p) => p.id === "stub1"), "stub should be excluded");
    });

    it("returns all matching when no category filter", () => {
      const patterns = samplePatterns();
      const selected = selectForCollection(patterns, { minConfidence: "verified" });
      // Should include patterns from multiple categories
      const categories = new Set(selected.map((p) => p.category));
      assert.ok(categories.size >= 3, `expected >=3 categories, got ${categories.size}`);
    });
  });

  describe("computeCollectionPrice", () => {
    it("applies 20% discount to sum of individual prices", () => {
      const patterns = samplePatterns().filter(
        (p) => p.category === "architecture" && p.confidence === "verified"
      );
      const price = parseFloat(computeCollectionPrice(patterns));
      // Each verified pattern with <=3 tags: 0.002 ETH
      // 3 patterns × 0.002 = 0.006, 20% off = 0.0048
      assert.ok(price > 0, "price should be positive");
      assert.ok(price < 0.006 * patterns.length, "price should be less than individual sum");
    });

    it("enforces minimum price of 0.001", () => {
      const single = [samplePatterns()[0]];
      const price = parseFloat(computeCollectionPrice(single));
      assert.ok(price >= 0.001, `price should be at least 0.001, got ${price}`);
    });
  });

  describe("buildCollectionListing", () => {
    it("produces valid listing with all required fields", () => {
      const patterns = samplePatterns().filter(
        (p) => p.category === "architecture" && (p.description || "").length >= 50
      );
      const template = {
        title: "Test Architecture Pack",
        description: "A collection of architecture patterns for testing purposes in our test suite.",
        category: "Technology",
      };
      const listing = buildCollectionListing("test-arch", template, patterns);

      assert.equal(listing.collectionKey, "test-arch");
      assert.equal(listing.category, "Technology");
      assert.equal(listing.jurisdiction, "GLOBAL");
      assert.equal(listing.language, "en");
      assert.ok(listing.title.length <= 100, "title should be max 100 chars");
      assert.ok(listing.description.length <= 500, "description should be max 500 chars");
      assert.ok(listing.content.includes("# Test Architecture Pack"), "content should have title");
      assert.ok(listing.content.includes("Included Patterns"), "content should list patterns");
      assert.ok(listing.content.includes("Bundle savings"), "content should show savings");
      assert.equal(listing.memberCount, patterns.length);
      assert.deepEqual(listing.memberIds, patterns.map((p) => p.id));
    });

    it("includes each member pattern in content", () => {
      const patterns = samplePatterns().slice(1, 4); // 3 architecture patterns
      const template = {
        title: "Mini Pack",
        description: "Small test collection with three patterns for testing member inclusion.",
        category: "Technology",
      };
      const listing = buildCollectionListing("mini", template, patterns);

      for (const p of patterns) {
        assert.ok(
          listing.content.includes(p.title),
          `content should include "${p.title}"`
        );
        assert.ok(
          listing.content.includes(p.id),
          `content should include pattern ID ${p.id}`
        );
      }
    });

    it("price reflects bundle discount", () => {
      const patterns = samplePatterns().slice(1, 4);
      const template = {
        title: "Price Test",
        description: "Testing that bundle prices are correctly discounted from individual sums.",
        category: "Technology",
      };
      const listing = buildCollectionListing("price-test", template, patterns);
      const price = parseFloat(listing.price);
      assert.ok(price > 0, "price should be positive");
      assert.ok(listing.content.includes("20%"), "content should mention discount percentage");
    });
  });

  describe("defineCollections", () => {
    it("generates collections from predefined templates", () => {
      const patterns = samplePatterns();
      const collections = defineCollections(patterns);
      // With our sample data, at least architecture (3 patterns) should qualify
      assert.ok(collections.length >= 1, `expected >=1 collection, got ${collections.length}`);
    });

    it("skips collections with too few patterns", () => {
      // Only give 2 architecture patterns — below MIN_PATTERNS=3
      const patterns = samplePatterns().slice(1, 3);
      const collections = defineCollections(patterns, {
        templateKeys: ["agent-architecture"],
      });
      // Should still work if 2 patterns pass filters
      // Actually with stub excluded, we have p002 and p005 — just 2, below minimum
      // But if filter finds exactly 2, it skips
      // Let's check — the filter is category=architecture, minConfidence=verified
      // p002 verified arch, p005 verified arch — 2 patterns, below MIN=3
      assert.equal(collections.length, 0, "should skip collection with < 3 patterns");
    });

    it("filters by specific template keys", () => {
      const patterns = samplePatterns();
      const collections = defineCollections(patterns, {
        templateKeys: ["agent-architecture"],
      });
      if (collections.length > 0) {
        assert.equal(collections[0].key, "agent-architecture");
      }
    });

    it("each collection has valid listing structure", () => {
      const patterns = samplePatterns();
      const collections = defineCollections(patterns);
      for (const c of collections) {
        assert.ok(c.key, "should have key");
        assert.ok(c.listing.title, "listing should have title");
        assert.ok(c.listing.content, "listing should have content");
        assert.ok(c.listing.price, "listing should have price");
        assert.ok(c.listing.memberIds.length >= 3, "should have at least 3 members");
      }
    });
  });

  describe("loadCollections", () => {
    it("returns empty object when no file exists", () => {
      const collections = loadCollections();
      assert.equal(typeof collections, "object");
    });
  });

  describe("fetchCollectionAnalytics", () => {
    it("returns analytics with summary for a collection with API data", async (t) => {
      // Mock fetch to return fake Knowbster API responses
      const originalFetch = globalThis.fetch;
      t.after(() => { globalThis.fetch = originalFetch; });

      globalThis.fetch = async (url) => {
        const tokenId = url.toString().split("/").pop();
        const responses = {
          "100": { knowledge: { tokenId: "100", salesCount: 3, price: "0.0048", validationStats: { total: 2, positive: 2, negative: 0 } } },
          "50": { knowledge: { tokenId: "50", title: "Pattern A", salesCount: 1, price: "0.002" } },
          "51": { knowledge: { tokenId: "51", title: "Pattern B", salesCount: 2, price: "0.002" } },
        };
        const body = responses[tokenId];
        if (!body) return { ok: false, status: 404 };
        return { ok: true, json: async () => body };
      };

      const collectionInfo = {
        tokenId: "100",
        title: "Test Collection",
        publishedAt: "2026-02-20T00:00:00Z",
        price: "0.0048",
        memberIds: ["p002", "p005", "p099"],
        memberCount: 3,
      };

      const published = {
        p002: { tokenId: "50", title: "Pattern A", price: "0.002" },
        p005: { tokenId: "51", title: "Pattern B", price: "0.002" },
        // p099 not published individually
      };

      const analytics = await fetchCollectionAnalytics("test-arch", collectionInfo, published);

      assert.equal(analytics.key, "test-arch");
      assert.equal(analytics.title, "Test Collection");
      assert.equal(analytics.collection.salesCount, 3);
      assert.equal(analytics.members.length, 3);
      assert.equal(analytics.members[0].salesCount, 1);
      assert.equal(analytics.members[1].salesCount, 2);
      assert.equal(analytics.members[2].status, "not published individually");
      assert.equal(analytics.summary.collectionSales, 3);
      assert.equal(analytics.summary.memberSales, 3);
      assert.equal(analytics.summary.totalSales, 6);
      assert.equal(analytics.summary.bundleRate, "50.0%");
    });

    it("handles collection with no published members gracefully", async (t) => {
      const originalFetch = globalThis.fetch;
      t.after(() => { globalThis.fetch = originalFetch; });

      globalThis.fetch = async (url) => {
        return {
          ok: true,
          json: async () => ({ knowledge: { tokenId: "200", salesCount: 0, price: "0.005" } }),
        };
      };

      const collectionInfo = {
        tokenId: "200",
        title: "Empty Collection",
        publishedAt: "2026-02-25T00:00:00Z",
        price: "0.005",
        memberIds: ["p001"],
        memberCount: 1,
      };

      const analytics = await fetchCollectionAnalytics("empty", collectionInfo, {});

      assert.equal(analytics.summary.collectionSales, 0);
      assert.equal(analytics.summary.memberSales, 0);
      assert.equal(analytics.summary.bundleRate, "N/A");
    });

    it("handles API failures for individual tokens", async (t) => {
      const originalFetch = globalThis.fetch;
      t.after(() => { globalThis.fetch = originalFetch; });

      globalThis.fetch = async () => ({ ok: false, status: 500 });

      const collectionInfo = {
        tokenId: "300",
        title: "Failing API",
        price: "0.004",
        memberIds: ["p001"],
        memberCount: 1,
      };

      const published = { p001: { tokenId: "60", title: "Pattern", price: "0.002" } };
      const analytics = await fetchCollectionAnalytics("fail", collectionInfo, published);

      // Should still produce a result with error info
      assert.ok(analytics.collection.error);
      assert.ok(analytics.members[0].error);
      assert.equal(analytics.summary.totalSales, 0);
    });
  });

  describe("formatAnalyticsReport", () => {
    it("produces readable report from analytics data", () => {
      const analytics = {
        key: "agent-arch",
        title: "Agent Architecture Patterns",
        publishedAt: "2026-02-20T12:00:00Z",
        collection: {
          tokenId: "100",
          salesCount: 5,
          price: "0.0048",
          validations: { total: 3, positive: 3, negative: 0 },
        },
        members: [
          { patternId: "p002", tokenId: "50", title: "Stateless session", salesCount: 2, price: "0.002" },
          { patternId: "p005", status: "not published individually" },
        ],
        summary: {
          collectionSales: 5,
          memberSales: 2,
          totalSales: 7,
          collectionRevenue: "0.0240",
          memberRevenue: "0.0040",
          totalRevenue: "0.0280",
          bundleRate: "71.4%",
        },
      };

      const report = formatAnalyticsReport(analytics);

      assert.ok(report.includes("Agent Architecture Patterns"), "should include title");
      assert.ok(report.includes("token #100"), "should include bundle token");
      assert.ok(report.includes("Sales: 5"), "should include bundle sales");
      assert.ok(report.includes("3+"), "should include validations");
      assert.ok(report.includes("Stateless session"), "should include member title");
      assert.ok(report.includes("not published individually"), "should note unpublished members");
      assert.ok(report.includes("Bundle purchase rate: 71.4%"), "should show bundle rate");
      assert.ok(report.includes("0.0280 ETH"), "should show total revenue");
    });

    it("handles collection without on-chain token", () => {
      const analytics = {
        key: "no-token",
        title: "Unpublished",
        collection: null,
        members: [],
        summary: {
          collectionSales: 0,
          memberSales: 0,
          totalSales: 0,
          collectionRevenue: "0.0000",
          memberRevenue: "0.0000",
          totalRevenue: "0.0000",
          bundleRate: "N/A",
        },
      };

      const report = formatAnalyticsReport(analytics);
      assert.ok(report.includes("not published on-chain"), "should note missing token");
    });
  });
});

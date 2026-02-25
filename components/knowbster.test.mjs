#!/usr/bin/env node
// knowbster.test.mjs — Unit tests for knowbster.js component
// Tests browse/detail/stats tools with mocked HTTP responses
// Usage: node --test components/knowbster.test.mjs
// Created: B#442 (wq-631)

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Mock server that captures tool registrations
function createMockServer() {
  const tools = new Map();
  return {
    tool(name, description, schema, handler) {
      tools.set(name, { name, description, schema, handler });
    },
    getTools() { return tools; },
    call(name, args) { return tools.get(name)?.handler(args); }
  };
}

// Mock fetch
let mockFetchResponses = [];
let originalFetch;

function setupMockFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async (url, options) => {
    const response = mockFetchResponses.shift();
    if (!response) throw new Error(`No mock response for ${url}`);
    if (response.error) throw response.error;
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      statusText: response.statusText || "OK",
      json: async () => response.body,
    };
  });
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
  mockFetchResponses = [];
}

function mockResponse(body, opts = {}) {
  mockFetchResponses.push({ body, ...opts });
}

function mockError(error) {
  mockFetchResponses.push({ error });
}

function getText(result) {
  return result?.content?.[0]?.text || "";
}

describe("knowbster.js component", async () => {
  let server;

  beforeEach(async () => {
    server = createMockServer();
    setupMockFetch();
    const mod = await import("./knowbster.js?" + Date.now());
    mod.register(server);
  });

  afterEach(() => {
    restoreFetch();
  });

  it("registers all expected tools", () => {
    const tools = server.getTools();
    assert.ok(tools.has("knowbster_browse"), "should register knowbster_browse");
    assert.ok(tools.has("knowbster_detail"), "should register knowbster_detail");
    assert.ok(tools.has("knowbster_stats"), "should register knowbster_stats");
    assert.equal(tools.size, 3, "should register exactly 3 tools");
  });

  describe("knowbster_browse", () => {
    it("returns formatted listings", async () => {
      mockResponse({
        total: 47,
        knowledge: [
          {
            tokenId: "1",
            title: "AI Ethics Guide",
            category: "Technology",
            description: "Comprehensive ethics guide",
            price: "0.01",
            salesCount: 5,
            author: "0xABCDEF1234567890",
            validationStats: { total: 3, positive: 2, negative: 1 },
          },
          {
            tokenId: "2",
            title: "Health Data 101",
            category: "Health",
            description: "Introduction to health data",
            price: "0.005",
            salesCount: 10,
            author: "0x9876543210FEDCBA",
            validationStats: { total: 0, positive: 0, negative: 0 },
          },
        ],
      });

      const result = await server.call("knowbster_browse", {});
      const text = getText(result);
      assert.ok(text.includes("47 total items"), text);
      assert.ok(text.includes("AI Ethics Guide"), text);
      assert.ok(text.includes("Health Data 101"), text);
      assert.ok(text.includes("(2+ / 1-)"), "should show validation stats");
      assert.ok(!text.includes("(0+ / 0-)"), "should omit zero validation stats");
    });

    it("handles empty results", async () => {
      mockResponse({ total: 0, knowledge: [] });

      const result = await server.call("knowbster_browse", {});
      const text = getText(result);
      assert.ok(text.includes("No knowledge items found"), text);
    });

    it("passes category and search params", async () => {
      mockResponse({ total: 1, knowledge: [
        { tokenId: "3", title: "Filtered", category: "Finance", description: "test",
          price: "0.01", salesCount: 0, author: "0x1234", validationStats: { total: 0 } }
      ]});

      await server.call("knowbster_browse", { category: "Finance", search: "test", limit: 5 });

      const fetchCall = globalThis.fetch.mock.calls[0];
      const url = fetchCall.arguments[0];
      assert.ok(url.includes("category=Finance"), `URL should include category: ${url}`);
      assert.ok(url.includes("search=test"), `URL should include search: ${url}`);
      assert.ok(url.includes("limit=5"), `URL should include limit: ${url}`);
    });

    it("caps limit at 50", async () => {
      mockResponse({ total: 0, knowledge: [] });
      await server.call("knowbster_browse", { limit: 100 });

      const url = globalThis.fetch.mock.calls[0].arguments[0];
      assert.ok(url.includes("limit=50"), `limit should be capped at 50: ${url}`);
    });

    it("defaults limit to 10", async () => {
      mockResponse({ total: 0, knowledge: [] });
      await server.call("knowbster_browse", {});

      const url = globalThis.fetch.mock.calls[0].arguments[0];
      assert.ok(url.includes("limit=10"), `default limit should be 10: ${url}`);
    });

    it("handles HTTP errors", async () => {
      mockResponse(null, { ok: false, status: 500, statusText: "Internal Server Error" });

      const result = await server.call("knowbster_browse", {});
      const text = getText(result);
      assert.ok(text.includes("Knowbster error"), text);
      assert.ok(text.includes("500"), text);
    });

    it("handles network errors", async () => {
      mockError(new Error("fetch failed"));

      const result = await server.call("knowbster_browse", {});
      const text = getText(result);
      assert.ok(text.includes("Knowbster error"), text);
      assert.ok(text.includes("fetch failed"), text);
    });
  });

  describe("knowbster_detail", () => {
    it("returns formatted detail view", async () => {
      mockResponse({
        knowledge: {
          tokenId: "42",
          title: "Advanced ML Patterns",
          category: "Technology",
          language: "English",
          jurisdiction: "Global",
          price: "0.02",
          salesCount: 15,
          author: "0xABCDEF1234567890",
          contentHash: "QmAbCdEf123456",
          validationStats: { total: 5, positive: 4, negative: 1 },
          createdAt: "2026-01-15T12:00:00Z",
          contentPreview: "This guide covers...",
        },
      });

      const result = await server.call("knowbster_detail", { token_id: "42" });
      const text = getText(result);
      assert.ok(text.includes("Advanced ML Patterns"), text);
      assert.ok(text.includes("#42"), text);
      assert.ok(text.includes("Technology"), text);
      assert.ok(text.includes("0.02 ETH"), text);
      assert.ok(text.includes("15"), text);
      assert.ok(text.includes("4 positive"), text);
      assert.ok(text.includes("QmAbCdEf123456"), text);
      assert.ok(text.includes("This guide covers"), text);
    });

    it("handles missing knowledge item", async () => {
      mockResponse({ knowledge: null });

      const result = await server.call("knowbster_detail", { token_id: "999" });
      const text = getText(result);
      assert.ok(text.includes("not found"), text);
    });

    it("handles flat response (no wrapper)", async () => {
      mockResponse({
        tokenId: "7",
        title: "Flat Response",
        category: "Test",
        language: "English",
        jurisdiction: "N/A",
        price: "0.01",
        salesCount: 0,
        author: "0x111",
        contentHash: "Qm123",
        validationStats: { total: 0 },
        createdAt: "2026-02-01",
      });

      const result = await server.call("knowbster_detail", { token_id: "7" });
      const text = getText(result);
      assert.ok(text.includes("Flat Response"), text);
    });

    it("handles HTTP errors", async () => {
      mockResponse(null, { ok: false, status: 404, statusText: "Not Found" });

      const result = await server.call("knowbster_detail", { token_id: "0" });
      const text = getText(result);
      assert.ok(text.includes("Knowbster error"), text);
    });
  });

  describe("knowbster_stats", () => {
    it("returns marketplace statistics", async () => {
      // First call: get total count
      mockResponse({ total: 47, knowledge: [{ tokenId: "1", category: "Technology", author: "0x1", salesCount: 5 }] });
      // Second call: sample for categories
      mockResponse({
        total: 47,
        knowledge: [
          { tokenId: "1", category: "Technology", author: "0xAAA", salesCount: 5 },
          { tokenId: "2", category: "Technology", author: "0xBBB", salesCount: 3 },
          { tokenId: "3", category: "Health", author: "0xAAA", salesCount: 10 },
          { tokenId: "4", category: "Finance", author: "0xCCC", salesCount: 0 },
        ],
      });

      const result = await server.call("knowbster_stats", {});
      const text = getText(result);
      assert.ok(text.includes("47"), "should show total count");
      assert.ok(text.includes("3"), "should show unique authors (3)");
      assert.ok(text.includes("Technology: 2"), "should show category breakdown");
      assert.ok(text.includes("Health: 1"), text);
      assert.ok(text.includes("Finance: 1"), text);
      assert.ok(text.includes("18"), "should show total sales (5+3+10+0=18)");
      assert.ok(text.includes("Base Mainnet"), "should mention chain");
    });

    it("handles empty marketplace", async () => {
      mockResponse({ total: 0, knowledge: [] });
      mockResponse({ total: 0, knowledge: [] });

      const result = await server.call("knowbster_stats", {});
      const text = getText(result);
      assert.ok(text.includes("0"), text);
    });

    it("handles HTTP errors", async () => {
      mockResponse(null, { ok: false, status: 503, statusText: "Service Unavailable" });

      const result = await server.call("knowbster_stats", {});
      const text = getText(result);
      assert.ok(text.includes("Knowbster error"), text);
    });
  });
});

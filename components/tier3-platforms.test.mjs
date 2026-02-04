#!/usr/bin/env node
// tier3-platforms.test.mjs — Unit tests for tier3-platforms.js component
// Tests MCP tools for Lobstack, Lobsterpedia, Dungeons & Lobsters, Grove
// Usage: node --test components/tier3-platforms.test.mjs

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || "/home/moltbot";
const BASE = join(HOME, "moltbook-mcp");

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

// Mock fetch for testing
let mockFetchResponses = [];
let originalFetch;

function setupMockFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async (url, options) => {
    const response = mockFetchResponses.shift();
    if (!response) throw new Error(`No mock response for ${url}`);
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      text: async () => JSON.stringify(response.body),
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

// Credential file helpers
const CRED_FILES = {
  lobstack: join(BASE, "lobstack-credentials.json"),
  lobsterpedia: join(BASE, "lobsterpedia-credentials.json"),
  dungeonsandlobsters: join(BASE, "dungeonsandlobsters-credentials.json"),
  grove: join(BASE, "grove-credentials.json"),
};

function setupCredential(platform, creds) {
  writeFileSync(CRED_FILES[platform], JSON.stringify(creds));
}

function cleanupCredentials() {
  for (const file of Object.values(CRED_FILES)) {
    if (existsSync(file)) unlinkSync(file);
  }
}

describe("tier3-platforms.js component", async () => {
  let server;

  beforeEach(() => {
    server = createMockServer();
    setupMockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it("registers all expected tools", async () => {
    const { register } = await import("./tier3-platforms.js");
    register(server);

    const tools = server.getTools();
    // Lobstack tools
    assert.ok(tools.has("lobstack_digest"), "has lobstack_digest");
    assert.ok(tools.has("lobstack_post"), "has lobstack_post");
    // Lobsterpedia tools
    assert.ok(tools.has("lobsterpedia_digest"), "has lobsterpedia_digest");
    assert.ok(tools.has("lobsterpedia_contribute"), "has lobsterpedia_contribute");
    // D&L tools
    assert.ok(tools.has("dal_digest"), "has dal_digest");
    assert.ok(tools.has("dal_action"), "has dal_action");
    // Grove tools
    assert.ok(tools.has("grove_digest"), "has grove_digest");
    assert.ok(tools.has("grove_post"), "has grove_post");

    assert.equal(tools.size, 8, "registers exactly 8 tools");
  });

  // ============================================================
  // LOBSTACK TESTS
  // ============================================================
  describe("lobstack_digest", async () => {
    it("returns formatted posts on success", async () => {
      const { register } = await import("./tier3-platforms.js");
      register(server);

      mockResponse({
        posts: [
          { id: "p1", title: "Test Post", author: "moltbook", content: "Hello world" },
          { id: "p2", title: "Another", agent_name: "claude", body: "Body text here" },
        ]
      });

      const result = await server.call("lobstack_digest", { limit: 15 });
      assert.ok(result.content[0].text.includes("Lobstack (2 posts)"));
      assert.ok(result.content[0].text.includes("[p1]"));
      assert.ok(result.content[0].text.includes("Test Post"));
      assert.ok(result.content[0].text.includes("moltbook"));
    });

    it("handles empty response", async () => {
      const { register } = await import("./tier3-platforms.js");
      register(server);

      mockResponse({ posts: [] });

      const result = await server.call("lobstack_digest", { limit: 15 });
      assert.ok(result.content[0].text.includes("No posts found"));
    });

    it("handles API errors gracefully", async () => {
      const { register } = await import("./tier3-platforms.js");
      register(server);

      mockResponse({}, { ok: false, status: 500 });

      const result = await server.call("lobstack_digest", { limit: 15 });
      assert.ok(result.content[0].text.includes("Lobstack error: 500"));
    });
  });

  describe("lobstack_post", async () => {
    it("returns error when not authenticated", async () => {
      cleanupCredentials();

      // Re-import to pick up missing creds
      const mod = await import("./tier3-platforms.js?" + Date.now());
      server = createMockServer();
      mod.register(server);

      const result = await server.call("lobstack_post", { title: "Test", content: "Body" });
      assert.ok(result.content[0].text.includes("auth not configured"));
    });
  });

  // ============================================================
  // LOBSTERPEDIA TESTS
  // ============================================================
  describe("lobsterpedia_digest", async () => {
    it("returns formatted articles on success", async () => {
      const { register } = await import("./tier3-platforms.js");
      register(server);

      mockResponse({
        articles: [
          { id: "a1", title: "Agent Memory", author: "wiki_bot", summary: "How agents store state" },
          { id: "a2", title: "Tool Safety", contributor: "safety_team", content: "Guidelines for safe tool use" },
        ]
      });

      const result = await server.call("lobsterpedia_digest", { limit: 15 });
      assert.ok(result.content[0].text.includes("Lobsterpedia (2 articles)"));
      assert.ok(result.content[0].text.includes("[a1]"));
      assert.ok(result.content[0].text.includes("Agent Memory"));
    });

    it("handles empty response", async () => {
      const { register } = await import("./tier3-platforms.js");
      register(server);

      mockResponse({ articles: [] });

      const result = await server.call("lobsterpedia_digest", { limit: 15 });
      assert.ok(result.content[0].text.includes("No articles found"));
    });
  });

  describe("lobsterpedia_contribute", async () => {
    it("returns error when not authenticated", async () => {
      cleanupCredentials();

      const mod = await import("./tier3-platforms.js?" + Date.now());
      server = createMockServer();
      mod.register(server);

      const result = await server.call("lobsterpedia_contribute", {
        title: "Test Article",
        content: "Article content"
      });
      assert.ok(result.content[0].text.includes("auth not configured"));
    });
  });

  // ============================================================
  // DUNGEONS & LOBSTERS TESTS
  // ============================================================
  describe("dal_digest", async () => {
    it("returns formatted activity on success", async () => {
      const { register } = await import("./tier3-platforms.js");
      register(server);

      mockResponse({
        events: [
          { type: "combat", agent_name: "hero_bot", description: "Defeated a goblin" },
          { type: "explore", character: "ranger", message: "Found a treasure chest" },
        ]
      });

      const result = await server.call("dal_digest", { limit: 15 });
      assert.ok(result.content[0].text.includes("D&L Activity (2 events)"));
      assert.ok(result.content[0].text.includes("[combat]"));
      assert.ok(result.content[0].text.includes("hero_bot"));
    });

    it("handles empty activity", async () => {
      const { register } = await import("./tier3-platforms.js");
      register(server);

      mockResponse({ events: [] });

      const result = await server.call("dal_digest", { limit: 15 });
      assert.ok(result.content[0].text.includes("No activity found"));
    });
  });

  describe("dal_action", async () => {
    it("returns error when not authenticated", async () => {
      cleanupCredentials();

      const mod = await import("./tier3-platforms.js?" + Date.now());
      server = createMockServer();
      mod.register(server);

      const result = await server.call("dal_action", { action: "explore" });
      assert.ok(result.content[0].text.includes("auth not configured"));
    });
  });

  // ============================================================
  // GROVE TESTS
  // ============================================================
  describe("grove_digest", async () => {
    it("returns formatted posts on success", async () => {
      const { register } = await import("./tier3-platforms.js");
      register(server);

      mockResponse({
        posts: [
          { id: "g1", author: "forest_bot", content: "Thinking about trees today" },
          { id: "g2", handle: "leaf_agent", body: "The canopy is beautiful" },
        ]
      });

      const result = await server.call("grove_digest", { limit: 15 });
      assert.ok(result.content[0].text.includes("Grove (2 posts)"));
      assert.ok(result.content[0].text.includes("[g1]"));
      assert.ok(result.content[0].text.includes("forest_bot"));
    });

    it("handles empty response", async () => {
      const { register } = await import("./tier3-platforms.js");
      register(server);

      mockResponse({ posts: [] });

      const result = await server.call("grove_digest", { limit: 15 });
      assert.ok(result.content[0].text.includes("No posts found"));
    });
  });

  describe("grove_post", async () => {
    it("returns error when not authenticated", async () => {
      cleanupCredentials();

      const mod = await import("./tier3-platforms.js?" + Date.now());
      server = createMockServer();
      mod.register(server);

      const result = await server.call("grove_post", { content: "Test post" });
      assert.ok(result.content[0].text.includes("auth not configured"));
    });
  });
});

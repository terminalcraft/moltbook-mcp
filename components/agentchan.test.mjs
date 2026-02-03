#!/usr/bin/env node
// agentchan.test.mjs — Unit tests for agentchan.js component
// Tests the component's logic and response formatting
// Usage: node --test components/agentchan.test.mjs

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

describe("agentchan.js component", async () => {
  let server;

  beforeEach(() => {
    server = createMockServer();
    setupMockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it("registers all expected tools", async () => {
    const { register } = await import("./agentchan.js");
    register(server);

    const tools = server.getTools();
    assert.ok(tools.has("agentchan_boards"), "has agentchan_boards");
    assert.ok(tools.has("agentchan_recent"), "has agentchan_recent");
    assert.ok(tools.has("agentchan_thread"), "has agentchan_thread");
    assert.ok(tools.has("agentchan_post"), "has agentchan_post");
    assert.ok(tools.has("agentchan_reply"), "has agentchan_reply");
    assert.ok(tools.has("agentchan_stats"), "has agentchan_stats");
    assert.equal(tools.size, 6, "registers exactly 6 tools");
  });

  describe("agentchan_boards", async () => {
    it("lists boards successfully", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({
        boards: [
          { uri: "phi", name: "Philosophy", description: "Deep thoughts" },
          { uri: "awg", name: "Agent Work", description: "Build stuff" }
        ]
      });

      const result = await server.call("agentchan_boards", {});
      assert.ok(result.content[0].text.includes("/phi/"), "includes phi board");
      assert.ok(result.content[0].text.includes("/awg/"), "includes awg board");
      assert.ok(result.content[0].text.includes("Philosophy"), "includes board name");
    });

    it("handles empty boards list", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({ boards: [] });

      const result = await server.call("agentchan_boards", {});
      assert.ok(result.content[0].text.includes("No boards"), "returns no boards message");
    });

    it("handles API error", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({}, { ok: false, status: 500 });

      const result = await server.call("agentchan_boards", {});
      assert.ok(result.content[0].text.includes("Error"), "returns error message");
    });
  });

  describe("agentchan_recent", async () => {
    it("lists recent posts", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({
        posts: [
          { id: 123, board: "phi", subject: "Test Thread", comment: "Hello world" },
          { id: 124, board: "awg", comment: "Another post here" }
        ]
      });

      const result = await server.call("agentchan_recent", { limit: 10 });
      assert.ok(result.content[0].text.includes("[123]"), "includes post ID");
      assert.ok(result.content[0].text.includes("/phi/"), "includes board");
      assert.ok(result.content[0].text.includes("Test Thread"), "includes subject");
    });

    it("handles empty posts", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({ posts: [] });

      const result = await server.call("agentchan_recent", {});
      assert.ok(result.content[0].text.includes("No recent"), "returns no posts message");
    });

    it("respects limit parameter", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({ posts: [] });

      await server.call("agentchan_recent", { limit: 5 });
      const call = globalThis.fetch.mock.calls[0];
      assert.ok(call.arguments[0].includes("limit=5"), "passes limit to API");
    });

    it("caps limit at 50", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({ posts: [] });

      await server.call("agentchan_recent", { limit: 100 });
      const call = globalThis.fetch.mock.calls[0];
      assert.ok(call.arguments[0].includes("limit=50"), "caps limit at 50");
    });
  });

  describe("agentchan_thread", async () => {
    it("fetches thread with replies", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({
        posts: [
          { id: 100, subject: "OP Subject", name: "Anon", comment: "OP text here" },
          { id: 101, name: "Replier", comment: "First reply" },
          { id: 102, name: "Other", comment: "Second reply" }
        ]
      });

      const result = await server.call("agentchan_thread", { board: "phi", thread_id: 100 });
      assert.ok(result.content[0].text.includes("OP Subject"), "includes OP subject");
      assert.ok(result.content[0].text.includes("2 replies"), "shows reply count");
      assert.ok(result.content[0].text.includes("#101"), "includes reply ID");
    });

    it("handles empty thread", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({ posts: [] });

      const result = await server.call("agentchan_thread", { board: "phi", thread_id: 999 });
      assert.ok(result.content[0].text.includes("not found"), "returns not found message");
    });
  });

  describe("agentchan_post", async () => {
    it("creates thread successfully", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({
        success: true,
        thread_id: 500,
        post_id: 500,
        url: "/phi/thread/500"
      });

      const result = await server.call("agentchan_post", {
        board: "phi",
        subject: "New Thread",
        comment: "Thread content"
      });
      assert.ok(result.content[0].text.includes("Thread created"), "confirms creation");
      assert.ok(result.content[0].text.includes("/phi/500"), "includes thread path");
    });

    it("handles rate limit error", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({
        success: false,
        error: "Rate limited",
        retry_after: 30
      });

      const result = await server.call("agentchan_post", {
        board: "phi",
        subject: "Test",
        comment: "Test"
      });
      assert.ok(result.content[0].text.includes("Error"), "returns error");
      assert.ok(result.content[0].text.includes("retry in 30s"), "includes retry time");
    });
  });

  describe("agentchan_reply", async () => {
    it("posts reply successfully", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({
        success: true,
        post_id: 501,
        url: "/phi/thread/500#501"
      });

      const result = await server.call("agentchan_reply", {
        board: "phi",
        thread_id: 500,
        comment: "Reply content"
      });
      assert.ok(result.content[0].text.includes("Reply posted"), "confirms reply");
      assert.ok(result.content[0].text.includes("#501"), "includes post ID");
    });
  });

  describe("agentchan_stats", async () => {
    it("returns statistics", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse({
        generated: "2026-02-03",
        global: { total_posts: 1000, total_threads: 50, posts_last_hour: 10 },
        boards: {
          phi: { total_posts: 500, total_threads: 25, posts_last_hour: 5 },
          awg: { total_posts: 500, total_threads: 25, posts_last_hour: 5 }
        }
      });

      const result = await server.call("agentchan_stats", {});
      assert.ok(result.content[0].text.includes("1000 posts"), "includes total posts");
      assert.ok(result.content[0].text.includes("/phi/"), "includes board stats");
    });

    it("handles no stats", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      mockResponse(null);

      const result = await server.call("agentchan_stats", {});
      assert.ok(result.content[0].text.includes("No stats"), "returns no stats message");
    });
  });

  describe("normalizePost helper", async () => {
    it("normalizes 4chan-style fields", async () => {
      const { register } = await import("./agentchan.js");
      register(server);

      // Test with 4chan-style field names (no/com/sub instead of id/comment/subject)
      mockResponse({
        posts: [
          { no: 123, board: "phi", sub: "Subject", com: "Comment text", resto: 0 }
        ]
      });

      const result = await server.call("agentchan_recent", {});
      assert.ok(result.content[0].text.includes("[123]"), "normalizes no to id");
      assert.ok(result.content[0].text.includes("Subject"), "normalizes sub to subject");
      assert.ok(result.content[0].text.includes("Comment"), "normalizes com to comment");
    });
  });
});

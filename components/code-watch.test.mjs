#!/usr/bin/env node
// code-watch.test.mjs — Unit tests for code-watch.js component
// Tests MCP tools: watch_repo, watch_list, watch_unsubscribe, watch_notify,
//                  review_request, review_list, review_close
// Usage: node --test components/code-watch.test.mjs

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

// Mock fetch for testing — simulates API responses from 127.0.0.1:3847
let mockFetchResponses = [];
let fetchCalls = [];
let originalFetch;

function setupMockFetch() {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  globalThis.fetch = mock.fn(async (url, options) => {
    fetchCalls.push({ url, options });
    const response = mockFetchResponses.shift();
    if (!response) throw new Error(`No mock response for ${url}`);
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      json: async () => response.body,
    };
  });
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
  mockFetchResponses = [];
  fetchCalls = [];
}

function mockResponse(body, opts = {}) {
  mockFetchResponses.push({ body, ...opts });
}

describe("code-watch.js component", async () => {
  let server;

  beforeEach(() => {
    server = createMockServer();
    setupMockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it("registers all expected tools", async () => {
    const { register } = await import("./code-watch.js");
    register(server);

    const tools = server.getTools();
    // Watch tools
    assert.ok(tools.has("watch_repo"), "has watch_repo");
    assert.ok(tools.has("watch_list"), "has watch_list");
    assert.ok(tools.has("watch_unsubscribe"), "has watch_unsubscribe");
    assert.ok(tools.has("watch_notify"), "has watch_notify");
    // Review request tools
    assert.ok(tools.has("review_request"), "has review_request");
    assert.ok(tools.has("review_list"), "has review_list");
    assert.ok(tools.has("review_close"), "has review_close");

    assert.equal(tools.size, 7, "registers exactly 7 tools");
  });

  // ============================================================
  // WATCH_REPO TESTS
  // ============================================================
  describe("watch_repo", async () => {
    it("returns success message on new subscription", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({
        id: "w123",
        repo: "owner/repo",
        agent: "moltbook"
      });

      const result = await server.call("watch_repo", {
        agent: "moltbook",
        repo: "owner/repo"
      });

      assert.ok(result.content[0].text.includes("Now watching **owner/repo**"));
      assert.ok(result.content[0].text.includes("ID: w123"));
      assert.ok(result.content[0].text.includes("inbox notifications"));
    });

    it("returns already_watching message when duplicate", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({
        id: "w123",
        repo: "owner/repo",
        already_watching: true
      });

      const result = await server.call("watch_repo", {
        agent: "moltbook",
        repo: "owner/repo"
      });

      assert.ok(result.content[0].text.includes("Already watching **owner/repo**"));
      assert.ok(result.content[0].text.includes("id: w123"));
    });

    it("handles API error response", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({ error: "Invalid repo format" }, { ok: false, status: 400 });

      const result = await server.call("watch_repo", {
        agent: "moltbook",
        repo: "invalid"
      });

      assert.ok(result.content[0].text.includes("Watch failed: Invalid repo format"));
    });

    it("handles network error", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      // No mock response — will throw
      const result = await server.call("watch_repo", {
        agent: "moltbook",
        repo: "owner/repo"
      });

      assert.ok(result.content[0].text.includes("Watch error:"));
    });
  });

  // ============================================================
  // WATCH_LIST TESTS
  // ============================================================
  describe("watch_list", async () => {
    it("returns formatted watch list", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({
        count: 2,
        watches: [
          { id: "w1", agent: "moltbook", repo: "owner/repo1", created: "2026-02-01T12:00:00Z" },
          { id: "w2", agent: "moltbook", repo: "owner/repo2", created: "2026-02-02T15:30:00Z" }
        ]
      });

      const result = await server.call("watch_list", { agent: "moltbook" });

      assert.ok(result.content[0].text.includes("**2 watch(es)**"));
      assert.ok(result.content[0].text.includes("w1"));
      assert.ok(result.content[0].text.includes("owner/repo1"));
      assert.ok(result.content[0].text.includes("2026-02-01"));
    });

    it("handles empty watch list", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({ count: 0, watches: [] });

      const result = await server.call("watch_list", {});

      assert.ok(result.content[0].text.includes("No watches found"));
    });

    it("passes filter parameters correctly", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({ count: 0, watches: [] });

      await server.call("watch_list", { agent: "testbot", repo: "test/repo" });

      assert.ok(fetchCalls[0].url.includes("agent=testbot"));
      assert.ok(fetchCalls[0].url.includes("repo=test%2Frepo"));
    });

    it("handles network error", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      const result = await server.call("watch_list", {});

      assert.ok(result.content[0].text.includes("Watch error:"));
    });
  });

  // ============================================================
  // WATCH_UNSUBSCRIBE TESTS
  // ============================================================
  describe("watch_unsubscribe", async () => {
    it("returns success message on deletion", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({ repo: "owner/repo" });

      const result = await server.call("watch_unsubscribe", { id: "w123" });

      assert.ok(result.content[0].text.includes("Stopped watching owner/repo"));
    });

    it("handles not found", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({}, { status: 404, ok: false });

      const result = await server.call("watch_unsubscribe", { id: "nonexistent" });

      assert.ok(result.content[0].text.includes("not found"));
    });

    it("handles network error", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      const result = await server.call("watch_unsubscribe", { id: "w123" });

      assert.ok(result.content[0].text.includes("Watch error:"));
    });
  });

  // ============================================================
  // WATCH_NOTIFY TESTS
  // ============================================================
  describe("watch_notify", async () => {
    it("returns success with watchers and reviewers", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({
        repo: "owner/repo",
        notified: 3,
        watchers: [{ agent: "alice" }, { agent: "bob" }],
        reviewers: [{ agent: "charlie" }]
      });

      const result = await server.call("watch_notify", {
        repo: "owner/repo",
        author: "moltbook",
        branch: "main",
        commit: "abc123",
        message: "Fix bug"
      });

      assert.ok(result.content[0].text.includes("Notified **3** agent(s)"));
      assert.ok(result.content[0].text.includes("**owner/repo**"));
      assert.ok(result.content[0].text.includes("Watchers: alice, bob"));
      assert.ok(result.content[0].text.includes("Reviewers: charlie"));
    });

    it("handles no watchers", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({
        repo: "owner/repo",
        notified: 0
      });

      const result = await server.call("watch_notify", { repo: "owner/repo" });

      assert.ok(result.content[0].text.includes("No watchers for owner/repo"));
    });

    it("handles API error", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({ error: "Repo not found" }, { ok: false, status: 404 });

      const result = await server.call("watch_notify", { repo: "bad/repo" });

      assert.ok(result.content[0].text.includes("Notify failed: Repo not found"));
    });

    it("handles network error", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      const result = await server.call("watch_notify", { repo: "owner/repo" });

      assert.ok(result.content[0].text.includes("Notify error:"));
    });
  });

  // ============================================================
  // REVIEW_REQUEST TESTS
  // ============================================================
  describe("review_request", async () => {
    it("creates new review request successfully", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({
        id: "rr123",
        repo: "owner/repo",
        requester: "moltbook",
        reviewer: "claude"
      });

      const result = await server.call("review_request", {
        requester: "moltbook",
        reviewer: "claude",
        repo: "owner/repo",
        description: "Please review my auth changes",
        branch: "feature/auth"
      });

      assert.ok(result.content[0].text.includes("Review request **rr123** created"));
      assert.ok(result.content[0].text.includes("**claude** will be notified"));
      assert.ok(result.content[0].text.includes("**owner/repo**"));
    });

    it("handles already exists response", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({
        id: "rr123",
        already_exists: true
      });

      const result = await server.call("review_request", {
        requester: "moltbook",
        reviewer: "claude",
        repo: "owner/repo"
      });

      assert.ok(result.content[0].text.includes("Open review request already exists"));
      assert.ok(result.content[0].text.includes("id: rr123"));
    });

    it("handles API error", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({ error: "Reviewer not found" }, { ok: false, status: 400 });

      const result = await server.call("review_request", {
        requester: "moltbook",
        reviewer: "nonexistent",
        repo: "owner/repo"
      });

      assert.ok(result.content[0].text.includes("Review request failed: Reviewer not found"));
    });

    it("handles network error", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      const result = await server.call("review_request", {
        requester: "moltbook",
        reviewer: "claude",
        repo: "owner/repo"
      });

      assert.ok(result.content[0].text.includes("Review request error:"));
    });
  });

  // ============================================================
  // REVIEW_LIST TESTS
  // ============================================================
  describe("review_list", async () => {
    it("returns formatted review requests", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({
        count: 2,
        requests: [
          {
            id: "rr1",
            status: "open",
            requester: "moltbook",
            reviewer: "claude",
            repo: "owner/repo1",
            pushes_notified: 3,
            description: "Review auth flow"
          },
          {
            id: "rr2",
            status: "completed",
            requester: "alice",
            reviewer: "bob",
            repo: "test/repo",
            pushes_notified: 1
          }
        ]
      });

      const result = await server.call("review_list", { reviewer: "claude" });

      assert.ok(result.content[0].text.includes("**2 review request(s)**"));
      assert.ok(result.content[0].text.includes("**rr1** [open]"));
      assert.ok(result.content[0].text.includes("moltbook → claude"));
      assert.ok(result.content[0].text.includes("3 pushes"));
      assert.ok(result.content[0].text.includes("Review auth flow"));
    });

    it("handles empty list", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({ count: 0, requests: [] });

      const result = await server.call("review_list", {});

      assert.ok(result.content[0].text.includes("No review requests found"));
    });

    it("passes filter parameters correctly", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({ count: 0, requests: [] });

      await server.call("review_list", {
        requester: "moltbook",
        reviewer: "claude",
        repo: "test/repo",
        status: "open"
      });

      assert.ok(fetchCalls[0].url.includes("requester=moltbook"));
      assert.ok(fetchCalls[0].url.includes("reviewer=claude"));
      assert.ok(fetchCalls[0].url.includes("repo=test%2Frepo"));
      assert.ok(fetchCalls[0].url.includes("status=open"));
    });

    it("handles network error", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      const result = await server.call("review_list", {});

      assert.ok(result.content[0].text.includes("Review list error:"));
    });
  });

  // ============================================================
  // REVIEW_CLOSE TESTS
  // ============================================================
  describe("review_close", async () => {
    it("marks review as completed successfully", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({
        id: "rr123",
        status: "completed"
      });

      const result = await server.call("review_close", {
        id: "rr123",
        status: "completed",
        notes: "LGTM, merged"
      });

      assert.ok(result.content[0].text.includes("Review request **rr123** marked as **completed**"));
    });

    it("marks review as closed successfully", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({
        id: "rr456",
        status: "closed"
      });

      const result = await server.call("review_close", {
        id: "rr456",
        status: "closed"
      });

      assert.ok(result.content[0].text.includes("marked as **closed**"));
    });

    it("handles not found", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      mockResponse({}, { status: 404, ok: false });

      const result = await server.call("review_close", {
        id: "nonexistent",
        status: "completed"
      });

      assert.ok(result.content[0].text.includes("not found"));
    });

    it("handles network error", async () => {
      const { register } = await import("./code-watch.js");
      register(server);

      const result = await server.call("review_close", {
        id: "rr123",
        status: "completed"
      });

      assert.ok(result.content[0].text.includes("Review close error:"));
    });
  });
});

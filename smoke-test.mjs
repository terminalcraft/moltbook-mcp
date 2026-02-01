#!/usr/bin/env node
// Smoke test for moltbook API — tests all public endpoints
// Usage: node smoke-test.mjs [base_url]

const BASE = process.argv[2] || "http://127.0.0.1:3847";

const tests = [
  // Core
  { method: "GET", path: "/", expect: 200 },
  { method: "GET", path: "/health", expect: 200 },
  { method: "GET", path: "/status", expect: 200 },
  { method: "GET", path: "/status/all", expect: 200 },
  { method: "GET", path: "/status/dashboard", expect: 200 },
  { method: "GET", path: "/stats", expect: [200, 401] },
  { method: "GET", path: "/summary", expect: 200 },
  { method: "GET", path: "/live", expect: [200, 401] },
  { method: "GET", path: "/feed", expect: 200 },
  { method: "GET", path: "/feed?format=atom", expect: 200 },

  // Docs & specs
  { method: "GET", path: "/docs", expect: 200 },
  { method: "GET", path: "/openapi.json", expect: 200 },
  { method: "GET", path: "/agent.json", expect: 200 },
  { method: "GET", path: "/.well-known/agent.json", expect: 200 },
  { method: "GET", path: "/skill.md", expect: 200 },
  { method: "GET", path: "/changelog", expect: 200 },
  { method: "GET", path: "/changelog?format=json", expect: 200 },
  { method: "GET", path: "/metrics", expect: 200 },
  { method: "GET", path: "/backup", expect: 401 },

  // Analytics & costs
  { method: "GET", path: "/analytics", expect: [200, 401] },
  { method: "GET", path: "/costs", expect: 200 },
  { method: "GET", path: "/costs?format=json", expect: 200 },
  { method: "GET", path: "/sessions", expect: 200 },

  // Directory & network
  { method: "GET", path: "/directory", expect: 200 },
  { method: "GET", path: "/network", expect: 200 },
  { method: "GET", path: "/services", expect: 200 },

  // Registry
  { method: "GET", path: "/registry", expect: 200 },

  // Knowledge
  { method: "GET", path: "/knowledge/patterns", expect: 200 },
  { method: "GET", path: "/knowledge/digest", expect: 200 },
  { method: "GET", path: "/knowledge/topics", expect: 200 },
  { method: "GET", path: "/knowledge/exchange-log", expect: 200 },

  // Leaderboard
  { method: "GET", path: "/leaderboard", expect: 200 },

  // Build log
  { method: "GET", path: "/buildlog", expect: 200 },
  { method: "GET", path: "/buildlog?format=json", expect: 200 },
  { method: "POST", path: "/buildlog", body: { agent: "smoke-test", summary: "Smoke test entry" }, expect: 201 },

  // Search
  { method: "GET", path: "/search?q=test", expect: 200 },

  // Badges
  { method: "GET", path: "/badges", expect: 200 },

  // Monitors
  { method: "GET", path: "/monitors", expect: 200 },

  // Uptime
  { method: "GET", path: "/uptime", expect: 200 },

  // Tasks
  { method: "GET", path: "/tasks", expect: 200 },

  // Webhooks
  { method: "GET", path: "/webhooks/events", expect: 200 },

  // Short URLs
  { method: "GET", path: "/short", expect: 200 },

  // Paste bin
  { method: "GET", path: "/paste", expect: 200 },

  // KV store
  { method: "GET", path: "/kv", expect: 200 },

  // Cron
  { method: "GET", path: "/cron", expect: 200 },

  // Polls
  { method: "GET", path: "/polls", expect: 200 },

  // Topics (pubsub)
  { method: "GET", path: "/topics", expect: 200 },

  // Rooms
  { method: "GET", path: "/rooms", expect: 200 },

  // Notifications
  { method: "GET", path: "/notifications/events/list", expect: 200 },
  { method: "GET", path: "/notifications/smoke-test", expect: 200 },

  // Inbox (public)
  { method: "GET", path: "/inbox/stats", expect: 200 },

  // Summaries
  { method: "GET", path: "/summaries", expect: [200, 401] },

  // Platform digest
  { method: "GET", path: "/digest", expect: 200 },
  { method: "GET", path: "/digest?hours=1&format=json", expect: 200 },

  // External digests (may be slow)
  { method: "GET", path: "/4claw/digest?format=json", expect: 200, timeout: 15000 },
  { method: "GET", path: "/chatr/digest?format=json", expect: 200, timeout: 15000 },

  // POST endpoints with safe test payloads
  { method: "POST", path: "/inbox", body: { from: "smoke-test", body: "Automated smoke test — please ignore." }, expect: [200, 201] },
  { method: "POST", path: "/paste", body: { content: "smoke test paste", language: "text" }, expect: [200, 201] },
  { method: "PUT", path: "/kv/smoke-test/test-key", body: { value: "smoke", ttl: 60 }, expect: [200, 201], seq: "kv" },
  { method: "GET", path: "/kv/smoke-test/test-key", expect: 200, seq: "kv" },
  { method: "DELETE", path: "/kv/smoke-test/test-key", expect: 200, seq: "kv" },

  // Agent profiles
  { method: "GET", path: "/agents", expect: 200 },
  { method: "PUT", path: "/agents/smoke-test", body: { bio: "smoke test agent", tags: ["test"] }, expect: 200, seq: "profile" },
  { method: "GET", path: "/agents/smoke-test", expect: 200, seq: "profile" },

  // Snapshots
  { method: "GET", path: "/snapshots", expect: 200 },
  { method: "POST", path: "/snapshots", body: { handle: "smoke-test", label: "smoke-1", data: { test: true }, tags: ["smoke"] }, expect: [200, 201], seq: "snap" },
  { method: "GET", path: "/snapshots/smoke-test", expect: 200, seq: "snap" },
  { method: "GET", path: "/snapshots/smoke-test/latest", expect: 200, seq: "snap" },

  // Presence
  { method: "GET", path: "/presence", expect: 200 },
  { method: "POST", path: "/presence", body: { handle: "smoke-test", status: "available" }, expect: 200, seq: "presence" },
  { method: "GET", path: "/presence/smoke-test", expect: 200, seq: "presence" },
  { method: "GET", path: "/presence/smoke-test/history?days=1", expect: 200, seq: "presence" },
  { method: "GET", path: "/presence/leaderboard", expect: 200 },

  // Verify (no handle = error)
  { method: "GET", path: "/verify", expect: 400 },
];

async function runTest(test) {
  const url = `${BASE}${test.path}`;
  const timeout = test.timeout || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const opts = { method: test.method, signal: controller.signal, headers: {} };
    if (test.body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(test.body);
    }
    const res = await fetch(url, opts);
    clearTimeout(timer);

    const expected = Array.isArray(test.expect) ? test.expect : [test.expect];
    const pass = expected.includes(res.status);
    return { ...test, status: res.status, pass, error: null };
  } catch (e) {
    clearTimeout(timer);
    return { ...test, status: 0, pass: false, error: e.name === "AbortError" ? "TIMEOUT" : e.message };
  }
}

async function main() {
  console.log(`Smoke testing ${BASE} — ${tests.length} tests\n`);
  const start = Date.now();

  // Separate sequential tests (must run in order) from parallel ones
  const parallel = tests.filter(t => !t.seq);
  const seqGroups = {};
  for (const t of tests) if (t.seq) (seqGroups[t.seq] ||= []).push(t);

  // Run parallel tests in batches of 10
  const results = [];
  for (let i = 0; i < parallel.length; i += 10) {
    const batch = parallel.slice(i, i + 10);
    const batchResults = await Promise.all(batch.map(runTest));
    results.push(...batchResults);
  }

  // Run sequential groups one at a time
  for (const group of Object.values(seqGroups)) {
    for (const t of group) results.push(await runTest(t));
  }

  const passed = results.filter(r => r.pass);
  const failed = results.filter(r => !r.pass);

  for (const r of results) {
    const icon = r.pass ? "✓" : "✗";
    const detail = r.error ? ` (${r.error})` : "";
    console.log(`  ${icon} ${r.method.padEnd(6)} ${r.path} → ${r.status}${detail}`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n${passed.length}/${results.length} passed in ${elapsed}s`);

  if (failed.length > 0) {
    console.log(`\nFailed:`);
    for (const f of failed) {
      console.log(`  ${f.method} ${f.path} → got ${f.status}, expected ${Array.isArray(f.expect) ? f.expect.join("|") : f.expect}${f.error ? ` (${f.error})` : ""}`);
    }
    process.exit(1);
  }

  // Output JSON summary for programmatic consumption
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ total: results.length, passed: passed.length, failed: failed.length, elapsed, results }, null, 2));
  }
}

main();

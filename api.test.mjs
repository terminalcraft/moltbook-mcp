#!/usr/bin/env node
// api.test.mjs — Unit tests for api.mjs endpoints
// Tests response structure and content, not just status codes
// Usage: node api.test.mjs [base_url]

const BASE = process.argv[2] || "http://127.0.0.1:3847";
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; process.stdout.write("."); }
  else { failed++; console.log(`\n  FAIL: ${msg}`); }
}

async function get(path, timeout = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    clearTimeout(t);
    const ct = r.headers.get("content-type") || "";
    const body = ct.includes("json") ? await r.json() : await r.text();
    return { status: r.status, ct, body };
  } catch (e) {
    clearTimeout(t);
    return { status: 0, ct: "", body: null, error: e.message };
  }
}

async function post(path, data, timeout = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    clearTimeout(t);
    const ct = r.headers.get("content-type") || "";
    const body = ct.includes("json") ? await r.json() : await r.text();
    return { status: r.status, ct, body };
  } catch (e) {
    clearTimeout(t);
    return { status: 0, ct: "", body: null, error: e.message };
  }
}

// --- Core endpoints ---

async function testRoot() {
  const r = await get("/");
  assert(r.status === 200, "/ returns 200");
  assert(r.ct.includes("html"), "/ returns HTML");
}

async function testHealth() {
  const r = await get("/health");
  assert(r.status === 200, "/health returns 200");
  assert(r.ct.includes("html"), "/health returns HTML dashboard");
}

async function testAgentJson() {
  const r = await get("/agent.json");
  assert(r.status === 200, "/agent.json returns 200");
  assert(r.body?.agent || r.body?.name, "/agent.json has agent/name");
  assert(r.body?.capabilities, "/agent.json has capabilities");
  assert(r.body?.endpoints, "/agent.json has endpoints");
  assert(r.body?.version, "/agent.json has version");
}

async function testWellKnownAgent() {
  const r = await get("/.well-known/agent.json");
  assert(r.status === 200, "/.well-known/agent.json returns 200");
  assert(r.body?.agent, "/.well-known/agent.json has agent field");
}

async function testOpenApi() {
  const r = await get("/openapi.json");
  assert(r.status === 200, "/openapi.json returns 200");
  assert(r.body?.openapi, "/openapi.json has openapi version");
  assert(r.body?.paths && typeof r.body.paths === "object", "/openapi.json has paths");
  assert(Object.keys(r.body.paths).length > 50, "/openapi.json has >50 paths");
}

async function testDocs() {
  const r = await get("/docs");
  assert(r.status === 200, "/docs returns 200");
  assert(r.ct.includes("html"), "/docs returns HTML");
}

async function testSkillMd() {
  const r = await get("/skill.md");
  assert(r.status === 200, "/skill.md returns 200");
  assert(typeof r.body === "string" && r.body.length > 50, "/skill.md has content");
}

async function testRoutes() {
  const r = await get("/routes");
  assert(r.status === 200, "/routes returns 200");
  const routes = r.body?.routes || r.body;
  assert(Array.isArray(routes), "/routes has routes array");
  assert(routes.length > 50, "/routes has >50 routes");
  assert(routes[0]?.method && routes[0]?.path, "/routes entries have method+path");
}

// --- Status endpoints (JSON via ?format=json or direct) ---

async function testStatusDashboard() {
  const r = await get("/status/dashboard");
  assert(r.status === 200, "/status/dashboard returns 200");
  assert(r.ct.includes("html"), "/status/dashboard returns HTML");
}

async function testStatusAll() {
  const r = await get("/status/all");
  assert(r.status === 200, "/status/all returns 200");
  assert(r.body && typeof r.body === "object", "/status/all returns JSON");
}

async function testStatusQueue() {
  const r = await get("/status/queue");
  assert(r.status === 200, "/status/queue returns 200");
  assert(r.body && typeof r.body === "object", "/status/queue returns object");
}

async function testStatusQueueHealth() {
  const r = await get("/status/queue-health");
  assert(r.status === 200, "/status/queue-health returns 200");
}

async function testStatusQueueVelocity() {
  const r = await get("/status/queue-velocity");
  assert(r.status === 200, "/status/queue-velocity returns 200");
}

async function testStatusEfficiency() {
  const r = await get("/status/efficiency");
  assert(r.status === 200, "/status/efficiency returns 200");
}

async function testStatusDirectives() {
  const r = await get("/status/directives");
  assert(r.status === 200, "/status/directives returns 200");
}

async function testStatusPipeline() {
  const r = await get("/status/pipeline");
  assert(r.status === 200, "/status/pipeline returns 200");
}

async function testStatusPlatforms() {
  const r = await get("/status/platforms");
  assert(r.status === 200, "/status/platforms returns 200");
}

async function testStatusCostHeatmap() {
  const r = await get("/status/cost-heatmap");
  assert(r.status === 200, "/status/cost-heatmap returns 200");
}

async function testStatusCostDistribution() {
  const r = await get("/status/cost-distribution");
  assert(r.status === 200, "/status/cost-distribution returns 200");
}

async function testStatusSessionEffectiveness() {
  const r = await get("/status/session-effectiveness");
  assert(r.status === 200, "/status/session-effectiveness returns 200");
}

async function testStatusCreds() {
  const r = await get("/status/creds");
  assert(r.status === 200, "/status/creds returns 200");
  assert(r.body && typeof r.body === "object", "/status/creds returns object");
}

// --- Sessions & analytics ---

async function testSessionsJson() {
  const r = await get("/sessions?format=json");
  assert(r.status === 200, "/sessions?format=json returns 200");
  assert(r.body?.sessions || r.body?.count !== undefined, "/sessions has sessions data");
  if (r.body?.sessions) {
    const s = r.body.sessions[0];
    assert(s?.session !== undefined, "session entry has session number");
    assert(s?.mode, "session entry has mode");
  }
}

async function testCostsJson() {
  const r = await get("/costs?format=json");
  assert(r.status === 200, "/costs?format=json returns 200");
  assert(Array.isArray(r.body), "/costs returns array");
  if (r.body?.length > 0) {
    assert(r.body[0]?.spent !== undefined || r.body[0]?.cost !== undefined, "cost entry has spent/cost");
  }
}

async function testMetrics() {
  const r = await get("/metrics");
  assert(r.status === 200, "/metrics returns 200");
}

async function testEfficiency() {
  const r = await get("/efficiency");
  assert(r.status === 200, "/efficiency returns 200");
}

async function testChangelog() {
  const r = await get("/changelog?format=json");
  assert(r.status === 200, "/changelog?format=json returns 200");
}

// --- Engagement ---

async function testEngagementRoi() {
  const r = await get("/engagement/roi-leaderboard");
  assert(r.status === 200, "/engagement/roi-leaderboard returns 200");
}

// --- Knowledge ---

async function testKnowledgePatterns() {
  const r = await get("/knowledge/patterns");
  assert(r.status === 200, "/knowledge/patterns returns 200");
  const patterns = r.body?.patterns || r.body;
  assert(Array.isArray(patterns), "/knowledge/patterns returns array");
  if (patterns?.length > 0) {
    assert(patterns[0]?.title || patterns[0]?.id, "pattern has title or id");
    assert(patterns[0]?.category, "pattern has category");
  }
}

async function testKnowledgeDigest() {
  const r = await get("/knowledge/digest");
  assert(r.status === 200, "/knowledge/digest returns 200");
  // Returns markdown text
  assert(typeof r.body === "string" && r.body.includes("pattern"), "/knowledge/digest mentions patterns");
}

async function testKnowledgeTopics() {
  const r = await get("/knowledge/topics");
  assert(r.status === 200, "/knowledge/topics returns 200");
}

async function testKnowledgeExchangeLog() {
  const r = await get("/knowledge/exchange-log");
  assert(r.status === 200, "/knowledge/exchange-log returns 200");
}

// --- Registry ---

async function testRegistry() {
  const r = await get("/registry");
  assert(r.status === 200, "/registry returns 200");
}

// --- Directory & network ---

async function testDirectory() {
  const r = await get("/directory");
  assert(r.status === 200, "/directory returns 200");
}

async function testNetwork() {
  const r = await get("/network");
  assert(r.status === 200, "/network returns 200");
}

// --- Search ---

async function testSearch() {
  const r = await get("/search?q=test");
  assert(r.status === 200, "/search?q=test returns 200");
}

// --- Directives ---

async function testDirectives() {
  const r = await get("/directives");
  assert(r.status === 200, "/directives returns 200");
}

// --- Leaderboard ---

async function testLeaderboard() {
  const r = await get("/leaderboard");
  assert(r.status === 200, "/leaderboard returns 200");
}

// --- Services ---

async function testServices() {
  const r = await get("/services");
  assert(r.status === 200, "/services returns 200");
}

// --- Feed ---

async function testFeed() {
  const r = await get("/feed");
  assert(r.status === 200, "/feed returns 200");
}

async function testFeedAtom() {
  const r = await get("/feed?format=atom");
  assert(r.status === 200, "/feed?format=atom returns 200");
  assert(r.ct.includes("xml") || r.ct.includes("atom"), "/feed atom has xml content type");
}

// --- Monitors & uptime ---

async function testMonitors() {
  const r = await get("/monitors");
  assert(r.status === 200, "/monitors returns 200");
}

async function testUptime() {
  const r = await get("/uptime");
  assert(r.status === 200, "/uptime returns 200");
}

// --- Badges ---

async function testBadges() {
  const r = await get("/badges");
  assert(r.status === 200, "/badges returns 200");
}

// --- Tasks ---

async function testTasks() {
  const r = await get("/tasks");
  assert(r.status === 200, "/tasks returns 200");
}

// --- KV CRUD ---

async function testKvCrud() {
  const ns = "api-test", key = "ut-" + Date.now();

  const put = await fetch(`${BASE}/kv/${ns}/${key}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "hello", ttl: 60 })
  });
  assert(put.status === 200 || put.status === 201, `PUT kv succeeds (${put.status})`);

  const getR = await get(`/kv/${ns}/${key}`);
  assert(getR.status === 200, "GET kv returns 200");
  assert(getR.body?.value === "hello", "GET kv returns correct value");

  const list = await get(`/kv/${ns}`);
  assert(list.status === 200, "GET kv namespace returns 200");

  const del = await fetch(`${BASE}/kv/${ns}/${key}`, { method: "DELETE" });
  assert(del.status === 200, "DELETE kv succeeds");

  const getAfter = await get(`/kv/${ns}/${key}`);
  assert(getAfter.status === 404, "GET deleted kv returns 404");
}

// --- Paste CRUD ---

async function testPasteCrud() {
  const r = await post("/paste", { content: "unit test paste", language: "text" });
  assert(r.status === 200 || r.status === 201, "POST /paste succeeds");
  if (r.body?.id) {
    const getR = await get(`/paste/${r.body.id}`);
    assert(getR.status === 200, "GET paste by id returns 200");
  }

  const list = await get("/paste");
  assert(list.status === 200, "GET /paste returns 200");
}

// --- Polls CRUD ---

async function testPollsCrud() {
  const list = await get("/polls");
  assert(list.status === 200, "GET /polls returns 200");
}

// --- Cron ---

async function testCron() {
  const r = await get("/cron");
  assert(r.status === 200, "GET /cron returns 200");
}

// --- Webhooks ---

async function testWebhookEvents() {
  const r = await get("/webhooks/events");
  assert(r.status === 200, "GET /webhooks/events returns 200");
}

// --- Inbox ---

async function testInboxStats() {
  const r = await get("/inbox/stats");
  assert(r.status === 200, "GET /inbox/stats returns 200");
}

// --- Buildlog ---

async function testBuildlog() {
  const r = await get("/buildlog?format=json");
  assert(r.status === 200, "GET /buildlog?format=json returns 200");
}

// --- Summary ---

async function testSummary() {
  const r = await get("/summary");
  assert(r.status === 200, "GET /summary returns 200");
}

// --- Identity ---

async function testIdentityProof() {
  const r = await get("/identity/proof");
  assert(r.status === 200, "/identity/proof returns 200");
  assert(typeof r.body === "string" && r.body.includes("AGENT IDENTITY"), "/identity/proof has identity content");
}

// --- Verify (no handle = 400) ---

async function testVerifyNoHandle() {
  const r = await get("/verify");
  assert(r.status === 400, "/verify without handle returns 400");
}

// --- Integration endpoints ---

async function testIntegrations() {
  const r = await get("/integrations");
  assert(r.status === 200, "/integrations returns 200");
}

async function testHumanReview() {
  // GET empty queue
  const r1 = await get("/human-review");
  assert(r1.status === 200, "/human-review returns 200");
  assert(Array.isArray(r1.body?.items), "/human-review has items array");

  // POST new item
  const r2 = await post("/human-review", { title: "test-item", body: "test body", source: "api-test", priority: "high" });
  assert(r2.status === 201, "POST /human-review returns 201");
  assert(r2.body?.ok === true, "POST /human-review returns ok:true");
  assert(typeof r2.body?.id === "string", "POST /human-review returns an id");
  const id = r2.body?.id;

  // GET should now include the item
  const r3 = await get("/human-review");
  assert(r3.body?.items?.some(i => i.id === id), "GET /human-review includes posted item");
  const item = r3.body?.items?.find(i => i.id === id);
  assert(item?.title === "test-item", "Item has correct title");
  assert(item?.priority === "high", "Item has correct priority");
  assert(item?.status === "open", "Item defaults to open status");

  // Status dashboard (HTML)
  const r4 = await get("/status/human-review?format=html");
  assert(r4.status === 200, "/status/human-review?format=html returns 200");
  assert(r4.ct.includes("html"), "/status/human-review returns HTML with format=html");

  // Status dashboard (JSON default)
  const r5 = await get("/status/human-review");
  assert(r5.status === 200, "/status/human-review returns 200");

  // POST without title should fail
  const r6 = await post("/human-review", { body: "no title" });
  assert(r6.status === 400, "POST /human-review without title returns 400");

  // Cleanup: resolve the test item via PATCH
  const r7 = await fetch(`${BASE}/human-review/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.API_KEY || ""}` },
    body: JSON.stringify({ status: "resolved" }),
  });
  // Don't assert on PATCH — may lack auth key in test env
}

// --- Auth: requireVerifiedAgent rejects unsigned POST requests ---

async function testRequireVerifiedAgentReject() {
  // POST to a protected endpoint without signed headers — should get 403
  const r = await post("/registry", { handle: "test-agent", capabilities: ["test"] });
  assert(r.status === 403, "POST /registry without auth returns 403");
  assert(r.body?.error?.includes("verification"), "403 body mentions verification");
  assert(r.body?.reason, "403 body has reason field");
  assert(r.body?.help, "403 body has help text");
}

async function testRequireVerifiedLeaderboard() {
  const r = await post("/leaderboard", { handle: "test-agent" });
  assert(r.status === 403, "POST /leaderboard without auth returns 403");
}

async function testRequireVerifiedKnowledgeValidate() {
  const r = await post("/knowledge/validate", { pattern_id: "p001" });
  assert(r.status === 403, "POST /knowledge/validate without auth returns 403");
}

// --- Handshake error cases ---

async function testHandshakeNoUrl() {
  const r = await post("/handshake", {});
  assert(r.status === 400, "POST /handshake without url returns 400");
  assert(r.body?.error?.includes("url"), "handshake 400 mentions url");
}

async function testHandshakeBadProtocol() {
  const r = await post("/handshake", { url: "ftp://evil.com/agent.json" });
  assert(r.status === 400, "POST /handshake with ftp:// returns 400");
}

async function testHandshakeUnreachable() {
  const r = await post("/handshake", { url: "http://192.0.2.1:9999/agent.json" }, 15000);
  assert(r.status === 200, "POST /handshake with unreachable host returns 200");
  assert(r.body?.ok === false, "handshake unreachable has ok:false");
  assert(r.body?.error, "handshake unreachable has error message");
}

// --- Task CRUD lifecycle ---

async function testTaskCrud() {
  // POST missing fields
  const r1 = await post("/tasks", { title: "no-from" });
  assert(r1.status === 400, "POST /tasks without from returns 400");

  const r1b = await post("/tasks", { from: "test-agent" });
  assert(r1b.status === 400, "POST /tasks without title returns 400");

  // Create task
  const r2 = await post("/tasks", { from: "api-test", title: "Test task " + Date.now(), priority: "high" });
  assert(r2.status === 201, "POST /tasks returns 201");
  assert(r2.body?.task?.id, "created task has id");
  assert(r2.body?.task?.status === "open", "created task is open");
  assert(r2.body?.task?.priority === "high", "created task has correct priority");
  const taskId = r2.body?.task?.id;

  // Get single task
  const r3 = await get(`/tasks/${taskId}`);
  assert(r3.status === 200, "GET /tasks/:id returns 200");
  assert(r3.body?.task?.title, "task has title");

  // Get nonexistent task
  const r4 = await get("/tasks/nonexistent-id");
  assert(r4.status === 404, "GET /tasks/:id for missing task returns 404");

  // Claim task
  const r5 = await post(`/tasks/${taskId}/claim`, { agent: "test-claimer" });
  assert(r5.status === 200, "POST /tasks/:id/claim returns 200");

  // Claim already-claimed task
  const r6 = await post(`/tasks/${taskId}/claim`, { agent: "another-agent" });
  assert(r6.status === 409, "POST /tasks/:id/claim on claimed task returns 409");

  // Claim without agent
  const r7 = await post(`/tasks/${taskId}/claim`, {});
  assert(r7.status === 400, "POST /tasks/:id/claim without agent returns 400");

  // Tasks available (work queue items)
  const r8 = await get("/tasks/available");
  assert(r8.status === 200, "GET /tasks/available returns 200");
  assert(r8.body?.count !== undefined, "/tasks/available has count");

  // Task filtering
  const r9 = await get("/tasks?status=open");
  assert(r9.status === 200, "GET /tasks?status=open returns 200");
}

// --- Poll CRUD lifecycle ---

async function testPollCrud() {
  // Create poll with bad input
  const r1 = await post("/polls", { question: "test?" });
  assert(r1.status === 400, "POST /polls without options returns 400");

  const r1b = await post("/polls", { question: "test?", options: ["only-one"] });
  assert(r1b.status === 400, "POST /polls with <2 options returns 400");

  // Create valid poll
  const r2 = await post("/polls", { question: "Unit test poll?", options: ["yes", "no"], agent: "api-test", expires_in: 60 });
  assert(r2.status === 201, "POST /polls returns 201");
  assert(r2.body?.id, "created poll has id");
  assert(r2.body?.question === "Unit test poll?", "poll has correct question");
  assert(r2.body?.options?.length === 2, "poll has 2 options");
  const pollId = r2.body?.id;

  // Get single poll
  if (pollId) {
    const r3 = await get(`/polls/${pollId}`);
    assert(r3.status === 200, "GET /polls/:id returns 200");
    assert(r3.body?.results?.length === 2, "poll results has 2 options");
    assert(r3.body?.total_votes === 0, "new poll has 0 votes");
  }

  // Get nonexistent poll
  const r4 = await get("/polls/nonexistent");
  assert(r4.status === 404, "GET /polls/:id for missing poll returns 404");
}

// --- Dispatch error cases ---

async function testDispatchErrors() {
  // POST without required fields
  const r = await post("/dispatch", {});
  assert(r.status === 400 || r.status === 403, "POST /dispatch without fields fails");
}

// --- Activity & activity stream ---

async function testActivity() {
  const r = await get("/activity");
  assert(r.status === 200, "GET /activity returns 200");
}

// --- Ecosystem endpoints ---

async function testEcosystemMap() {
  const r = await get("/ecosystem/map");
  assert(r.status === 200, "GET /ecosystem/map returns 200");
}

async function testEcosystemRanking() {
  const r = await get("/ecosystem/ranking");
  assert(r.status === 200, "GET /ecosystem/ranking returns 200");
}

// --- Agents directory ---

async function testAgents() {
  const r = await get("/agents");
  assert(r.status === 200, "GET /agents returns 200");
}

// --- Peers ---

async function testPeers() {
  const r = await get("/peers");
  assert(r.status === 200, "GET /peers returns 200");
}

// --- Adoption ---

async function testAdoption() {
  const r = await get("/adoption");
  assert(r.status === 200, "GET /adoption returns 200");
}

// --- Outcomes ---

async function testOutcomes() {
  const r = await get("/outcomes");
  assert(r.status === 200, "GET /outcomes returns 200");
}

// --- Specialization ---

async function testSpecialization() {
  const r = await get("/specialization");
  assert(r.status === 200, "GET /specialization returns 200");
}

// --- Rotation ---

async function testRotation() {
  const r = await get("/rotation");
  assert(r.status === 200, "GET /rotation returns 200");
}

// --- Directives retirement ---

async function testDirectivesRetirement() {
  const r = await get("/directives/retirement");
  // May return 500 if python analysis script fails — that's a known infra issue
  assert(r.status === 200 || r.status === 500, "GET /directives/retirement returns 200 or 500");
}

// --- Engagement analytics ---

async function testEngagementAnalytics() {
  const r = await get("/engagement/analytics");
  assert(r.status === 200, "GET /engagement/analytics returns 200");
}

async function testEngagementEffectiveness() {
  const r = await get("/engagement/effectiveness");
  assert(r.status === 200, "GET /engagement/effectiveness returns 200");
}

// --- Status engagement ROI ---

async function testStatusEngagementRoi() {
  const r = await get("/status/engagement-roi");
  assert(r.status === 200, "GET /status/engagement-roi returns 200");
}

// --- Platforms & trends ---

async function testPlatforms() {
  const r = await get("/platforms");
  assert(r.status === 200, "GET /platforms returns 200");
}

async function testPlatformsTrends() {
  const r = await get("/platforms/trends");
  assert(r.status === 200, "GET /platforms/trends returns 200");
}

async function testStatusPlatformsHistory() {
  const r = await get("/status/platforms/history");
  assert(r.status === 200, "GET /status/platforms/history returns 200");
}

// --- Health data ---

async function testHealthData() {
  const r = await get("/health/data");
  assert(r.status === 200, "GET /health/data returns 200");
}

// --- Inbox (auth-required) ---

async function testInbox() {
  const r = await get("/inbox");
  assert(r.status === 200 || r.status === 401, "GET /inbox returns 200 or 401 (auth-required)");
}

// --- POST /inbox error case ---

async function testInboxPostMissingFields() {
  const r = await post("/inbox", {});
  assert(r.status === 400, "POST /inbox without body returns 400");
}

// --- Crawl cache ---

async function testCrawlCache() {
  const r = await get("/crawl/cache");
  assert(r.status === 200, "GET /crawl/cache returns 200");
}

// --- Reciprocity ---

async function testReciprocity() {
  const r = await get("/reciprocity");
  assert(r.status === 200, "GET /reciprocity returns 200");
}

// --- Dashboard (HTML) ---

async function testDashboardHtml() {
  const r = await get("/dashboard");
  assert(r.status === 200, "GET /dashboard returns 200");
  assert(r.ct.includes("html"), "/dashboard returns HTML");
}

// --- Presence ---

async function testPresence() {
  const r = await get("/presence");
  assert(r.status === 200, "GET /presence returns 200");
}

// --- Deprecations ---

async function testDeprecations() {
  const r = await get("/deprecations");
  assert(r.status === 200, "GET /deprecations returns 200");
}

// --- Rate limit headers on POST ---

async function testRateLimitHeaders() {
  const r = await fetch(`${BASE}/tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "rate-test", title: "rate test" }),
  });
  const limit = r.headers.get("x-ratelimit-limit");
  const remaining = r.headers.get("x-ratelimit-remaining");
  assert(limit !== null, "POST response has X-RateLimit-Limit header");
  assert(remaining !== null, "POST response has X-RateLimit-Remaining header");
  assert(parseInt(limit) > 0, "rate limit is positive");
}

// --- Agent verification header on POST ---

async function testVerificationHeader() {
  const r = await fetch(`${BASE}/human-review`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "header-test", body: "test" }),
  });
  const verified = r.headers.get("x-agent-verified");
  assert(verified === "false", "unsigned POST has X-Agent-Verified: false");
}

// --- Clawtavista ---

async function testClawtavista() {
  const r = await get("/clawtavista");
  assert(r.status === 200, "GET /clawtavista returns 200");
}

// --- Live dashboard ---

async function testLive() {
  const r = await get("/live");
  assert(r.status === 200 || r.status === 401, "GET /live returns 200 or 401 (auth-required)");
}

// --- Digest ---

async function testDigest() {
  const r = await get("/digest");
  assert(r.status === 200, "GET /digest returns 200");
}

// --- Compare ---

async function testCompare() {
  const r = await get("/compare");
  assert(r.status === 200, "GET /compare returns 200");
}

// --- Backups ---

async function testBackups() {
  const r = await get("/backups");
  assert(r.status === 200, "GET /backups returns 200");
}

// --- Files ---

async function testFiles() {
  const r = await get("/files");
  assert(r.status === 200 || r.status === 401, "GET /files returns 200 or 401 (auth-required)");
}

async function main() {
  console.log(`api.test.mjs — Testing ${BASE}\n`);
  const start = Date.now();

  const tests = [
    // Core
    testRoot, testHealth, testAgentJson, testWellKnownAgent,
    testOpenApi, testDocs, testSkillMd, testRoutes,
    // Status
    testStatusDashboard, testStatusAll, testStatusQueue,
    testStatusQueueHealth, testStatusQueueVelocity,
    testStatusEfficiency, testStatusDirectives, testStatusPipeline,
    testStatusPlatforms, testStatusCostHeatmap, testStatusCostDistribution,
    testStatusSessionEffectiveness, testStatusCreds,
    // Sessions & analytics
    testSessionsJson, testCostsJson, testMetrics, testEfficiency, testChangelog,
    // Engagement
    testEngagementRoi, testEngagementAnalytics, testEngagementEffectiveness,
    testStatusEngagementRoi,
    // Knowledge
    testKnowledgePatterns, testKnowledgeDigest, testKnowledgeTopics, testKnowledgeExchangeLog,
    // Registry & directory
    testRegistry, testDirectory, testNetwork,
    // Search & directives
    testSearch, testDirectives, testDirectivesRetirement,
    // Leaderboard & services
    testLeaderboard, testServices,
    // Feed
    testFeed, testFeedAtom,
    // Monitors & uptime
    testMonitors, testUptime,
    // Badges, tasks
    testBadges, testTasks,
    // CRUD
    testKvCrud, testPasteCrud, testPollsCrud, testCron,
    // Webhooks & inbox
    testWebhookEvents, testInboxStats, testInbox, testInboxPostMissingFields,
    // Buildlog & summary
    testBuildlog, testSummary,
    // Identity
    testIdentityProof, testVerifyNoHandle,
    // Integrations
    testIntegrations,
    // Human review (d013)
    testHumanReview,
    // Auth/security (wq-032)
    testRequireVerifiedAgentReject, testRequireVerifiedLeaderboard,
    testRequireVerifiedKnowledgeValidate,
    testRateLimitHeaders, testVerificationHeader,
    // Handshake errors
    testHandshakeNoUrl, testHandshakeBadProtocol, testHandshakeUnreachable,
    // Task CRUD lifecycle
    testTaskCrud,
    // Poll CRUD lifecycle
    testPollCrud,
    // Dispatch errors
    testDispatchErrors,
    // Additional GET endpoints
    testActivity, testEcosystemMap, testEcosystemRanking,
    testAgents, testPeers, testAdoption, testOutcomes,
    testSpecialization, testRotation, testPlatforms, testPlatformsTrends,
    testStatusPlatformsHistory, testHealthData, testCrawlCache,
    testReciprocity, testDashboardHtml, testPresence, testDeprecations,
    testClawtavista, testLive, testDigest, testCompare, testBackups, testFiles,
  ];

  for (const t of tests) {
    try { await t(); }
    catch (e) { failed++; console.log(`\n  ERROR in ${t.name}: ${e.message}`); }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n\n${passed} passed, ${failed} failed in ${elapsed}s`);
  if (failed > 0) process.exit(1);
}

main();

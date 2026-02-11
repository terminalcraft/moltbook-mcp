import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSpaFalsePositive, analyzeResults } from "./platform-probe.mjs";

// Helper to build mock probe results
function mockResult(path, { status = 200, contentType = "html", body = "", isSuccess = true } = {}) {
  return { path, url: `https://example.com${path}`, status, contentType, bodyPreview: body, hasContent: body.length > 0, isSuccess };
}

describe("isSpaFalsePositive", () => {
  it("detects SPA when all responses are HTML with SPA body patterns", () => {
    const results = [
      mockResult("/skill.md", { body: '<html><div id="root"></div><script src="/app.js"></script></html>' }),
      mockResult("/api", { body: '<html><div id="root"></div><script src="/app.js"></script></html>' }),
      mockResult("/api-docs", { body: '<html><div id="root"></div><script src="/app.js"></script></html>' }),
      mockResult("/health", { body: '<html><div id="root"></div><script src="/app.js"></script></html>' }),
      mockResult("/openapi.json", { body: '<html><div id="root"></div><script src="/app.js"></script></html>' }),
    ];
    assert.equal(isSpaFalsePositive(results), true);
  });

  it("detects SPA when API-specific paths return HTML", () => {
    const results = [
      mockResult("/skill.md", { body: '<html><body>Loading...</body></html>' }),
      mockResult("/api", { body: '<html><body>Loading...</body></html>' }),
      mockResult("/openapi.json", { body: '<html><body>Loading...</body></html>' }),
      mockResult("/health", { body: '<html><body>Loading...</body></html>' }),
    ];
    assert.equal(isSpaFalsePositive(results), true);
  });

  it("returns false when some responses are JSON (real API)", () => {
    const results = [
      mockResult("/skill.md", { contentType: "text", body: "# My Agent" }),
      mockResult("/api", { contentType: "json", body: '{"version":"1.0"}' }),
      mockResult("/health", { contentType: "json", body: '{"status":"ok"}' }),
      mockResult("/openapi.json", { contentType: "json", body: '{"openapi":"3.0"}' }),
    ];
    assert.equal(isSpaFalsePositive(results), false);
  });

  it("returns false when too few successes", () => {
    const results = [
      mockResult("/health", { body: '<html>ok</html>' }),
      mockResult("/api", { status: 404, isSuccess: false }),
    ];
    assert.equal(isSpaFalsePositive(results), false);
  });

  it("returns false when no successes", () => {
    const results = [
      mockResult("/health", { status: 0, isSuccess: false }),
      mockResult("/api", { status: 0, isSuccess: false }),
    ];
    assert.equal(isSpaFalsePositive(results), false);
  });
});

describe("analyzeResults with SPA detection", () => {
  it("sets spa_false_positive status for SPA sites", () => {
    const spaBody = '<html><head></head><body><div id="app"></div><script src="/bundle.js"></script></body></html>';
    const results = [
      mockResult("/skill.md", { body: spaBody }),
      mockResult("/api", { body: spaBody }),
      mockResult("/api-docs", { body: spaBody }),
      mockResult("/health", { body: spaBody }),
      mockResult("/openapi.json", { body: spaBody }),
    ];
    const analysis = analyzeResults(results);
    assert.equal(analysis.isSpa, true);
    assert.equal(analysis.recommendedStatus, "spa_false_positive");
    assert.equal(analysis.reachable, true);
  });

  it("sets live status for real API platforms", () => {
    const results = [
      mockResult("/health", { contentType: "json", body: '{"status":"ok"}' }),
      mockResult("/api", { contentType: "json", body: '{"version":"1"}' }),
      mockResult("/skill.md", { status: 404, isSuccess: false }),
      mockResult("/openapi.json", { status: 404, isSuccess: false }),
    ];
    const analysis = analyzeResults(results);
    assert.equal(analysis.isSpa, false);
    assert.equal(analysis.recommendedStatus, "live");
  });
});

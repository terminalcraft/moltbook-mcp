import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSpaFalsePositive, analyzeResults, computeContentTypeDiversity, detectFrameworks, checkVersionStaleness } from "./platform-probe.mjs";

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

describe("detectFrameworks", () => {
  it("detects React from __reactFiber markers", () => {
    const results = [
      mockResult("/", { body: '<div id="root" data-reactroot></div><script>window.__reactFiber$abc=1</script>' }),
    ];
    const detected = detectFrameworks(results);
    assert.ok(detected.some(f => f.framework === "react"), "should detect React");
  });

  it("detects Vue from __vue_app__ and data-v- attributes", () => {
    const results = [
      mockResult("/", { body: '<div id="app" data-v-3a2b1c __vue_app__></div>' }),
    ];
    const detected = detectFrameworks(results);
    assert.ok(detected.some(f => f.framework === "vue"), "should detect Vue");
  });

  it("detects Svelte from __svelte marker", () => {
    const results = [
      mockResult("/", { body: '<div class="svelte-abc123">hello</div><script>window.__svelte</script>' }),
    ];
    const detected = detectFrameworks(results);
    assert.ok(detected.some(f => f.framework === "svelte"), "should detect Svelte");
  });

  it("detects Next.js from __NEXT_DATA__", () => {
    const results = [
      mockResult("/", { body: '<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>' }),
    ];
    const detected = detectFrameworks(results);
    assert.ok(detected.some(f => f.framework === "nextjs"), "should detect Next.js");
  });

  it("detects Nuxt from __NUXT__", () => {
    const results = [
      mockResult("/", { body: '<script>window.__NUXT__={}</script>' }),
    ];
    const detected = detectFrameworks(results);
    assert.ok(detected.some(f => f.framework === "nuxt"), "should detect Nuxt");
  });

  it("detects Angular from ng-version attribute", () => {
    const results = [
      mockResult("/", { body: '<app-root ng-version="17.0.0" _nghost-abc></app-root>' }),
    ];
    const detected = detectFrameworks(results);
    assert.ok(detected.some(f => f.framework === "angular"), "should detect Angular");
  });

  it("returns empty array for plain HTML", () => {
    const results = [
      mockResult("/", { body: '<html><body><h1>Hello World</h1></body></html>' }),
    ];
    const detected = detectFrameworks(results);
    assert.equal(detected.length, 0);
  });

  it("extracts Angular version from ng-version attribute", () => {
    const results = [
      mockResult("/", { body: '<app-root ng-version="17.3.1" _nghost-abc></app-root>' }),
    ];
    const detected = detectFrameworks(results);
    const angular = detected.find(f => f.framework === "angular");
    assert.ok(angular, "should detect Angular");
    assert.equal(angular.version, "17.3.1");
  });

  it("extracts Next.js buildId from __NEXT_DATA__", () => {
    const results = [
      mockResult("/", { body: '<script id="__NEXT_DATA__" type="application/json">{"props":{},"buildId":"abc123xyz"}</script>' }),
    ];
    const detected = detectFrameworks(results);
    const nextjs = detected.find(f => f.framework === "nextjs");
    assert.ok(nextjs, "should detect Next.js");
    assert.equal(nextjs.version, "abc123xyz");
  });

  it("extracts generator from meta tag", () => {
    const results = [
      mockResult("/", { body: '<html><head><meta name="generator" content="Hugo 0.92.0"></head><body>Hello</body></html>' }),
    ];
    const detected = detectFrameworks(results);
    const gen = detected.find(f => f.framework === "generator");
    assert.ok(gen, "should detect generator");
    assert.equal(gen.version, "Hugo 0.92.0");
  });

  it("does not add generator entry when framework already detected", () => {
    const results = [
      mockResult("/", { body: '<div data-reactroot></div><meta name="generator" content="react app">' }),
    ];
    const detected = detectFrameworks(results);
    assert.ok(!detected.some(f => f.framework === "generator"), "should not duplicate react as generator");
  });

  it("returns no version when version pattern not present", () => {
    const results = [
      mockResult("/", { body: '<div __vue_app__></div>' }),
    ];
    const detected = detectFrameworks(results);
    const vue = detected.find(f => f.framework === "vue");
    assert.ok(vue, "should detect Vue");
    assert.equal(vue.version, undefined);
  });

  it("returns empty array when no successful results", () => {
    const results = [
      mockResult("/", { status: 500, isSuccess: false, body: '' }),
    ];
    const detected = detectFrameworks(results);
    assert.equal(detected.length, 0);
  });

  it("detects multiple frameworks across different responses", () => {
    const results = [
      mockResult("/app1", { body: '<div data-reactroot></div>' }),
      mockResult("/app2", { body: '<div data-v-abc123></div>' }),
    ];
    const detected = detectFrameworks(results);
    assert.ok(detected.length >= 2, `expected >=2 frameworks, got ${detected.length}`);
  });

  it("reports signal count per framework", () => {
    const results = [
      mockResult("/", { body: '<div __reactFiber$x data-reactroot __reactProps$y></div>' }),
    ];
    const detected = detectFrameworks(results);
    const react = detected.find(f => f.framework === "react");
    assert.ok(react, "should detect React");
    assert.ok(react.signals >= 2, `expected >=2 signals, got ${react.signals}`);
  });
});

describe("isSpaFalsePositive with framework detection", () => {
  it("detects SPA when framework markers present but no classic SPA patterns", () => {
    // No id="root", no <script src=, no window.__ — but has __vue_app__
    const results = [
      mockResult("/api", { body: '<html><div __vue_app__>Content</div></html>' }),
      mockResult("/health", { body: '<html><div __vue_app__>Content</div></html>' }),
      mockResult("/docs", { body: '<html><div __vue_app__>Content</div></html>' }),
    ];
    assert.equal(isSpaFalsePositive(results), true);
  });
});

describe("analyzeResults with framework hints", () => {
  it("includes frameworkHints in analysis for SPA sites", () => {
    const spaBody = '<html><div id="root" data-reactroot></div><script src="/app.js"></script></html>';
    const results = [
      mockResult("/skill.md", { body: spaBody }),
      mockResult("/api", { body: spaBody }),
      mockResult("/api-docs", { body: spaBody }),
      mockResult("/health", { body: spaBody }),
      mockResult("/openapi.json", { body: spaBody }),
    ];
    const analysis = analyzeResults(results);
    assert.equal(analysis.isSpa, true);
    assert.ok(analysis.frameworkHints.length > 0, "should detect React framework");
    assert.ok(analysis.frameworkHints.some(f => f.framework === "react"));
    assert.ok(analysis.findings.some(f => f.includes("Framework detected")));
  });

  it("includes frameworkHints even for non-SPA sites", () => {
    const results = [
      mockResult("/health", { contentType: "json", body: '{"status":"ok"}' }),
      mockResult("/api", { contentType: "json", body: '{"version":"1"}' }),
      mockResult("/skill.md", { contentType: "text", body: "# Agent\ndata-reactroot marker in docs" }),
    ];
    const analysis = analyzeResults(results);
    assert.equal(analysis.isSpa, false);
    assert.ok(Array.isArray(analysis.frameworkHints));
  });
});

describe("computeContentTypeDiversity", () => {
  it("returns 0 for uniform content types", () => {
    const results = [
      mockResult("/api", { contentType: "html" }),
      mockResult("/health", { contentType: "html" }),
      mockResult("/docs", { contentType: "html" }),
    ];
    const d = computeContentTypeDiversity(results);
    assert.equal(d.score, 0);
    assert.deepEqual(d.types, { html: 3 });
    assert.equal(d.total, 3);
  });

  it("returns 1 for perfectly diverse types", () => {
    const results = [
      mockResult("/health", { contentType: "json" }),
      mockResult("/skill.md", { contentType: "text" }),
    ];
    const d = computeContentTypeDiversity(results);
    assert.equal(d.score, 1);
    assert.deepEqual(d.types, { json: 1, text: 1 });
  });

  it("returns intermediate score for mixed types", () => {
    const results = [
      mockResult("/api", { contentType: "json" }),
      mockResult("/docs", { contentType: "html" }),
      mockResult("/health", { contentType: "json" }),
      mockResult("/skill.md", { contentType: "text" }),
    ];
    const d = computeContentTypeDiversity(results);
    assert.ok(d.score > 0 && d.score < 1, `Expected 0 < ${d.score} < 1`);
    assert.equal(d.total, 4);
  });

  it("returns 0 for fewer than 2 results", () => {
    const results = [mockResult("/health", { contentType: "json" })];
    const d = computeContentTypeDiversity(results);
    assert.equal(d.score, 0);
  });

  it("excludes non-success results", () => {
    const results = [
      mockResult("/health", { contentType: "json" }),
      mockResult("/api", { contentType: "html", isSuccess: false, status: 404 }),
    ];
    const d = computeContentTypeDiversity(results);
    assert.equal(d.score, 0);
    assert.equal(d.total, 1);
  });

  it("is included in analyzeResults output", () => {
    const results = [
      mockResult("/health", { contentType: "json", body: '{"status":"ok"}' }),
      mockResult("/api", { contentType: "json", body: '{"version":"1"}' }),
      mockResult("/skill.md", { status: 404, isSuccess: false }),
    ];
    const analysis = analyzeResults(results);
    assert.ok(analysis.contentTypeDiversity, "analysis should include contentTypeDiversity");
    assert.equal(analysis.contentTypeDiversity.score, 0); // all json
  });
});

describe("checkVersionStaleness", () => {
  it("flags EOL framework versions", () => {
    const hints = [{ framework: "angular", signals: 2, version: "14.2.1" }];
    const alerts = checkVersionStaleness(hints);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, "eol");
    assert.equal(alerts[0].framework, "angular");
    assert.equal(alerts[0].detectedMajor, 14);
  });

  it("flags outdated but not EOL versions", () => {
    const hints = [{ framework: "angular", signals: 2, version: "17.1.0" }];
    const alerts = checkVersionStaleness(hints);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, "outdated");
  });

  it("returns no alerts for current versions", () => {
    const hints = [{ framework: "angular", signals: 2, version: "19.0.1" }];
    const alerts = checkVersionStaleness(hints);
    assert.equal(alerts.length, 0);
  });

  it("skips frameworks without version info", () => {
    const hints = [{ framework: "react", signals: 1 }];
    const alerts = checkVersionStaleness(hints);
    assert.equal(alerts.length, 0);
  });

  it("skips generator entries", () => {
    const hints = [{ framework: "generator", signals: 1, version: "WordPress 5.0" }];
    const alerts = checkVersionStaleness(hints);
    assert.equal(alerts.length, 0);
  });

  it("handles unknown frameworks gracefully", () => {
    const hints = [{ framework: "ember", signals: 1, version: "4.0" }];
    const alerts = checkVersionStaleness(hints);
    assert.equal(alerts.length, 0);
  });

  it("integrates into analyzeResults", () => {
    const results = [
      mockResult("/", { body: '<div ng-version="12.0.5" _nghost-abc></div>' }),
    ];
    const analysis = analyzeResults(results);
    assert.ok(analysis.versionAlerts.length > 0, "should have version alerts");
    assert.equal(analysis.versionAlerts[0].severity, "eol");
    assert.ok(analysis.findings.some(f => f.includes("Version alert")), "findings should include version alert");
  });
});

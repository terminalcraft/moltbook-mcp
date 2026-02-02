#!/usr/bin/env node
/**
 * service-evaluator.mjs — Automated deep-dive evaluation of a service URL.
 *
 * Usage:
 *   node service-evaluator.mjs <url>              # Full evaluation, human-readable
 *   node service-evaluator.mjs <url> --json       # Machine-readable JSON output
 *   node service-evaluator.mjs <url> --register   # Also attempt registration
 *
 * Returns a structured report: reachability, page info, API discovery,
 * activity signals, registration attempt (if --register).
 */

import { execSync } from "child_process";

const TIMEOUT_MS = 10000;
const CURL_TIMEOUT = 8;

// --- Helpers ---

function curl(url, opts = {}) {
  const args = [
    "-s", "-L",
    "--max-time", String(opts.timeout || CURL_TIMEOUT),
    "--max-redirs", "5",
    "-A", "moltbook-evaluator/1.0",
  ];
  if (opts.headOnly) args.push("-I");
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      args.push("-H", `${k}: ${v}`);
    }
  }
  args.push(url);
  try {
    return execSync(`curl ${args.map(a => JSON.stringify(a)).join(" ")}`, {
      timeout: (opts.timeout || CURL_TIMEOUT) * 1500,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function curlStatus(url) {
  try {
    const code = execSync(
      `curl -s -o /dev/null -w "%{http_code}" -L --max-time ${CURL_TIMEOUT} --max-redirs 5 -A "moltbook-evaluator/1.0" ${JSON.stringify(url)}`,
      { timeout: CURL_TIMEOUT * 1500, encoding: "utf8" }
    ).trim();
    return parseInt(code, 10);
  } catch {
    return 0;
  }
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim().slice(0, 200) : null;
}

function extractMeta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i");
  const m = html.match(re);
  return m ? m[1].trim().slice(0, 300) : null;
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    links.push(m[1]);
  }
  return links;
}

// --- Evaluation Steps ---

function evaluateReachability(url) {
  const status = curlStatus(url);
  return {
    url,
    http_status: status,
    reachable: status >= 200 && status < 400,
    redirect: status >= 300 && status < 400,
  };
}

function evaluatePage(url) {
  const html = curl(url);
  if (!html) return { error: "Could not fetch page" };

  const title = extractTitle(html);
  const description = extractMeta(html, "description") || extractMeta(html, "og:description");
  const links = extractLinks(html, url);
  const hasLogin = /login|sign.?in|auth/i.test(html);
  const hasSignup = /sign.?up|register|create.?account|join/i.test(html);
  const hasAPI = /\/api|swagger|openapi|graphql|rest/i.test(html);
  const hasDocs = /docs|documentation|getting.?started/i.test(html);
  const frameworks = [];
  if (/react/i.test(html)) frameworks.push("react");
  if (/next/i.test(html) || /__next/i.test(html)) frameworks.push("next.js");
  if (/vue/i.test(html)) frameworks.push("vue");
  if (/svelte/i.test(html)) frameworks.push("svelte");

  return {
    title,
    description,
    link_count: links.length,
    signals: { hasLogin, hasSignup, hasAPI, hasDocs },
    frameworks,
    html_size: html.length,
  };
}

function discoverAPIs(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");
  const candidates = [
    "/api", "/api/v1", "/api/v2", "/v1", "/v2",
    "/api/health", "/health", "/healthz", "/status",
    "/api/docs", "/docs", "/swagger.json", "/openapi.json",
    "/api/agents", "/api/services", "/api/users",
    "/.well-known/openid-configuration",
    "/agent.json", "/manifest.json", "/robots.txt",
  ];

  const results = [];
  for (const path of candidates) {
    const url = base + path;
    const status = curlStatus(url);
    if (status >= 200 && status < 400) {
      results.push({ path, status });
    }
  }
  return results;
}

function checkActivity(baseUrl, pageHtmlSize) {
  const signals = [];

  // Try to fetch robots.txt for sitemap hints
  const robots = curl(baseUrl.replace(/\/$/, "") + "/robots.txt");
  if (robots && robots.length > 10) {
    signals.push({ type: "robots.txt", present: true, size: robots.length });
  }

  // Try common feed/activity endpoints
  const activityPaths = ["/api/posts", "/api/feed", "/api/recent", "/api/activity", "/feed", "/rss", "/atom.xml"];
  const base = baseUrl.replace(/\/$/, "");
  const seenSizes = new Set();
  if (robots) seenSizes.add(robots.length);
  if (pageHtmlSize) seenSizes.add(pageHtmlSize); // Dedupe SPA catch-all responses
  for (const path of activityPaths) {
    const body = curl(base + path);
    if (body && body.length > 50 && !seenSizes.has(body.length)) {
      seenSizes.add(body.length);
      // Check for timestamps in the response
      const timestamps = body.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g) || [];
      const recent = timestamps.filter(t => {
        const d = new Date(t);
        const age = Date.now() - d.getTime();
        return age < 7 * 24 * 3600 * 1000; // within 7 days
      });
      signals.push({
        type: "feed",
        path,
        size: body.length,
        timestamp_count: timestamps.length,
        recent_timestamps: recent.length,
      });
    }
  }

  return signals;
}

function attemptRegistration(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");
  const regPaths = ["/api/register", "/api/signup", "/api/auth/register", "/register", "/api/users"];

  for (const path of regPaths) {
    // First check if the endpoint exists with OPTIONS/GET
    const status = curlStatus(base + path);
    if (status === 0 || status >= 500) continue;

    // Try POST with a test payload
    const handle = `moltbook_eval_${Date.now().toString(36)}`;
    const payload = JSON.stringify({ username: handle, handle, name: "moltbook-evaluator" });
    try {
      const resp = execSync(
        `curl -s -w "\\n%{http_code}" -X POST -H "Content-Type: application/json" -d ${JSON.stringify(payload)} --max-time ${CURL_TIMEOUT} ${JSON.stringify(base + path)}`,
        { timeout: CURL_TIMEOUT * 1500, encoding: "utf8" }
      );
      const lines = resp.trim().split("\n");
      const httpCode = parseInt(lines.pop(), 10);
      const body = lines.join("\n");

      return {
        path,
        http_status: httpCode,
        success: httpCode >= 200 && httpCode < 300,
        response_preview: body.slice(0, 500),
      };
    } catch {
      continue;
    }
  }

  return { attempted: true, found_endpoint: false };
}

// --- Main ---

async function evaluate(url, opts = {}) {
  const report = {
    url,
    evaluated_at: new Date().toISOString(),
    reachability: null,
    page: null,
    api_discovery: null,
    activity: null,
    registration: null,
    summary: {},
  };

  // Step 1: Reachability
  report.reachability = evaluateReachability(url);
  if (!report.reachability.reachable) {
    report.summary = { verdict: "unreachable", score: 0 };
    return report;
  }

  // Step 2: Page analysis
  report.page = evaluatePage(url);

  // Step 3: API discovery
  report.api_discovery = discoverAPIs(url);

  // Step 4: Activity check
  report.activity = checkActivity(url, report.page?.html_size);

  // Step 5: Registration (if requested)
  if (opts.register) {
    report.registration = attemptRegistration(url);
  }

  // Scoring
  let score = 1; // reachable = 1
  if (report.page.title) score += 1;
  if (report.api_discovery.length > 2) score += 2;
  else if (report.api_discovery.length > 0) score += 1;
  if (report.activity.some(a => a.recent_timestamps > 0)) score += 2;
  else if (report.activity.length > 0) score += 1;
  if (report.page.signals?.hasAPI) score += 1;
  if (report.page.signals?.hasDocs) score += 1;

  let verdict = "dead";
  if (score >= 7) verdict = "active_with_api";
  else if (score >= 5) verdict = "active";
  else if (score >= 3) verdict = "basic";
  else if (score >= 1) verdict = "minimal";

  report.summary = { verdict, score, max_score: 9 };
  return report;
}

// --- CLI ---

const urlArg = process.argv[2];
if (!urlArg || urlArg === "--help") {
  console.log("Usage: node service-evaluator.mjs <url> [--json] [--register]");
  process.exit(0);
}

const jsonMode = process.argv.includes("--json");
const registerMode = process.argv.includes("--register");

const report = await evaluate(urlArg, { register: registerMode });

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  // Human-readable output
  console.log(`\nService Evaluation: ${report.url}`);
  console.log("=".repeat(60));

  const r = report.reachability;
  console.log(`\nReachability: ${r.reachable ? "✓" : "✗"} (HTTP ${r.http_status})`);

  if (report.page) {
    const p = report.page;
    if (p.error) {
      console.log(`Page: ${p.error}`);
    } else {
      console.log(`Title: ${p.title || "(none)"}`);
      if (p.description) console.log(`Description: ${p.description}`);
      console.log(`Links: ${p.link_count} | Size: ${(p.html_size / 1024).toFixed(1)}KB`);
      const sigs = Object.entries(p.signals).filter(([, v]) => v).map(([k]) => k);
      if (sigs.length) console.log(`Signals: ${sigs.join(", ")}`);
      if (p.frameworks.length) console.log(`Frameworks: ${p.frameworks.join(", ")}`);
    }
  }

  if (report.api_discovery?.length) {
    console.log(`\nAPI Endpoints Found (${report.api_discovery.length}):`);
    for (const ep of report.api_discovery) {
      console.log(`  ${ep.status} ${ep.path}`);
    }
  } else {
    console.log("\nNo API endpoints found.");
  }

  if (report.activity?.length) {
    console.log(`\nActivity Signals:`);
    for (const sig of report.activity) {
      if (sig.type === "feed") {
        console.log(`  ${sig.path}: ${sig.size}B, ${sig.recent_timestamps}/${sig.timestamp_count} recent timestamps`);
      } else {
        console.log(`  ${sig.type}: present (${sig.size}B)`);
      }
    }
  } else {
    console.log("\nNo activity signals detected.");
  }

  if (report.registration) {
    const reg = report.registration;
    if (reg.found_endpoint === false) {
      console.log("\nRegistration: no endpoint found");
    } else {
      console.log(`\nRegistration: ${reg.success ? "✓ success" : "✗ failed"} at ${reg.path} (${reg.http_status})`);
      if (reg.response_preview) console.log(`  Response: ${reg.response_preview.slice(0, 200)}`);
    }
  }

  console.log(`\nVerdict: ${report.summary.verdict} (${report.summary.score}/${report.summary.max_score})`);
}

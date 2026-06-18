#!/usr/bin/env node
/**
 * platform-probe.mjs — Probe needs_probe platforms for API docs and registration (d051)
 *
 * When platform-picker returns a needs_probe platform, E sessions run this script to:
 * 1. Probe for API docs (/skill.md, /api, /docs, /.well-known/ai-plugin.json)
 * 2. Attempt registration if open
 * 3. Update account-registry with findings (auth_type, status, test endpoint)
 *
 * Usage:
 *   node platform-probe.mjs <platform-id>           # Probe a specific platform
 *   node platform-probe.mjs <platform-id> --json    # JSON output
 *   node platform-probe.mjs --list                  # List all needs_probe platforms
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import https from "https";
import http from "http";
import { monitorProbe, snapshotRegistryEntry } from "./probe-side-effect-monitor.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, "account-registry.json");
const SERVICES_PATH = join(__dirname, "services.json");
const FRAMEWORK_VERSIONS_PATH = join(__dirname, "framework-versions.json");
const STATE_DIR = join(process.env.HOME || "/home/moltbot", ".config/moltbook");
const LOG_PATH = join(STATE_DIR, "logs", "platform-probes.log");

// Standard discovery endpoints to probe (d051 spec)
const DISCOVERY_ENDPOINTS = [
  "/skill.md",
  "/api",
  "/api-docs",
  "/docs",
  "/.well-known/ai-plugin.json",
  "/.well-known/agent-info.json",
  "/openapi.json",
  "/health",
  "/api/register",
  "/api/v1/agents/register",
  "/register",
];

function loadJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
}

function saveJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function log(message) {
  const entry = `${new Date().toISOString()} ${message}\n`;
  try {
    const logDir = dirname(LOG_PATH);
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    appendFileSync(LOG_PATH, entry);
  } catch { /* logging failure is not fatal */ }
}

// HTTP/HTTPS fetch with timeout and redirect handling
function fetchURL(url, timeout = 10000, maxRedirects = 3) {
  return new Promise((resolve) => {
    const doFetch = (targetUrl, redirectsLeft) => {
      const proto = targetUrl.startsWith("https") ? https : http;
      const req = proto.get(targetUrl, { timeout }, (res) => {
        // Handle redirects (301, 302, 307, 308)
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          let redirectUrl = res.headers.location;
          // Handle relative URLs
          if (redirectUrl.startsWith("/")) {
            const urlObj = new URL(targetUrl);
            redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
          }
          doFetch(redirectUrl, redirectsLeft - 1);
          return;
        }
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers, finalUrl: targetUrl }));
      });
      req.on("error", (e) => resolve({ status: null, error: e.message }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ status: null, error: "timeout" });
      });
      req.setTimeout(timeout, () => {
        req.destroy();
        resolve({ status: null, error: "socket timeout" });
      });
    };
    doFetch(url, maxRedirects);
  });
}

// Probe a single endpoint
async function probeEndpoint(baseUrl, path) {
  const url = baseUrl.replace(/\/$/, "") + path;
  const result = await fetchURL(url);

  // Determine content type
  let contentType = "unknown";
  if (result.headers?.["content-type"]) {
    const ct = result.headers["content-type"].toLowerCase();
    if (ct.includes("json")) contentType = "json";
    else if (ct.includes("markdown") || ct.includes("text/plain")) contentType = "text";
    else if (ct.includes("html")) contentType = "html";
  }

  const out = {
    path,
    url,
    status: result.status,
    error: result.error || null,
    contentType,
    bodyPreview: result.body?.substring(0, 500) || null,
    hasContent: result.body?.length > 0,
    isSuccess: result.status >= 200 && result.status < 300,
  };

  // Preserve full body for skill.md so we can compute accurate hash
  if (path === "/skill.md" && result.body) {
    out._fullBody = result.body;
  }

  return out;
}

// Compute SHA-256 hash of content
function computeSha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Detect frontend frameworks from compiled output patterns in HTML body previews.
// Modern frameworks (React, Vue, Svelte, Angular, Next.js, Nuxt) compile away event
// handlers, so DOM selector scanning misses them. This checks for framework-specific
// runtime markers that appear in compiled bundles and hydrated HTML.
const FRAMEWORK_PATTERNS = [
  { name: "react", patterns: [/__reactFiber/i, /__reactProps/i, /_reactRootContainer/i, /data-reactroot/i, /data-reactid/i] },
  { name: "vue", patterns: [/__vue_app__/i, /__VUE__/, /data-v-[a-f0-9]/i] },
  { name: "svelte", patterns: [/__svelte/i, /\bSvelteComponent\b/, /create_fragment/] },
  { name: "nextjs", patterns: [/__NEXT_DATA__/, /_next\/static/] },
  { name: "nuxt", patterns: [/__NUXT__/, /_nuxt\//] },
  { name: "angular", patterns: [/ng-version=/, /_nghost-/, /_ngcontent-/, /ng-app/i] },
];

// Version extraction patterns — regexes with a capture group for the version string.
// Each extractor is keyed by framework name; "generic" applies to any site.
const VERSION_EXTRACTORS = [
  { framework: "angular", pattern: /ng-version="([^"]+)"/i },
  { framework: "nextjs", pattern: /"buildId"\s*:\s*"([^"]+)"/ },
  { framework: "nuxt", pattern: /nuxt[/]([0-9][0-9.]+)/ },
  // React: CDN URLs (unpkg/cdnjs/jsdelivr) embed the version, e.g. react@18.2.0 or react/18.2.0
  { framework: "react", pattern: /react(?:\.production\.min|\.development)?(?:@|[/])(\d+\.\d+\.\d+)/i },
  // Vue: __VUE__.version or Vue.version exposed at runtime; CDN URLs embed version
  { framework: "vue", pattern: /__VUE__[^}]*?version\s*(?::|=)\s*["'](\d+\.\d+\.\d+)["']/i },
  { framework: "vue", pattern: /vue(?:\.global|\.esm-browser|\.runtime\.global)?(?:\.prod|\.min)?(?:@|[/])(\d+\.\d+\.\d+)/i },
  { framework: "generic", pattern: /<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/i },
  { framework: "generic", pattern: /<meta\s+content=["']([^"']+)["']\s+name=["']generator["']/i },
];

function detectFrameworks(results) {
  const detected = [];
  const successes = results.filter(r => r.isSuccess && r.bodyPreview);
  if (successes.length === 0) return detected;

  // Concatenate all body previews for scanning
  const combined = successes.map(r => r.bodyPreview).join("\n");

  for (const fw of FRAMEWORK_PATTERNS) {
    const matched = fw.patterns.filter(p => p.test(combined));
    if (matched.length > 0) {
      const entry = { framework: fw.name, signals: matched.length };
      // Try to extract version for this framework (try all matching extractors)
      for (const extractor of VERSION_EXTRACTORS.filter(e => e.framework === fw.name)) {
        const m = combined.match(extractor.pattern);
        if (m) { entry.version = m[1]; break; }
      }
      detected.push(entry);
    }
  }

  // Check generic extractors (meta[name=generator]) — adds a standalone entry
  // only if no framework-specific match already captured it
  for (const ext of VERSION_EXTRACTORS.filter(e => e.framework === "generic")) {
    const m = combined.match(ext.pattern);
    if (m) {
      // Avoid duplicate if a detected framework already covers this
      if (!detected.some(d => m[1].toLowerCase().includes(d.framework))) {
        detected.push({ framework: "generator", signals: 1, version: m[1] });
      }
      break; // one generator match is enough
    }
  }

  return detected;
}

// Check detected framework versions against known-latest for staleness alerts (wq-1079).
// Returns array of { framework, detected, latest, severity, message }.
function checkVersionStaleness(frameworkHints) {
  const alerts = [];
  let versions;
  try {
    versions = JSON.parse(readFileSync(FRAMEWORK_VERSIONS_PATH, "utf8")).frameworks;
  } catch {
    return alerts; // no lookup table — skip silently
  }

  for (const hint of frameworkHints) {
    if (!hint.version || hint.framework === "generator") continue;
    const info = versions[hint.framework];
    if (!info) continue;

    // Extract major version number from detected version string
    const majorMatch = hint.version.match(/^(\d+)/);
    if (!majorMatch) continue;
    const detectedMajor = parseInt(majorMatch[1], 10);

    if (info.eolMajors && info.eolMajors.includes(detectedMajor)) {
      alerts.push({
        framework: hint.framework,
        detected: hint.version,
        detectedMajor,
        latestStable: info.latestStable,
        severity: "eol",
        message: `${hint.framework}@${hint.version} is EOL (latest: ${info.latestStable})`,
      });
    } else if (detectedMajor < info.latestMajor) {
      alerts.push({
        framework: hint.framework,
        detected: hint.version,
        detectedMajor,
        latestStable: info.latestStable,
        severity: "outdated",
        message: `${hint.framework}@${hint.version} is outdated (latest: ${info.latestStable})`,
      });
    }
  }

  return alerts;
}

// Detect SPA false positives: sites that return 200 on every path with HTML content
// SPA catch-all routing serves the same HTML shell for any URL, faking endpoint presence
function isSpaFalsePositive(results) {
  const successes = results.filter(r => r.isSuccess);
  if (successes.length < 3) return false; // Too few responses to judge

  // If every successful response is HTML, likely an SPA catch-all
  const allHtml = successes.every(r => r.contentType === "html");
  if (!allHtml) return false;

  // Check body preview for SPA signatures (bundled JS apps)
  const spaPatterns = /id=["'](root|app|__next|__nuxt)["']|<script\s+src=|window\.__/i;
  const bodiesMatch = successes.filter(r => r.bodyPreview && spaPatterns.test(r.bodyPreview));
  if (bodiesMatch.length > 0) return true;

  // Framework-compiled output detection (wq-1071): React/Vue/Svelte/Angular compile
  // away event handlers so DOM selectors miss them. Check for runtime markers.
  const frameworks = detectFrameworks(successes);
  if (frameworks.length > 0) return true;

  // API-specific paths (.json, .md) returning HTML is a strong SPA signal
  const apiPaths = successes.filter(r =>
    r.path.endsWith(".json") || r.path.endsWith(".md") || r.path.includes("api")
  );
  if (apiPaths.length >= 2) return true;

  return false;
}

// Compute content-type diversity index (Shannon entropy normalized to 0-1)
// Real APIs: mixed types (json, text, html) → high diversity (>0.5)
// SPAs: uniform html → low diversity (0)
function computeContentTypeDiversity(results) {
  const successes = results.filter(r => r.isSuccess && r.contentType);
  if (successes.length < 2) return { score: 0, types: {}, total: successes.length };

  // Count content types
  const counts = {};
  for (const r of successes) {
    counts[r.contentType] = (counts[r.contentType] || 0) + 1;
  }

  const n = successes.length;
  const typeCount = Object.keys(counts).length;

  // Shannon entropy: H = -Σ(p * ln(p))
  // Normalized by ln(typeCount) when typeCount > 1, else 0
  if (typeCount <= 1) return { score: 0, types: counts, total: n };

  let entropy = 0;
  for (const c of Object.values(counts)) {
    const p = c / n;
    if (p > 0) entropy -= p * Math.log(p);
  }
  const maxEntropy = Math.log(typeCount);
  const score = Math.round((entropy / maxEntropy) * 100) / 100;

  return { score, types: counts, total: n };
}

// Analyze probe results to determine platform capabilities
function analyzeResults(results) {
  const analysis = {
    reachable: false,
    hasSkillMd: false,
    skillMdHash: null,
    hasApiDocs: false,
    hasOpenAPI: false,
    hasWellKnown: false,
    hasHealthEndpoint: false,
    hasRegistration: false,
    isSpa: false,
    frameworkHints: [],
    versionAlerts: [],
    contentTypeDiversity: null,
    authType: "unknown",
    recommendedStatus: "unreachable",
    findings: [],
  };

  // Check if any endpoint returned success
  const successes = results.filter(r => r.isSuccess);
  if (successes.length > 0) {
    analysis.reachable = true;
    analysis.recommendedStatus = "live";
  }

  // Compute content-type diversity
  analysis.contentTypeDiversity = computeContentTypeDiversity(results);

  // Framework detection (wq-1071) — always run, even for non-SPA sites
  analysis.frameworkHints = detectFrameworks(results);

  // Version staleness alerting (wq-1079) — compare detected versions against known-latest
  analysis.versionAlerts = checkVersionStaleness(analysis.frameworkHints);
  for (const alert of analysis.versionAlerts) {
    analysis.findings.push(`Version alert [${alert.severity}]: ${alert.message}`);
  }

  // SPA detection gate — check before endpoint analysis
  if (analysis.reachable && isSpaFalsePositive(results)) {
    analysis.isSpa = true;
    analysis.recommendedStatus = "spa_false_positive";
    analysis.findings.push("SPA false positive: all endpoints return HTML (catch-all routing)");
    if (analysis.frameworkHints.length > 0) {
      const fwNames = analysis.frameworkHints.map(f => f.version ? `${f.framework}@${f.version}` : f.framework).join(", ");
      analysis.findings.push(`Framework detected: ${fwNames}`);
    }
    analysis.findings.push(`Content-type diversity: ${analysis.contentTypeDiversity.score} (low = uniform)`);
    return analysis;
  }

  // Check specific endpoints
  for (const r of results) {
    if (!r.isSuccess) continue;

    if (r.path === "/skill.md") {
      analysis.hasSkillMd = true;
      if (r.bodyPreview) {
        // Use full body content from the result for hashing
        const fullBody = r._fullBody || r.bodyPreview;
        analysis.skillMdHash = computeSha256(fullBody);
        analysis.findings.push(`skill.md found (sha256: ${analysis.skillMdHash.substring(0, 12)}...)`);
      } else {
        analysis.findings.push("skill.md found - agent capability manifest");
      }
    }
    if (["/api", "/api-docs", "/docs"].includes(r.path)) {
      analysis.hasApiDocs = true;
      analysis.findings.push(`API docs found at ${r.path}`);
    }
    if (r.path === "/openapi.json") {
      analysis.hasOpenAPI = true;
      analysis.findings.push("OpenAPI spec found");
    }
    if (r.path.includes(".well-known")) {
      analysis.hasWellKnown = true;
      analysis.findings.push(`Well-known endpoint found: ${r.path}`);
    }
    if (r.path === "/health") {
      analysis.hasHealthEndpoint = true;
      analysis.findings.push("Health endpoint found");
    }
    if (r.path.includes("register")) {
      analysis.hasRegistration = true;
      analysis.findings.push(`Registration endpoint found: ${r.path}`);

      // Check if registration requires auth
      if (r.bodyPreview?.toLowerCase().includes("api_key") ||
          r.bodyPreview?.toLowerCase().includes("authorization")) {
        analysis.authType = "api_key";
      } else if (r.bodyPreview?.toLowerCase().includes("open") ||
                 r.bodyPreview?.toLowerCase().includes("public")) {
        analysis.authType = "none";
      }
    }
  }

  // Determine recommended status based on findings
  if (!analysis.reachable) {
    analysis.recommendedStatus = "unreachable";
  } else if (analysis.hasSkillMd || analysis.hasApiDocs || analysis.hasOpenAPI) {
    analysis.recommendedStatus = "live";
    analysis.authType = analysis.authType === "unknown" ? "api_key" : analysis.authType;
  } else if (analysis.hasHealthEndpoint) {
    analysis.recommendedStatus = "live";
  } else {
    // Reachable but no API endpoints found
    analysis.recommendedStatus = "live";
    analysis.findings.push("Reachable but no standard API endpoints found");
  }

  // Add diversity score to findings for visibility
  if (analysis.contentTypeDiversity && analysis.contentTypeDiversity.total >= 2) {
    const d = analysis.contentTypeDiversity;
    const label = d.score >= 0.5 ? "high" : d.score > 0 ? "mixed" : "uniform";
    analysis.findings.push(`Content-type diversity: ${d.score} (${label}) — ${JSON.stringify(d.types)}`);
  }

  return analysis;
}

// Update account-registry with probe findings
function updateRegistry(platformId, analysis, probeResults) {
  const registry = loadJSON(REGISTRY_PATH);
  if (!registry?.accounts) {
    return { error: "Could not load account-registry.json" };
  }

  const acc = registry.accounts.find(a => a.id === platformId);
  if (!acc) {
    return { error: `Platform ${platformId} not found in registry` };
  }

  const session = process.env.SESSION_NUM || "?";
  const timestamp = new Date().toISOString();

  // Update account entry
  acc.last_status = analysis.recommendedStatus;
  acc.last_tested = timestamp;
  acc.auth_type = analysis.authType;

  // Store/verify skill.md hash for supply-chain tamper detection
  if (analysis.skillMdHash) {
    const previousHash = acc.skill_hash || null;
    if (previousHash && previousHash !== analysis.skillMdHash) {
      // Hash changed — potential supply-chain tamper
      const warning = `SKILL_HASH_CHANGED s${session}: ${previousHash.substring(0, 12)}→${analysis.skillMdHash.substring(0, 12)}`;
      log(`WARNING ${platformId}: ${warning}`);
      analysis.findings.push(`WARNING: skill.md hash changed from previous probe`);
      acc.skill_hash_changed = timestamp;
    }
    acc.skill_hash = analysis.skillMdHash;
    acc.skill_hash_checked = timestamp;
  }

  // Update test endpoint if we found a health/api endpoint
  const healthResult = probeResults.find(r => r.isSuccess && r.path === "/health");
  const apiResult = probeResults.find(r => r.isSuccess && ["/api", "/api-docs"].includes(r.path));
  if (healthResult) {
    acc.test = { method: "http", url: healthResult.url, auth: "none", expect: "status_2xx" };
  } else if (apiResult) {
    acc.test = { method: "http", url: apiResult.url, auth: "none", expect: "status_2xx" };
  }

  // Update notes with probe findings
  const oldNotes = acc.notes || "";
  const findingsSummary = analysis.findings.slice(0, 3).join("; ");
  acc.notes = `Probed s${session}: ${analysis.recommendedStatus}. ${findingsSummary}${oldNotes ? `. Prev: ${oldNotes.substring(0, 100)}` : ""}`;

  saveJSON(REGISTRY_PATH, registry);
  log(`${platformId}: probed by s${session}, status=${analysis.recommendedStatus}, findings=${analysis.findings.length}`);

  return { success: true, newStatus: analysis.recommendedStatus };
}

// Get platform URL from registry or services.json
function getPlatformUrl(platformId) {
  const registry = loadJSON(REGISTRY_PATH);
  const acc = registry?.accounts?.find(a => a.id === platformId);

  if (acc?.test?.url) {
    // Extract base URL from test URL
    try {
      const url = new URL(acc.test.url);
      return `${url.protocol}//${url.host}`;
    } catch {}
  }

  // Try services.json
  const services = loadJSON(SERVICES_PATH);
  const svc = services?.services?.find(s => s.id === platformId);
  if (svc?.url) return svc.url;

  return null;
}

// List all needs_probe platforms
function listNeedsProbe() {
  const registry = loadJSON(REGISTRY_PATH);
  if (!registry?.accounts) {
    console.error("Error: Could not load account-registry.json");
    process.exit(1);
  }

  // d051: Check base status field (not last_status) since auto-promotion sets status="needs_probe"
  // but last_status may be "error" from prior health checks
  const needsProbe = registry.accounts.filter(a => a.status === "needs_probe");

  console.log(`Found ${needsProbe.length} platform(s) needing probe:\n`);
  for (const acc of needsProbe) {
    const url = getPlatformUrl(acc.id);
    console.log(`  - ${acc.id}: ${acc.platform}`);
    console.log(`    URL: ${url || "unknown"}`);
    if (acc.notes) console.log(`    Notes: ${acc.notes.substring(0, 80)}...`);
    console.log();
  }
}

// Main probe function
async function probePlatform(platformId, jsonMode = false) {
  const url = getPlatformUrl(platformId);

  if (!url) {
    const error = { error: `No URL found for platform ${platformId}` };
    if (jsonMode) console.log(JSON.stringify(error, null, 2));
    else console.error(error.error);
    return;
  }

  if (!jsonMode) {
    console.log(`\n=== Probing ${platformId} ===`);
    console.log(`URL: ${url}\n`);
    console.log("Probing discovery endpoints...\n");
  }

  // Snapshot registry before probe for side-effect monitoring
  const registryBefore = snapshotRegistryEntry(platformId);
  const probeStartMs = Date.now();

  // Probe all discovery endpoints in parallel
  const probePromises = DISCOVERY_ENDPOINTS.map(path => probeEndpoint(url, path));
  const results = await Promise.all(probePromises);

  if (!jsonMode) {
    console.log("Results:");
    for (const r of results) {
      const icon = r.isSuccess ? "✓" : r.error ? "✗" : "○";
      const statusStr = r.status ? `HTTP ${r.status}` : r.error || "unknown";
      console.log(`  ${icon} ${r.path}: ${statusStr}`);
    }
    console.log();
  }

  // Analyze results
  const analysis = analyzeResults(results);

  if (!jsonMode) {
    console.log("Analysis:");
    console.log(`  Reachable: ${analysis.reachable}`);
    if (analysis.isSpa) console.log(`  SPA detected: true (false positive — no real API)`);
    if (analysis.frameworkHints.length > 0) console.log(`  Frameworks: ${analysis.frameworkHints.map(f => `${f.framework}(${f.signals})${f.version ? `@${f.version}` : ""}`).join(", ")}`);
    console.log(`  Has skill.md: ${analysis.hasSkillMd}`);
    console.log(`  Has API docs: ${analysis.hasApiDocs}`);
    console.log(`  Has OpenAPI: ${analysis.hasOpenAPI}`);
    console.log(`  Has registration: ${analysis.hasRegistration}`);
    console.log(`  Auth type: ${analysis.authType}`);
    console.log(`  Recommended status: ${analysis.recommendedStatus}`);
    if (analysis.findings.length > 0) {
      console.log(`\nFindings:`);
      for (const f of analysis.findings) {
        console.log(`  - ${f}`);
      }
    }
  }

  // Update registry
  const updateResult = updateRegistry(platformId, analysis, results);

  // Side-effect monitoring: capture behavioral fingerprint
  const probeDurationMs = Date.now() - probeStartMs;
  const registryAfter = snapshotRegistryEntry(platformId);
  let sideEffectTrace = null;
  try {
    sideEffectTrace = monitorProbe(platformId, results, registryBefore, registryAfter, probeDurationMs);
  } catch (e) {
    log(`side-effect monitor error for ${platformId}: ${e.message}`);
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      platform: platformId,
      url,
      analysis,
      probeResults: results.map(r => ({
        path: r.path,
        status: r.status,
        isSuccess: r.isSuccess,
        contentType: r.contentType,
        error: r.error,
        skillHash: r.path === "/skill.md" && r.isSuccess ? analysis.skillMdHash : undefined,
      })),
      registryUpdate: updateResult,
      sideEffects: sideEffectTrace ? {
        behaviorHash: sideEffectTrace.behaviorHash.substring(0, 16),
        timing: sideEffectTrace.timing,
        registryDelta: sideEffectTrace.registryDelta,
      } : null,
    }, null, 2));
  } else {
    console.log(`\n${updateResult.success ? "✓" : "✗"} Registry update: ${updateResult.success ? `status → ${updateResult.newStatus}` : updateResult.error}`);
    if (sideEffectTrace) {
      console.log(`\nSide-effect monitor: hash=${sideEffectTrace.behaviorHash.substring(0, 16)} timing=${sideEffectTrace.timing.bucket}`);
    }
  }
}

// Exports for testing
export { isSpaFalsePositive, analyzeResults, computeContentTypeDiversity, detectFrameworks, checkVersionStaleness };

// CLI
const args = process.argv.slice(2);

if (args.includes("--list")) {
  listNeedsProbe();
} else if (args.length === 0) {
  console.log("Usage:");
  console.log("  node platform-probe.mjs <platform-id>        # Probe a specific platform");
  console.log("  node platform-probe.mjs <platform-id> --json # JSON output");
  console.log("  node platform-probe.mjs --list               # List needs_probe platforms");
} else {
  const platformId = args[0];
  const jsonMode = args.includes("--json");
  probePlatform(platformId, jsonMode);
}

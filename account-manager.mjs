#!/usr/bin/env node
/**
 * account-manager.mjs — Platform credential registry with auth testing.
 *
 * Usage:
 *   node account-manager.mjs status          # Show all accounts and last known status
 *   node account-manager.mjs test [id...]    # Test auth for specific accounts (or all)
 *   node account-manager.mjs live            # Test all, return only live platforms (for E sessions)
 *   node account-manager.mjs json            # Test all, output machine-readable JSON
 *   node account-manager.mjs diagnose <id>   # Probe alternative endpoints when test fails (d027)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { safeFetch } from "./lib/safe-fetch.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REGISTRY_PATH = join(__dirname, "account-registry.json");
const HOME = process.env.HOME || "/home/moltbot";

function expandPath(p) {
  return p.replace(/^~/, HOME);
}

function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

function saveRegistry(reg) {
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
}

function readCredFile(account) {
  const path = expandPath(account.cred_file);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (account.cred_key) {
      return JSON.parse(raw)[account.cred_key];
    }
    // Plain text file (e.g. ~/.colony-key)
    try {
      return JSON.parse(raw); // Return full object if JSON
    } catch {
      return raw; // Return raw string
    }
  } catch { return null; }
}

function getAuthHeader(account, cred) {
  if (!cred) return null;
  const token = typeof cred === "string" ? cred : cred.token || cred.api_key || null;
  if (!token) return null;
  if (account.test.auth === "raw_header") return `Authorization: ${token}`;
  if (account.test.auth === "bearer") return `Authorization: Bearer ${token}`;
  return null;
}

function buildTestUrl(account, cred) {
  let url = account.test.url;
  // Substitute {room} etc from cred object
  if (typeof cred === "object" && cred !== null && account.test.room_key) {
    url = url.replace(`{${account.test.room_key}}`, cred[account.test.room_key] || "");
  }
  return url;
}

async function testAccount(account) {
  const result = { id: account.id, platform: account.platform, tier: account.tier };

  // Handle no-auth platforms (cred_file may be null)
  if (account.auth_type === "none" || !account.cred_file) {
    // Skip cred checks, go straight to endpoint test
    if (account.test.method === "mcp") {
      return { ...result, status: "creds_ok", note: "MCP tool — no auth required" };
    }
    // Test endpoint directly without auth
    try {
      const response = await fetch(account.test.url, { method: account.test.method || "GET" });
      if (response.status === (account.test.expect_status || 200)) {
        return { ...result, status: "live", note: "No auth required" };
      }
      return { ...result, status: "error", error: `Status ${response.status}` };
    } catch (err) {
      return { ...result, status: "error", error: err.message };
    }
  }

  // Check cred file exists
  const credPath = expandPath(account.cred_file);
  if (!existsSync(credPath)) {
    return { ...result, status: "no_creds", error: `Missing: ${account.cred_file}` };
  }

  const cred = readCredFile(account);
  if (!cred) {
    return { ...result, status: "bad_creds", error: "Could not read credential" };
  }

  if (account.test.method === "mcp") {
    // MCP-based tests can't be curl'd — mark as "mcp_only" with cred present
    return { ...result, status: "creds_ok", note: "MCP tool — test via moltbook_digest in session" };
  }

  // fetch-based test — capture body to detect empty 200s
  const authHeader = getAuthHeader(account, cred);
  const url = buildTestUrl(account, cred);
  const fetchHeaders = {};
  if (authHeader) {
    const [key, ...vals] = authHeader.split(": ");
    fetchHeaders[key] = vals.join(": ");
  }

  try {
    const resp = await safeFetch(url, {
      timeout: 8000,
      headers: fetchHeaders,
      allowInternal: true, // account tests may hit local services
    });

    const code = resp.status;
    const bodySize = (resp.body || "").length;

    if (code >= 200 && code < 300 && bodySize === 0) {
      return { ...result, status: "degraded", http: code, note: "200 but empty body" };
    } else if (code >= 200 && code < 300) {
      return { ...result, status: "live", http: code };
    } else if (code === 401 || code === 403) {
      return { ...result, status: "auth_failed", http: code };
    } else if (code === 0) {
      return { ...result, status: "unreachable", http: 0 };
    } else {
      return { ...result, status: "error", http: code };
    }
  } catch (e) {
    return { ...result, status: "unreachable", error: e.message?.slice(0, 100) };
  }
}

async function testAll(filterIds) {
  const reg = loadRegistry();
  const accounts = filterIds?.length
    ? reg.accounts.filter(a => filterIds.includes(a.id))
    : reg.accounts;

  const results = [];
  for (const account of accounts) {
    const r = await testAccount(account);
    r.tested = new Date().toISOString();
    results.push(r);

    // Update registry with last status
    const entry = reg.accounts.find(a => a.id === account.id);
    if (entry) {
      entry.last_status = r.status;
      entry.last_tested = r.tested;
    }
  }

  saveRegistry(reg);
  return results;
}

const SERVICES_PATH = join(__dirname, "services.json");

function loadServices() {
  try {
    return JSON.parse(readFileSync(SERVICES_PATH, "utf8"));
  } catch {
    return { services: [] };
  }
}

async function probeUrl(url, authHeader = null) {
  const fetchHeaders = {};
  if (authHeader) {
    const [key, ...vals] = authHeader.split(": ");
    fetchHeaders[key] = vals.join(": ");
  }
  try {
    const resp = await safeFetch(url, {
      timeout: 8000,
      headers: fetchHeaders,
      allowInternal: true,
    });
    return { url, status: resp.status, bodySize: (resp.body || "").length };
  } catch (e) {
    return { url, status: 0, error: e.message?.slice(0, 80) };
  }
}

async function diagnose(platformId) {
  const reg = loadRegistry();
  const account = reg.accounts.find(a => a.id === platformId);

  if (!account) {
    console.log(`Account "${platformId}" not found in registry.`);
    console.log("Available accounts:", reg.accounts.map(a => a.id).join(", "));
    return;
  }

  console.log(`Diagnosing: ${account.platform} (${account.id})`);
  console.log("=".repeat(60));

  // 1. Test primary endpoint
  const cred = readCredFile(account);
  const authHeader = getAuthHeader(account, cred);

  console.log("\n[Primary Test Endpoint]");
  if (account.test.method === "mcp") {
    console.log(`  Tool: ${account.test.tool} (MCP-based, cannot HTTP probe)`);
  } else {
    const primaryUrl = buildTestUrl(account, cred);
    console.log(`  URL: ${primaryUrl}`);
    const primary = await probeUrl(primaryUrl, authHeader);
    const icon = primary.status >= 200 && primary.status < 300 ? "✓" : "✗";
    console.log(`  ${icon} Status: ${primary.status} (body: ${primary.bodySize || 0} bytes)`);
    if (primary.error) console.log(`  Error: ${primary.error}`);
  }

  // 2. Look up service in services.json (prefer exact ID match)
  const services = loadServices();
  const service = services.services?.find(s => s.id === platformId) ||
    services.services?.find(s => s.name?.toLowerCase() === account.platform.toLowerCase()) ||
    (account.test.url ? services.services?.find(s => {
      try {
        return new URL(s.url).hostname === new URL(account.test.url).hostname;
      } catch { return false; }
    }) : null);

  // 3. Probe alternative endpoints
  console.log("\n[Alternative Endpoints]");

  // Build list of URLs to try
  let baseUrl;
  if (account.test.url) {
    try {
      const u = new URL(account.test.url);
      baseUrl = `${u.protocol}//${u.host}`;
    } catch {}
  }
  if (!baseUrl && service?.url) {
    baseUrl = service.url;
  }

  if (!baseUrl) {
    console.log("  Could not determine base URL for probing.");
    return;
  }

  const probePaths = [
    "/",
    "/health",
    "/api",
    "/api/v1",
    "/api/health",
    "/skill.md",
    "/agent.json",
  ];

  // Add api_docs path if available
  if (service?.api_docs) {
    try {
      const docsPath = new URL(service.api_docs).pathname;
      if (!probePaths.includes(docsPath)) probePaths.push(docsPath);
    } catch {}
  }

  const results = [];
  for (const path of probePaths) {
    const url = baseUrl + path;
    const r = await probeUrl(url);
    results.push(r);
    const icon = r.status >= 200 && r.status < 300 ? "✓" : r.status === 0 ? "?" : "✗";
    const sizeInfo = r.bodySize ? `(${r.bodySize} bytes)` : "";
    console.log(`  ${icon} ${r.status.toString().padStart(3)} ${path.padEnd(20)} ${sizeInfo}`);
  }

  // 4. Summary
  console.log("\n[Summary]");
  const working = results.filter(r => r.status >= 200 && r.status < 300);
  if (working.length === 0) {
    console.log("  No endpoints responding. Service may be offline.");
  } else {
    console.log(`  ${working.length}/${results.length} endpoints responding:`);
    for (const w of working) {
      console.log(`    - ${w.url}`);
    }
  }

  // 5. Suggestion
  if (service) {
    console.log("\n[Service Info from services.json]");
    console.log(`  Status: ${service.status}`);
    console.log(`  Category: ${service.category}`);
    if (service.api_docs) console.log(`  API Docs: ${service.api_docs}`);
    if (service.notes) console.log(`  Notes: ${service.notes}`);
  }
}

// CLI
const cmd = process.argv[2] || "status";
const args = process.argv.slice(3);

if (cmd === "status") {
  const reg = loadRegistry();
  console.log("Platform Account Registry");
  console.log("=".repeat(80));
  for (const a of reg.accounts) {
    const status = a.last_status || "untested";
    const tested = a.last_tested ? new Date(a.last_tested).toLocaleString() : "never";
    const icon = status === "live" ? "✓" : status === "creds_ok" ? "~" : status === "untested" ? "?" : "✗";
    console.log(`  ${icon} [T${a.tier}] ${a.platform.padEnd(22)} ${status.padEnd(14)} tested: ${tested}`);
    if (a.notes) console.log(`         ${a.notes}`);
  }
} else if (cmd === "test") {
  const results = await testAll(args.length ? args : null);
  for (const r of results) {
    const icon = r.status === "live" ? "✓" : r.status === "creds_ok" ? "~" : "✗";
    const extra = r.http ? `(${r.http})` : r.error ? `(${r.error})` : r.note || "";
    console.log(`  ${icon} [T${r.tier}] ${r.platform.padEnd(22)} ${r.status.padEnd(14)} ${extra}`);
  }
} else if (cmd === "live") {
  const results = await testAll();
  const live = results.filter(r => r.status === "live" || r.status === "creds_ok");
  if (live.length === 0) {
    console.log("No live platforms detected.");
  } else {
    for (const r of live) {
      console.log(`[T${r.tier}] ${r.platform}`);
    }
  }
} else if (cmd === "json") {
  const results = await testAll();
  console.log(JSON.stringify(results, null, 2));
} else if (cmd === "diagnose") {
  const platformId = args[0];
  if (!platformId) {
    console.log("Usage: node account-manager.mjs diagnose <platform-id>");
    console.log("  Probes alternative endpoints when primary test fails.");
    process.exit(1);
  }
  await diagnose(platformId);
} else {
  console.log("Usage: node account-manager.mjs [status|test|live|json|diagnose] [id...]");
}

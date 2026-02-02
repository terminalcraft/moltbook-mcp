#!/usr/bin/env node
/**
 * account-manager.mjs — Platform credential registry with auth testing.
 *
 * Usage:
 *   node account-manager.mjs status          # Show all accounts and last known status
 *   node account-manager.mjs test [id...]    # Test auth for specific accounts (or all)
 *   node account-manager.mjs live            # Test all, return only live platforms (for E sessions)
 *   node account-manager.mjs json            # Test all, output machine-readable JSON
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
} else {
  console.log("Usage: node account-manager.mjs [status|test|live|json] [id...]");
}

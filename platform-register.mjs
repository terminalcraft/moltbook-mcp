#!/usr/bin/env node
/**
 * platform-register.mjs — Automated platform registration utility
 *
 * Created: B#446 (wq-637)
 * Scans needs_probe platforms, fetches skill.md, detects registration
 * endpoints, and attempts automated registration.
 *
 * Usage:
 *   node platform-register.mjs list              # Show needs_probe platforms
 *   node platform-register.mjs probe <id>        # Probe single platform
 *   node platform-register.mjs register <id>     # Register on single platform
 *   node platform-register.mjs auto              # Probe + register all eligible
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, "account-registry.json");
const HANDLE = "moltbook";
const TIMEOUT = 10000;

function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
}

function saveRegistry(reg) {
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
}

function getNeedsProbe(reg) {
  return reg.accounts.filter(a => a.status === "needs_probe");
}

async function fetchWithTimeout(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { "Content-Type": "application/json", ...opts.headers },
  });
  return res;
}

// Fetch and parse skill.md for registration info
async function fetchSkillMd(baseUrl) {
  const urls = [
    `${baseUrl}/skill.md`,
    `${baseUrl}/.well-known/skill.md`,
  ];

  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url);
      if (res.ok) {
        const text = await res.text();
        // Only accept if it looks like markdown (not HTML)
        if (!text.trim().startsWith("<!") && !text.trim().startsWith("<html")) {
          return { url, text };
        }
      }
    } catch { /* continue */ }
  }
  return null;
}

// Extract registration endpoint from skill.md content
function extractRegistrationInfo(skillText, baseUrl) {
  const info = { endpoint: null, method: "POST", fields: [], authType: null };

  // Look for registration endpoint patterns
  const patterns = [
    /(?:POST|GET)\s+[`"]?(\/(?:api\/(?:v\d+\/)?)?(?:agents\/)?register)[`"]?/gi,
    /(?:register|registration|signup).*?[`"](\/[^\s`"]+)[`"]/gi,
    /[`"](\/[^\s`"]*register[^\s`"]*)[`"]/gi,
  ];

  for (const pat of patterns) {
    const match = pat.exec(skillText);
    if (match) {
      info.endpoint = match[1];
      break;
    }
  }

  // Look for method
  if (skillText.match(/POST\s.*register/i)) info.method = "POST";

  // Look for required fields
  const fieldPatterns = [
    /(?:name|handle|username|agent_name|display_name)\s*[:=]/gi,
    /\{[^}]*"(name|handle|username)"[^}]*\}/gi,
  ];
  for (const pat of fieldPatterns) {
    const m = pat.exec(skillText);
    if (m) info.fields.push(m[1] || "name");
  }
  if (!info.fields.length) info.fields = ["name"]; // default

  // Look for auth type hints
  if (skillText.match(/api.?key/i)) info.authType = "api_key";
  else if (skillText.match(/bearer/i)) info.authType = "bearer";
  else if (skillText.match(/token/i)) info.authType = "api_key";

  return info;
}

// Try common registration endpoints
async function tryRegister(baseUrl, regInfo) {
  const endpoints = [];

  if (regInfo?.endpoint) {
    endpoints.push(regInfo.endpoint);
  }

  // Common patterns to try
  endpoints.push(
    "/api/agents/register",
    "/agents/register",
    "/api/register",
    "/api/v1/agents/register",
    "/api/v2/agents/register",
    "/api/v1/auth/register",
    "/api/v1/register",
    "/api/auth/register",
    "/auth/register",
    "/register",
  );

  // Deduplicate
  const unique = [...new Set(endpoints)];

  // Try each field name variant
  const fieldVariants = [
    { name: HANDLE },
    { handle: HANDLE },
    { agent_name: HANDLE },
    { username: HANDLE },
    { name: HANDLE, handle: HANDLE },
    { agent_name: HANDLE, name: HANDLE },
  ];

  for (const ep of unique) {
    const url = `${baseUrl}${ep}`;
    for (const body of fieldVariants) {
      try {
        const res = await fetchWithTimeout(url, {
          method: "POST",
          body: JSON.stringify(body),
        });

        if (res.ok) {
          const contentType = res.headers.get("content-type") || "";
          // Reject HTML responses (SPA catch-all returns 200 for any path)
          if (contentType.includes("html")) continue;
          let data;
          if (contentType.includes("json")) {
            data = await res.json();
          } else {
            const text = await res.text();
            if (text.trim().startsWith("<!") || text.trim().startsWith("<html")) continue;
            try { data = JSON.parse(text); } catch { data = { raw: text }; }
          }
          return { success: true, endpoint: ep, body, data, status: res.status };
        }

        // 409 = already registered (some platforms) — treat as success if we get creds back
        if (res.status === 409) {
          let data;
          try { data = await res.json(); } catch { data = {}; }
          // Only treat as success if response contains usable credentials
          const hasCreds = data && (data.api_key || data.apiKey || data.token || data.access_token);
          if (hasCreds) {
            return { success: true, endpoint: ep, body, data, status: 409, alreadyRegistered: true };
          }
          // Otherwise just note it
          return { success: false, reason: "already_registered", endpoint: ep, data };
        }

        // Skip if 404 (endpoint doesn't exist)
        if (res.status === 404) continue;

        // 422/400 might mean wrong fields, try next variant
        if (res.status === 422 || res.status === 400) continue;

      } catch { /* timeout or network error, try next */ }
    }
  }

  return { success: false };
}

// Extract credentials from registration response
function extractCredentials(data) {
  if (!data || typeof data !== "object") return null;

  const creds = {};
  const flat = { ...data };

  // Flatten one level if nested
  for (const key of ["agent", "user", "data", "result"]) {
    if (flat[key] && typeof flat[key] === "object") {
      Object.assign(flat, flat[key]);
    }
  }

  // Look for credential fields
  const keyFields = ["api_key", "apiKey", "token", "access_token", "key", "secret", "auth_token", "jwt"];
  for (const f of keyFields) {
    if (flat[f]) creds.token = flat[f];
  }

  const idFields = ["id", "agent_id", "agentId", "user_id", "userId"];
  for (const f of idFields) {
    if (flat[f]) creds.id = flat[f];
  }

  const handleFields = ["handle", "name", "username", "display_name"];
  for (const f of handleFields) {
    if (flat[f]) creds.handle = flat[f];
  }

  return Object.keys(creds).length > 0 ? creds : null;
}

// Save credentials to file and update registry
function saveCredentials(platformId, creds, regResult) {
  const credPath = join(__dirname, `${platformId}-credentials.json`);
  const credData = {
    ...creds,
    registered_at: new Date().toISOString(),
    endpoint: regResult.endpoint,
    raw_response: regResult.data,
  };
  writeFileSync(credPath, JSON.stringify(credData, null, 2) + "\n");

  // Update account registry
  const reg = loadRegistry();
  const account = reg.accounts.find(a => a.id === platformId);
  if (account) {
    account.status = "live";
    account.has_credentials = true;
    account.cred_file = `~/moltbook-mcp/${platformId}-credentials.json`;
    account.cred_key = creds.token ? "token" : null;
    account.cred_reason = undefined;
    account.last_status = regResult.alreadyRegistered ? "already_registered" : "registered";
    account.last_tested = new Date().toISOString();
    account.handle = creds.handle || HANDLE;
    const prevNotes = account.notes || "";
    account.notes = `Registered s${process.env.SESSION_NUM || "?"}: auto-registered via platform-register.mjs. ${prevNotes}`.slice(0, 500);
    saveRegistry(reg);
  }

  return credPath;
}

// Check if platform is reachable
async function checkAlive(baseUrl) {
  try {
    const res = await fetchWithTimeout(baseUrl);
    return { alive: res.ok || res.status < 500, status: res.status };
  } catch {
    return { alive: false, status: 0 };
  }
}

// Probe a single platform
async function probePlatform(account) {
  const baseUrl = account.test?.url?.replace(/\/api.*$/, "").replace(/\/$/, "")
    || `https://${account.id}.com`;

  console.log(`\nProbing ${account.platform} (${baseUrl})...`);

  // 1. Check alive
  const alive = await checkAlive(baseUrl);
  if (!alive.alive) {
    console.log(`  ✗ Unreachable (status: ${alive.status})`);
    return { alive: false, platform: account.id };
  }
  console.log(`  ✓ Alive (status: ${alive.status})`);

  // 2. Fetch skill.md
  const skill = await fetchSkillMd(baseUrl);
  if (skill) {
    console.log(`  ✓ skill.md found at ${skill.url}`);
    const regInfo = extractRegistrationInfo(skill.text, baseUrl);
    if (regInfo.endpoint) {
      console.log(`  ✓ Registration endpoint detected: ${regInfo.endpoint}`);
    }
    return { alive: true, platform: account.id, baseUrl, skill: true, regInfo };
  }

  console.log(`  ✗ No skill.md found`);
  return { alive: true, platform: account.id, baseUrl, skill: false, regInfo: null };
}

// Register on a single platform
async function registerPlatform(account) {
  const probeResult = await probePlatform(account);

  if (!probeResult.alive) {
    console.log(`  → Skipping (unreachable)`);
    return { success: false, reason: "unreachable" };
  }

  console.log(`  Attempting registration on ${probeResult.baseUrl}...`);
  const result = await tryRegister(probeResult.baseUrl, probeResult.regInfo);

  if (!result.success) {
    console.log(`  ✗ Registration failed (no working endpoint found)`);
    return { success: false, reason: "no_endpoint" };
  }

  console.log(`  ✓ Registration succeeded via ${result.endpoint} (status: ${result.status})`);

  const creds = extractCredentials(result.data);
  if (creds) {
    const credPath = saveCredentials(account.id, creds, result);
    console.log(`  ✓ Credentials saved to ${credPath}`);
    console.log(`  ✓ Account registry updated: ${account.id} → live`);
  } else {
    console.log(`  ⚠ Registered but no extractable credentials in response`);
    console.log(`  Response:`, JSON.stringify(result.data).slice(0, 200));
  }

  return { success: true, creds, result };
}

// CLI
async function main() {
  const [command, arg] = process.argv.slice(2);
  const reg = loadRegistry();
  const probes = getNeedsProbe(reg);

  switch (command) {
    case "list": {
      console.log(`Platforms needing probe/registration (${probes.length}):\n`);
      for (const a of probes) {
        const url = a.test?.url || "unknown";
        const alive = a.last_status === "live" ? "✓" : a.last_status === "error" ? "✗" : "?";
        const creds = a.has_credentials ? "has creds" : "no creds";
        const skill = a.skill_hash ? "skill.md ✓" : "no skill.md";
        console.log(`  ${alive} ${a.id.padEnd(20)} ${creds.padEnd(12)} ${skill.padEnd(14)} ${url}`);
      }
      break;
    }

    case "probe": {
      if (!arg) { console.error("Usage: node platform-register.mjs probe <id>"); process.exit(1); }
      const account = reg.accounts.find(a => a.id === arg);
      if (!account) { console.error(`Unknown platform: ${arg}`); process.exit(1); }
      await probePlatform(account);
      break;
    }

    case "register": {
      if (!arg) { console.error("Usage: node platform-register.mjs register <id>"); process.exit(1); }
      const account = reg.accounts.find(a => a.id === arg);
      if (!account) { console.error(`Unknown platform: ${arg}`); process.exit(1); }
      await registerPlatform(account);
      break;
    }

    case "auto": {
      console.log(`Auto-registering on ${probes.length} needs_probe platforms...\n`);
      const results = { success: 0, unreachable: 0, failed: 0 };

      for (const account of probes) {
        try {
          const r = await registerPlatform(account);
          if (r.success) results.success++;
          else if (r.reason === "unreachable") results.unreachable++;
          else results.failed++;
        } catch (e) {
          console.log(`  ✗ Error: ${e.message}`);
          results.failed++;
        }
      }

      console.log(`\n--- Summary ---`);
      console.log(`  Registered: ${results.success}`);
      console.log(`  Unreachable: ${results.unreachable}`);
      console.log(`  Failed: ${results.failed}`);
      break;
    }

    default:
      console.log(`platform-register.mjs — Automated platform registration

Commands:
  list                Show platforms needing registration
  probe <id>          Probe single platform (check alive + skill.md)
  register <id>       Attempt registration on single platform
  auto                Probe + register all eligible platforms

Registered as: ${HANDLE}
Platforms needing probe: ${probes.length}
`);
  }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });

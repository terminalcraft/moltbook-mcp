#!/usr/bin/env node
// deploy-shipyard-dashboard.mjs
// Builds and deploys the Moltbook Platform Health Dashboard to Shipyard.
// Usage: node deploy-shipyard-dashboard.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CREDS_PATH = resolve(__dirname, 'shipyard-credentials.json');
const CIRCUITS_PATH = resolve(__dirname, 'platform-circuits.json');
const ACCOUNTS_PATH = resolve(__dirname, 'account-registry.json');
const TEMPLATE_PATH = resolve(__dirname, 'shipyard-dashboard/index.html');
const SHIP_TITLE = 'Moltbook Platform Health Dashboard';

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[shipyard-deploy] ${msg}`); }
function logErr(msg) { console.error(`[shipyard-deploy] ERROR: ${msg}`); }

// ── JSON helpers ─────────────────────────────────────────────────────────────

async function readJSON(path) {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw);
}

async function writeJSON(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ── Build platform data ──────────────────────────────────────────────────────

async function buildPlatformData() {
  log('Reading platform-circuits.json...');
  const circuits = await readJSON(CIRCUITS_PATH);

  let accounts = [];
  try {
    const registry = await readJSON(ACCOUNTS_PATH);
    accounts = registry.accounts || [];
    log(`Read account-registry.json (${accounts.length} accounts)`);
  } catch (e) {
    log('Could not read account-registry.json, proceeding without it');
  }

  // Build a lookup: account id -> account metadata
  const acctMap = {};
  for (const acct of accounts) {
    acctMap[acct.id] = acct;
  }

  // Merge circuit data with account metadata
  const merged = {};
  for (const [key, circuit] of Object.entries(circuits)) {
    const acct = acctMap[key] || {};
    merged[key] = {
      ...circuit,
      platform_name: acct.platform || null,
      url: acct.test?.url || null,
      account_status: acct.status || acct.last_status || null,
      has_credentials: acct.has_credentials || false,
    };
  }

  return merged;
}

// ── Build HTML ───────────────────────────────────────────────────────────────

async function buildHTML(platformData) {
  log('Reading template from shipyard-dashboard/index.html...');
  const template = await readFile(TEMPLATE_PATH, 'utf-8');

  const now = new Date().toISOString();
  const jsonStr = JSON.stringify(platformData);

  const html = template
    .replace('__PLATFORM_DATA__', jsonStr)
    .replace('__GENERATED_AT__', now);

  log(`Built HTML: ${html.length} bytes, ${Object.keys(platformData).length} platforms, generated at ${now}`);
  return html;
}

// ── Shipyard API ─────────────────────────────────────────────────────────────

async function shipyardFetch(apiBase, path, apiKey, options = {}) {
  const url = `${apiBase}${path}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    ...options.headers,
  };

  const resp = await fetch(url, {
    ...options,
    headers,
  });

  const text = await resp.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!resp.ok) {
    throw new Error(`Shipyard API ${options.method || 'GET'} ${path} => ${resp.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  return body;
}

async function createShip(apiBase, apiKey) {
  log('Creating new ship...');
  const result = await shipyardFetch(apiBase, '/ships', apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: SHIP_TITLE,
      description: 'Real-time platform health status for the moltbook agent. Tracks 58 platforms across the agent ecosystem with circuit breaker states, failure streaks, and liveness data.',
      proof_url: 'https://github.com/terminalcraft/moltbook-mcp',
      proof_type: 'code',
    }),
  });

  const shipId = result.id || result.ship?.id || result.shipId;
  if (!shipId) {
    throw new Error('No ship ID in create response: ' + JSON.stringify(result));
  }
  log(`Created ship: ${shipId}`);
  return { id: shipId, result };
}

async function uploadFile(apiBase, apiKey, shipId, filename, content) {
  log(`Uploading ${filename} to ship ${shipId}...`);

  const result = await shipyardFetch(apiBase, `/ships/${shipId}/files`, apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ filename, content }],
    }),
  });
  log(`Uploaded ${filename}`);
  return result;
}

async function deployShip(apiBase, apiKey, shipId) {
  log(`Deploying ship ${shipId}...`);
  const result = await shipyardFetch(apiBase, `/ships/${shipId}/deploy`, apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  log('Deploy triggered');
  return result;
}

async function checkShipExists(apiBase, apiKey, shipId) {
  try {
    const result = await shipyardFetch(apiBase, `/ships/${shipId}`, apiKey, {
      method: 'GET',
    });
    return result;
  } catch {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Load credentials
  log('Loading shipyard-credentials.json...');
  let creds;
  try {
    creds = await readJSON(CREDS_PATH);
  } catch (e) {
    logErr(`Cannot read ${CREDS_PATH}: ${e.message}`);
    process.exit(1);
  }

  const apiBase = creds.api_base;
  const apiKey = creds.api_key;
  if (!apiBase || !apiKey) {
    logErr('Missing api_base or api_key in shipyard-credentials.json');
    process.exit(1);
  }
  log(`API base: ${apiBase}`);

  // 2. Build platform data and HTML
  let platformData;
  try {
    platformData = await buildPlatformData();
  } catch (e) {
    logErr(`Failed to build platform data: ${e.message}`);
    process.exit(1);
  }

  let html;
  try {
    html = await buildHTML(platformData);
  } catch (e) {
    logErr(`Failed to build HTML: ${e.message}`);
    process.exit(1);
  }

  // 3. Check for existing ship ID
  let shipId = creds.dashboard_ship_id || null;
  let needCreate = true;

  if (shipId) {
    log(`Found stored ship ID: ${shipId}, checking if it still exists...`);
    const existing = await checkShipExists(apiBase, apiKey, shipId);
    if (existing) {
      log('Ship exists, will update files and redeploy');
      needCreate = false;
    } else {
      log('Stored ship no longer exists, will create a new one');
    }
  }

  // 4. Create ship if needed
  if (needCreate) {
    try {
      const { id } = await createShip(apiBase, apiKey);
      shipId = id;

      // Persist the ship ID for future runs
      creds.dashboard_ship_id = shipId;
      await writeJSON(CREDS_PATH, creds);
      log(`Saved ship ID ${shipId} to shipyard-credentials.json`);
    } catch (e) {
      logErr(`Failed to create ship: ${e.message}`);
      process.exit(1);
    }
  }

  // 5. Upload index.html
  try {
    await uploadFile(apiBase, apiKey, shipId, 'index.html', html);
  } catch (e) {
    logErr(`Failed to upload file: ${e.message}`);
    process.exit(1);
  }

  // 6. Deploy
  try {
    const deployResult = await deployShip(apiBase, apiKey, shipId);
    const deployUrl = deployResult.url || deployResult.deploy_url || deployResult.site_url || `${creds.url}/ships/${shipId}`;
    log(`Deploy complete!`);
    log(`Ship ID: ${shipId}`);
    log(`URL: ${deployUrl}`);

    // Save deploy URL if returned
    if (deployResult.url || deployResult.deploy_url || deployResult.site_url) {
      creds.dashboard_url = deployResult.url || deployResult.deploy_url || deployResult.site_url;
      await writeJSON(CREDS_PATH, creds);
    }
  } catch (e) {
    logErr(`Failed to deploy: ${e.message}`);
    process.exit(1);
  }

  log('Done.');
}

main().catch(e => {
  logErr(`Unhandled error: ${e.message}`);
  process.exit(1);
});

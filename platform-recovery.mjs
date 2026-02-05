#!/usr/bin/env node
/**
 * platform-recovery.mjs - Investigate and attempt recovery of broken platforms
 *
 * Usage:
 *   node platform-recovery.mjs --list             # List platforms needing recovery
 *   node platform-recovery.mjs --probe <id>       # Probe discovery endpoints for a platform
 *   node platform-recovery.mjs --register <id>    # Attempt registration (if applicable)
 *   node platform-recovery.mjs --all              # Probe all broken platforms
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, 'account-registry.json');
const ALERT_PATH = path.join(process.env.HOME, '.config/moltbook/platform-health-alert.txt');

const BROKEN_STATUSES = ['no_creds', 'bad_creds', 'error', 'unreachable'];

const DISCOVERY_ENDPOINTS = [
  '/skill.md',
  '/api-docs',
  '/openapi.json',
  '/.well-known/agent-info.json',
  '/health',
  '/api/health',
  '/api/v1/health',
];

const REGISTRATION_ENDPOINTS = [
  '/api/register',
  '/api/v1/register',
  '/api/agents/register',
  '/api/v1/agents/register',
  '/register',
];

function loadRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (e) {
    console.error(`Error loading registry: ${e.message}`);
    process.exit(1);
  }
}

function saveRegistry(registry) {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
}

function getBrokenPlatforms(registry) {
  return registry.accounts.filter(acc => BROKEN_STATUSES.includes(acc.last_status));
}

function extractDomain(testConfig) {
  if (!testConfig || !testConfig.url) return null;
  try {
    const url = new URL(testConfig.url);
    return url.origin;
  } catch {
    return null;
  }
}

async function probeEndpoint(url, timeout = 5000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'moltbook-recovery/1.0' }
    });

    clearTimeout(timeoutId);

    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      body: text.slice(0, 500), // Truncate for display
      bodyLength: text.length
    };
  } catch (e) {
    return {
      error: e.name === 'AbortError' ? 'timeout' : e.message,
      ok: false
    };
  }
}

async function probePlatform(account) {
  const domain = extractDomain(account.test);
  if (!domain) {
    console.log(`⚠ Cannot extract domain from test config for ${account.id}`);
    return { domain: null, endpoints: [] };
  }

  console.log(`\n🔍 Probing ${account.platform} (${domain})`);
  console.log(`   Current status: ${account.last_status}`);
  console.log(`   Last tested: ${account.last_tested || 'never'}\n`);

  const results = { domain, endpoints: [] };

  // Probe discovery endpoints
  console.log('Discovery endpoints:');
  for (const endpoint of DISCOVERY_ENDPOINTS) {
    const url = domain + endpoint;
    const result = await probeEndpoint(url);
    results.endpoints.push({ url, ...result });

    if (result.ok) {
      console.log(`   ✓ ${endpoint} (${result.status}, ${result.bodyLength} bytes)`);
      if (endpoint === '/skill.md') {
        console.log(`     Preview: ${result.body.slice(0, 100).replace(/\n/g, ' ')}`);
      }
    } else if (result.status === 404) {
      console.log(`   ✗ ${endpoint} (404)`);
    } else if (result.error) {
      console.log(`   ✗ ${endpoint} (${result.error})`);
    } else {
      console.log(`   ? ${endpoint} (${result.status})`);
    }
  }

  // Probe registration endpoints
  console.log('\nRegistration endpoints:');
  for (const endpoint of REGISTRATION_ENDPOINTS) {
    const url = domain + endpoint;
    const result = await probeEndpoint(url);
    results.endpoints.push({ url, type: 'registration', ...result });

    if (result.ok || result.status === 405) { // 405 = method not allowed, but endpoint exists
      console.log(`   ✓ ${endpoint} (${result.status}) - registration may be available`);
    } else if (result.status === 404) {
      console.log(`   ✗ ${endpoint} (404)`);
    } else if (result.error) {
      console.log(`   ✗ ${endpoint} (${result.error})`);
    }
  }

  // Check if main API endpoint is reachable
  if (account.test?.url) {
    console.log('\nAPI endpoint:');
    const result = await probeEndpoint(account.test.url);
    results.apiEndpoint = { url: account.test.url, ...result };

    if (result.ok) {
      console.log(`   ✓ ${account.test.url} (${result.status})`);
    } else if (result.status === 401 || result.status === 403) {
      console.log(`   🔐 ${account.test.url} (${result.status}) - auth required`);
    } else if (result.error) {
      console.log(`   ✗ ${account.test.url} (${result.error})`);
    } else {
      console.log(`   ? ${account.test.url} (${result.status})`);
    }
  }

  // Suggest recovery action
  console.log('\n📋 Suggested action:');
  const suggestion = suggestAction(account, results);
  console.log(`   ${suggestion}`);

  return results;
}

function suggestAction(account, probeResults) {
  const { apiEndpoint, endpoints } = probeResults;

  // Check if any discovery endpoint is reachable
  const hasWorkingDiscovery = endpoints.some(e => e.ok);
  const hasRegistration = endpoints.some(e => e.type === 'registration' && (e.ok || e.status === 405));

  switch (account.last_status) {
    case 'no_creds':
      if (hasRegistration) {
        return 'Registration endpoint found. Attempt registration with handle "moltbook".';
      } else if (apiEndpoint?.ok) {
        return 'API works without auth. Update auth_type to "none" in registry.';
      } else {
        return 'No registration found. Check /skill.md for manual registration process.';
      }

    case 'bad_creds':
      if (apiEndpoint?.status === 401 || apiEndpoint?.status === 403) {
        if (hasRegistration) {
          return 'Credentials rejected. Attempt re-registration.';
        } else {
          return 'Credentials rejected and no registration endpoint. May need human intervention.';
        }
      } else if (apiEndpoint?.ok) {
        return 'API now works! Update status to "live" in registry.';
      }
      return 'Probe API manually to determine credential issue.';

    case 'error':
      if (apiEndpoint?.error) {
        return `API error: ${apiEndpoint.error}. Platform may be down.`;
      } else if (apiEndpoint?.status >= 500) {
        return 'Server error (5xx). Platform issue, retry later.';
      }
      return 'Check API response for specific error details.';

    case 'unreachable':
      if (!hasWorkingDiscovery && apiEndpoint?.error) {
        return `Platform unreachable: ${apiEndpoint.error}. Mark as "rejected" if persistent.`;
      } else if (hasWorkingDiscovery) {
        return 'Discovery endpoints work but API failed. Check test URL configuration.';
      }
      return 'Platform appears down. Retry in next health check.';

    default:
      return 'Unknown status. Manual investigation required.';
  }
}

async function listBroken() {
  const registry = loadRegistry();
  const broken = getBrokenPlatforms(registry);

  console.log(`\n📊 Platforms needing recovery: ${broken.length}\n`);

  for (const status of BROKEN_STATUSES) {
    const group = broken.filter(a => a.last_status === status);
    if (group.length > 0) {
      console.log(`${status}:`);
      for (const acc of group) {
        console.log(`  - ${acc.id} (${acc.platform})`);
      }
    }
  }

  if (existsSync(ALERT_PATH)) {
    console.log(`\n⚠ Health alert file exists at ${ALERT_PATH}`);
    console.log(readFileSync(ALERT_PATH, 'utf8'));
  }
}

async function probeAll() {
  const registry = loadRegistry();
  const broken = getBrokenPlatforms(registry);

  console.log(`Probing ${broken.length} broken platforms...\n`);

  for (const account of broken) {
    await probePlatform(account);
    console.log('\n' + '─'.repeat(60));
  }
}

async function probeOne(id) {
  const registry = loadRegistry();
  const account = registry.accounts.find(a => a.id === id);

  if (!account) {
    console.error(`Platform "${id}" not found in registry`);
    process.exit(1);
  }

  await probePlatform(account);
}

// CLI handling
const args = process.argv.slice(2);
const command = args[0];

if (command === '--list' || command === '-l') {
  await listBroken();
} else if (command === '--probe' || command === '-p') {
  const id = args[1];
  if (!id) {
    console.error('Usage: node platform-recovery.mjs --probe <platform-id>');
    process.exit(1);
  }
  await probeOne(id);
} else if (command === '--all' || command === '-a') {
  await probeAll();
} else {
  console.log(`
Platform Recovery Tool

Usage:
  node platform-recovery.mjs --list             List platforms needing recovery
  node platform-recovery.mjs --probe <id>       Probe a specific platform
  node platform-recovery.mjs --all              Probe all broken platforms

Examples:
  node platform-recovery.mjs --list
  node platform-recovery.mjs --probe mydeadinternet
  node platform-recovery.mjs --all
`);
}

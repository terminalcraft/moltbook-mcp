#!/usr/bin/env node
// poll-directories.cjs — Polls known service directories for new agent services.
// Run from heartbeat.sh pre-flight. Zero token cost.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVICES_FILE = path.join(__dirname, 'services.json');

function load() {
  try { return JSON.parse(fs.readFileSync(SERVICES_FILE, 'utf8')); }
  catch { return { version: 1, lastUpdated: new Date().toISOString(), directories: [], services: [] }; }
}

function save(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(SERVICES_FILE, JSON.stringify(data, null, 2));
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function pollDirectory(dir) {
  const res = await fetch(dir.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);

  if (hash === dir.lastHash) {
    dir.lastPolled = new Date().toISOString();
    return [];  // No changes
  }

  dir.lastHash = hash;
  dir.lastPolled = new Date().toISOString();

  const json = JSON.parse(body);
  const remoteServices = json.services || [];
  return remoteServices;
}

async function main() {
  const data = load();
  if (!data.directories || data.directories.length === 0) {
    console.log('No directories configured');
    return;
  }

  const existingUrls = new Set(data.services.map(s => s.url));
  let totalNew = 0;

  for (const dir of data.directories) {
    try {
      const remoteServices = await pollDirectory(dir);
      if (remoteServices.length === 0) continue;

      for (const rs of remoteServices) {
        if (existingUrls.has(rs.url)) continue;
        const id = rs.slug || slugify(rs.name);
        if (data.services.some(s => s.id === id)) continue;

        data.services.push({
          id,
          name: rs.name,
          url: rs.url,
          category: rs.category || 'unknown',
          source: `directory:${new URL(dir.url).hostname}`,
          status: 'discovered',
          discoveredAt: new Date().toISOString(),
          evaluatedAt: null,
          notes: rs.description || '',
          api_docs: rs.api_docs || null,
          tags: rs.tags || [],
        });
        existingUrls.add(rs.url);
        totalNew++;
      }
    } catch (e) {
      console.error(`Failed to poll ${dir.url}: ${e.message}`);
    }
  }

  save(data);
  if (totalNew > 0) {
    console.log(`${new Date().toISOString()} discovered ${totalNew} new service(s)`);
  }
}

main().catch(e => console.error(e.message));

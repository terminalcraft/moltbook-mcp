#!/usr/bin/env node
// API health monitor — probes key Moltbook endpoints and logs results.
// Usage: node health-check.cjs [--json] [--summary]
// Designed to run from heartbeat.sh or cron independently.
// Logs to ~/.config/moltbook/health.jsonl (append-only, one JSON line per check).

const https = require('https');
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(process.env.HOME, '.config/moltbook/health.jsonl');
const STATE_PATH = path.join(process.env.HOME, '.config/moltbook/engagement-state.json');
const MAX_LINES = 500; // rotate after this many entries

function getToken() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return state.apiToken || null;
  } catch { return null; }
}

function probe(urlPath, token, timeoutMs = 10000) {
  return new Promise(resolve => {
    const start = Date.now();
    const opts = {
      hostname: 'www.moltbook.com',
      path: urlPath,
      method: 'GET',
      timeout: timeoutMs,
      headers: {}
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;

    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          latencyMs: Date.now() - start,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          bodyLen: body.length
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, latencyMs: Date.now() - start, ok: false, error: 'timeout' });
    });
    req.on('error', err => {
      resolve({ status: 0, latencyMs: Date.now() - start, ok: false, error: err.code || err.message });
    });
    req.end();
  });
}

function summary() {
  if (!fs.existsSync(LOG_PATH)) { console.log('No health data yet.'); return; }
  const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n');
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!entries.length) { console.log('No health data yet.'); return; }

  // Collect per-endpoint stats
  const stats = {};
  for (const e of entries) {
    for (const [name, r] of Object.entries(e.results)) {
      if (!stats[name]) stats[name] = { ok: 0, fail: 0, totalLatency: 0, errors: {} };
      const s = stats[name];
      if (r.ok) s.ok++; else s.fail++;
      s.totalLatency += (r.latencyMs || 0);
      if (r.error) s.errors[r.error] = (s.errors[r.error] || 0) + 1;
      else if (!r.ok) { const k = `http_${r.status}`; s.errors[k] = (s.errors[k] || 0) + 1; }
    }
  }

  const first = entries[0].ts, last = entries[entries.length - 1].ts;
  console.log(`Health summary: ${entries.length} checks from ${first} to ${last}`);
  for (const [name, s] of Object.entries(stats)) {
    const total = s.ok + s.fail;
    const pct = ((s.ok / total) * 100).toFixed(1);
    const avgMs = Math.round(s.totalLatency / total);
    const topErrors = Object.entries(s.errors).sort((a,b) => b[1]-a[1]).slice(0,3)
      .map(([e,c]) => `${e}(${c})`).join(', ');
    console.log(`  ${name}: ${pct}% up (${s.ok}/${total}), avg ${avgMs}ms${topErrors ? `, errors: ${topErrors}` : ''}`);
  }
}

async function main() {
  if (process.argv.includes('--summary')) { summary(); return; }
  const token = getToken();
  const jsonOutput = process.argv.includes('--json');
  const endpoints = [
    { name: 'submolts', path: '/api/v1/submolts' },
    { name: 'feed_unauth', path: '/api/v1/feed?sort=new&limit=1', auth: false },
    { name: 'feed_auth', path: '/api/v1/feed?sort=new&limit=1', auth: true },
    { name: 'search', path: '/api/v1/search?q=test&limit=1' },
  ];

  const results = {};
  for (const ep of endpoints) {
    const useToken = ep.auth === false ? null : token;
    results[ep.name] = await probe(ep.path, useToken);
  }

  const entry = {
    ts: new Date().toISOString(),
    results
  };

  // Append to log
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');

  // Rotate if needed
  try {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n');
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(LOG_PATH, lines.slice(-MAX_LINES).join('\n') + '\n');
    }
  } catch {}

  if (jsonOutput) {
    console.log(JSON.stringify(entry, null, 2));
  } else {
    console.log(`Health check ${entry.ts}:`);
    for (const [name, r] of Object.entries(results)) {
      const icon = r.ok ? '✓' : '✗';
      const detail = r.error || `${r.status} ${r.latencyMs}ms`;
      console.log(`  ${icon} ${name}: ${detail}`);
    }
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

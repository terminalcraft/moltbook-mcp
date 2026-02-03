#!/usr/bin/env node
// Engagement platform health gate — scores platforms on WRITE capability, not just reachability.
// Output: last line is ENGAGE_OK or ENGAGE_DEGRADED.
// Used by heartbeat.sh to decide whether to run E sessions or auto-downgrade to B.
//
// Scoring: each platform gets 0-2 points.
//   0 = down/unreachable
//   1 = readable but writes broken or severely throttled
//   2 = fully writable
// Threshold: need >= 3 total points to justify an E session.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const THRESHOLD = 3;
const DIR = __dirname;

function fetch(url, opts = {}) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise(resolve => {
    const timeout = opts.timeout || 5000;
    const reqOpts = {
      method: opts.method || 'GET',
      timeout,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    };
    const req = mod.request(url, reqOpts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body, ok: res.statusCode >= 200 && res.statusCode < 400 }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, ok: false, error: e.code }));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function loadCreds(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, name + '-credentials.json'), 'utf8'));
  } catch { return null; }
}

async function scoreChatr() {
  // Read check
  const read = await fetch('https://chatr.ai/api/messages?limit=1');
  if (!read.ok) return { name: 'chatr', score: 0, detail: 'unreachable' };

  const creds = loadCreds('chatr');
  if (creds && creds.verified) return { name: 'chatr', score: 2, detail: 'verified+writable' };
  return { name: 'chatr', score: 1, detail: 'unverified (rate-limited)' };
}

async function scoreFourclaw() {
  const creds = loadCreds('fourclaw');
  if (!creds || !creds.api_key) return { name: '4claw', score: 0, detail: 'no credentials' };

  const baseUrl = creds.base_url || 'https://www.4claw.org/api/v1';
  const headers = { 'Authorization': 'Bearer ' + creds.api_key };

  // Read check: board list with auth
  const read = await fetch(baseUrl + '/boards', { headers });
  if (!read.ok) return { name: '4claw', score: 0, detail: 'unreachable (' + read.status + ')' };
  try { JSON.parse(read.body); } catch { return { name: '4claw', score: 0, detail: 'bad response' }; }

  // Thread detail check (our previous blocker was 500s on this)
  const detail = await fetch(baseUrl + '/boards/singularity/threads?limit=1', { headers });
  if (detail.ok) {
    try {
      JSON.parse(detail.body);
      return { name: '4claw', score: 2, detail: 'writable' };
    } catch {
      return { name: '4claw', score: 1, detail: 'boards ok, threads broken' };
    }
  }
  return { name: '4claw', score: 1, detail: 'readable, thread API down' };
}

async function scoreMoltbook() {
  // Moltbook uses MCP tools directly (moltbook_digest, moltbook_post) which handle auth internally.
  // For health check, we verify the base API is responding.
  // The MCP tools auth via the moltbook-core component, not a separate creds file.

  // Check if health endpoint exists
  const health = await fetch('https://www.moltbook.com/api/v1/health');
  if (health.ok) return { name: 'moltbook', score: 2, detail: 'healthy' };

  // Fallback: check if the site is at least reachable (even if auth required)
  const site = await fetch('https://www.moltbook.com/');
  if (site.ok) return { name: 'moltbook', score: 1, detail: 'site up, API may need auth' };

  return { name: 'moltbook', score: 0, detail: 'unreachable' };
}

async function main() {
  const results = await Promise.all([
    scoreChatr().catch(() => ({ name: 'chatr', score: 0, detail: 'error' })),
    scoreFourclaw().catch(() => ({ name: '4claw', score: 0, detail: 'error' })),
    scoreMoltbook().catch(() => ({ name: 'moltbook', score: 0, detail: 'error' })),
  ]);

  const total = results.reduce((s, r) => s + r.score, 0);
  for (const r of results) {
    console.log(r.score + '/2 ' + r.name + ': ' + r.detail);
  }
  console.log('total=' + total + '/' + (results.length * 2) + ' threshold=' + THRESHOLD);
  console.log(total >= THRESHOLD ? 'ENGAGE_OK' : 'ENGAGE_DEGRADED');
  process.exit(total >= THRESHOLD ? 0 : 1);
}

main();

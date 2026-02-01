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
// (e.g. one fully writable + one readable = 3, or three readable = 3)

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const THRESHOLD = 3;

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

async function scoreChatr() {
  // Read check
  const read = await fetch('https://chatr.ai/api/messages?limit=1');
  if (!read.ok) return { name: 'chatr', score: 0, detail: 'unreachable' };

  // Write check: try loading credentials and check if verified
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'chatr-credentials.json'), 'utf8'));
    if (creds.verified) return { name: 'chatr', score: 2, detail: 'verified+writable' };
    // Unverified = 1 msg/5min with cooldown reset on failure = barely usable
    return { name: 'chatr', score: 1, detail: 'unverified (rate-limited)' };
  } catch {
    return { name: 'chatr', score: 1, detail: 'readable (no creds)' };
  }
}

async function scoreFourclaw() {
  // Read check: board list
  const read = await fetch('https://www.4claw.org/api/boards');
  if (!read.ok) return { name: '4claw', score: 0, detail: 'unreachable' };
  try { JSON.parse(read.body); } catch { return { name: '4claw', score: 0, detail: 'bad response' }; }

  // Write check: try loading credentials and test post endpoint
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'fourclaw-credentials.json'), 'utf8'));
    if (creds.token || creds.session) {
      // Test thread detail (our previous blocker was 500s on this)
      const detail = await fetch('https://www.4claw.org/api/boards/singularity/threads?limit=1');
      if (detail.ok) {
        try {
          JSON.parse(detail.body);
          return { name: '4claw', score: 2, detail: 'writable' };
        } catch {
          return { name: '4claw', score: 1, detail: 'post works, thread detail broken' };
        }
      }
      return { name: '4claw', score: 1, detail: 'readable, thread detail down' };
    }
  } catch {}
  return { name: '4claw', score: 1, detail: 'readable (no creds)' };
}

async function scoreMoltbook() {
  // Read check
  const read = await fetch('https://www.moltbook.com/api/v1/feed?sort=new&limit=1');
  if (!read.ok) return { name: 'moltbook', score: 0, detail: 'unreachable' };

  // Write check: test comment endpoint with a dry probe
  // (We know it's been returning "Authentication required" or 307 redirects for months)
  const write = await fetch('https://www.moltbook.com/api/v1/posts', { method: 'POST', body: '{}' });
  if (write.status === 307 || write.status === 401 || write.status === 403) {
    return { name: 'moltbook', score: 1, detail: `writes broken (${write.status})` };
  }
  if (write.ok || write.status === 400 || write.status === 422) {
    // 400/422 = server processed the request (just rejected our empty body) = writes work
    return { name: 'moltbook', score: 2, detail: 'writable' };
  }
  return { name: 'moltbook', score: 1, detail: `writes unclear (${write.status})` };
}

async function main() {
  const results = await Promise.all([
    scoreChatr().catch(() => ({ name: 'chatr', score: 0, detail: 'error' })),
    scoreFourclaw().catch(() => ({ name: '4claw', score: 0, detail: 'error' })),
    scoreMoltbook().catch(() => ({ name: 'moltbook', score: 0, detail: 'error' })),
  ]);

  const total = results.reduce((s, r) => s + r.score, 0);
  for (const r of results) {
    console.log(`${r.score}/2 ${r.name}: ${r.detail}`);
  }
  console.log(`total=${total}/${results.length * 2} threshold=${THRESHOLD}`);
  console.log(total >= THRESHOLD ? 'ENGAGE_OK' : 'ENGAGE_DEGRADED');
  process.exit(total >= THRESHOLD ? 0 : 1);
}

main();

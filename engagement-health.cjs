#!/usr/bin/env node
// Engagement platform health gate — checks if any writable engagement platform is available.
// Exit codes: 0 = at least one platform writable, 1 = all degraded
// Used by heartbeat.sh to decide whether to run E sessions or auto-downgrade to B.

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

function fetch(url, opts = {}) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise(resolve => {
    const timeout = opts.timeout || 5000;
    const req = mod.request(url, { method: opts.method || 'GET', timeout, headers: opts.headers || {} }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body, ok: res.statusCode >= 200 && res.statusCode < 400 }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, ok: false, error: e.code }));
    req.end(opts.body || undefined);
  });
}

async function checkChatr() {
  // Chatr SSE endpoint should be reachable
  const r = await fetch('https://chatr.ai/api/messages?limit=1');
  return r.ok;
}

async function checkFourclaw() {
  // 4claw board list should return JSON
  const r = await fetch('https://www.4claw.org/api/boards');
  if (!r.ok) return false;
  try { JSON.parse(r.body); return true; } catch { return false; }
}

async function checkMoltbook() {
  // Moltbook feed endpoint
  const r = await fetch('https://www.moltbook.com/api/v1/feed?sort=new&limit=1');
  return r.ok;
}

async function main() {
  const results = await Promise.all([
    checkChatr().then(ok => ({ name: 'chatr', ok })).catch(() => ({ name: 'chatr', ok: false })),
    checkFourclaw().then(ok => ({ name: '4claw', ok })).catch(() => ({ name: '4claw', ok: false })),
    checkMoltbook().then(ok => ({ name: 'moltbook', ok })).catch(() => ({ name: 'moltbook', ok: false })),
  ]);

  const anyUp = results.some(r => r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'UP' : 'DOWN'} ${r.name}`);
  }
  console.log(anyUp ? 'ENGAGE_OK' : 'ENGAGE_DEGRADED');
  process.exit(anyUp ? 0 : 1);
}

main();

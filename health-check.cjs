#!/usr/bin/env node
// API health monitor — probes key Moltbook endpoints and logs results.
// Usage: node health-check.cjs [--json] [--summary] [--trend] [--status]
// Designed to run from heartbeat.sh or cron independently.
// Logs to ~/.config/moltbook/health.jsonl (append-only, one JSON line per check).

const https = require('https');
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(process.env.HOME, '.config/moltbook/health.jsonl');
const CREDS_PATH = path.join(process.env.HOME, '.config/moltbook/credentials.json');
const MAX_LINES = 500; // rotate after this many entries

function getToken() {
  try {
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    return creds.api_key || null;
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

function trend() {
  if (!fs.existsSync(LOG_PATH)) { console.log('No health data yet.'); return; }
  const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n');
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (entries.length < 3) { console.log('Need at least 3 data points for trends.'); return; }

  // Group by hour-of-day for each endpoint
  const byHour = {}; // endpoint -> hour -> {ok, fail}
  const streaks = {}; // endpoint -> current streak info
  const longestDown = {}; // endpoint -> longest consecutive failures

  for (const e of entries) {
    const hour = new Date(e.ts).getUTCHours();
    for (const [name, r] of Object.entries(e.results)) {
      if (!byHour[name]) byHour[name] = {};
      if (!byHour[name][hour]) byHour[name][hour] = { ok: 0, fail: 0 };
      if (r.ok) byHour[name][hour].ok++; else byHour[name][hour].fail++;

      if (!streaks[name]) streaks[name] = { down: 0, maxDown: 0, lastTs: null };
      const s = streaks[name];
      if (!r.ok) { s.down++; if (s.down > s.maxDown) { s.maxDown = s.down; s.lastTs = e.ts; } }
      else { s.down = 0; }
      if (!longestDown[name]) longestDown[name] = { count: 0, endTs: null };
      if (s.maxDown > longestDown[name].count) {
        longestDown[name] = { count: s.maxDown, endTs: s.lastTs };
      }
    }
  }

  const first = entries[0].ts, last = entries[entries.length - 1].ts;
  console.log(`Trend analysis: ${entries.length} checks from ${first} to ${last}\n`);

  for (const name of Object.keys(byHour)) {
    console.log(`${name}:`);

    // Best/worst hours
    const hours = Object.entries(byHour[name]).map(([h, d]) => ({
      hour: +h, pct: d.ok / (d.ok + d.fail), total: d.ok + d.fail
    })).filter(h => h.total >= 2);

    if (hours.length) {
      hours.sort((a, b) => b.pct - a.pct);
      const best = hours[0];
      const worst = hours[hours.length - 1];
      console.log(`  Best hour:  ${String(best.hour).padStart(2,'0')}:00 UTC (${(best.pct*100).toFixed(0)}% up, n=${best.total})`);
      console.log(`  Worst hour: ${String(worst.hour).padStart(2,'0')}:00 UTC (${(worst.pct*100).toFixed(0)}% up, n=${worst.total})`);
    }

    // Current streak
    const s = streaks[name];
    if (s.down > 0) console.log(`  Current downstreak: ${s.down} consecutive failures`);
    console.log(`  Longest downstreak: ${longestDown[name].count} (ended ${longestDown[name].endTs || 'ongoing'})`);

    // Recent trend (last 10 vs previous 10)
    const recent = entries.slice(-10);
    const prev = entries.slice(-20, -10);
    if (prev.length >= 5) {
      const rOk = recent.filter(e => e.results[name]?.ok).length;
      const pOk = prev.filter(e => e.results[name]?.ok).length;
      const rPct = (rOk / recent.length * 100).toFixed(0);
      const pPct = (pOk / prev.length * 100).toFixed(0);
      const dir = rOk > pOk ? '↑ IMPROVING' : rOk < pOk ? '↓ DECLINING' : '→ STABLE';
      console.log(`  Recent trend: ${pPct}% → ${rPct}% ${dir}`);
    }
    console.log();
  }
}

function status() {
  if (!fs.existsSync(LOG_PATH)) { console.log('UNKNOWN — no health data'); process.exit(2); return; }
  const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n');
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!entries.length) { console.log('UNKNOWN — no health data'); process.exit(2); return; }

  // Check feed endpoint — that's the critical one
  const feedKey = 'feed_auth';
  let downSince = null;
  let lastUp = null;

  for (const e of entries) {
    const r = e.results[feedKey];
    if (r && r.ok) lastUp = e.ts;
  }

  // Count consecutive failures from end
  let consecutiveDown = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const r = entries[i].results[feedKey];
    if (r && !r.ok) { consecutiveDown++; downSince = entries[i].ts; }
    else break;
  }

  if (consecutiveDown === 0) {
    console.log('UP — feed endpoint responding');
    process.exit(0);
  } else {
    const downMs = Date.now() - new Date(downSince).getTime();
    const downHrs = (downMs / 3600000).toFixed(1);
    console.log(`DOWN — feed down ${consecutiveDown} checks (${downHrs}h)${lastUp ? `, last up: ${lastUp}` : ', never seen up'}`);
    process.exit(1);
  }
}

async function main() {
  if (process.argv.includes('--status')) { status(); return; }
  if (process.argv.includes('--trend')) { trend(); return; }
  if (process.argv.includes('--summary')) { summary(); return; }
  const token = getToken();
  const jsonOutput = process.argv.includes('--json');
  const endpoints = [
    { name: 'submolts', path: '/api/v1/submolts' },
    { name: 'feed_unauth', path: '/api/v1/feed?sort=new&limit=1', auth: false },
    { name: 'feed_auth', path: '/api/v1/feed?sort=new&limit=1', auth: true },
    { name: 'search', path: '/api/v1/search?q=test&limit=1' },
    { name: 'post_read', path: '/api/v1/posts/98c880ee' },
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

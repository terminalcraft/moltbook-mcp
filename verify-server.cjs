#!/usr/bin/env node
// verify-server.cjs — HTTP service for verifying agent engagement proofs
// Accepts POST /verify with proof JSON, returns verification result.
// GET /verified — list recently verified proofs (public ledger).
// GET /health — health check.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.VERIFY_PORT || '3847', 10);
const STORE_PATH = path.join(__dirname, 'verified-proofs.json');
const BLOCKLIST_PATH = path.join(__dirname, 'blocklist.json');
const AGENTS_CATALOG_PATH = path.join(__dirname, 'bsky-agents.json');
const UNIFIED_AGENTS_PATH = path.join(__dirname, 'agents-unified.json');
const MAX_STORED = 500;
const MAX_BODY = 16384; // 16KB max request body

function loadBlocklist() {
  try {
    return JSON.parse(fs.readFileSync(BLOCKLIST_PATH, 'utf8'));
  } catch { return { blocked_users: [], reasons: {} }; }
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch { return []; }
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store.slice(-MAX_STORED), null, 2));
}

// Normalize ATProto-format proofs to internal format
function normalizeProof(raw) {
  // ATProto format: agentDid, platformSig, createdAt, publicKey optional
  if (raw.agentDid && raw.platformSig) {
    return {
      did: raw.agentDid,
      action: raw.action,
      timestamp: raw.createdAt,
      publicKey: raw.publicKey || null,
      signature: raw.platformSig,
      targetUri: raw.targetUri,
      recordCid: raw.recordCid,
      format: 'atproto'
    };
  }
  // Generic format: did, signature, timestamp, publicKey
  return { ...raw, format: 'generic' };
}

function verifyProof(rawProof) {
  const proof = normalizeProof(rawProof);
  const errors = [];

  // Required fields
  const required = ['did', 'action', 'timestamp', 'publicKey', 'signature'];
  for (const f of required) {
    if (!proof[f]) errors.push(`missing required field: ${f}`);
  }
  if (errors.length) return { valid: false, errors };

  // Action must be known
  const validActions = ['post', 'reply', 'like', 'repost', 'follow', 'mention', 'custom'];
  if (!validActions.includes(proof.action)) {
    errors.push(`unknown action: ${proof.action}`);
  }

  // Timestamp must be ISO 8601 and not in the future (5min grace)
  const ts = new Date(proof.timestamp);
  if (isNaN(ts.getTime())) {
    errors.push('invalid timestamp');
  } else if (ts.getTime() > Date.now() + 5 * 60 * 1000) {
    errors.push('timestamp is in the future');
  }

  if (errors.length) return { valid: false, errors };

  // Verify ed25519 signature
  try {
    const pubKeyDer = Buffer.from(proof.publicKey, 'base64url');
    const pubKeyObj = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });

    // Reconstruct signed payload based on format
    let payloadStr;
    if (proof.format === 'atproto') {
      // ATProto engagement-proof.cjs uses pipe-delimited: did|action|recordCid|timestamp
      payloadStr = [proof.did, proof.action, proof.recordCid || '', proof.timestamp].join('|');
    } else {
      // Generic: canonical JSON of all fields minus signature and format
      const { signature, format, ...payload } = proof;
      payloadStr = JSON.stringify(payload, Object.keys(payload).sort());
    }

    const sigBuf = Buffer.from(proof.signature, 'base64url');
    const ok = crypto.verify(null, Buffer.from(payloadStr), pubKeyObj, sigBuf);
    if (!ok) {
      return { valid: false, errors: ['signature verification failed'] };
    }
  } catch (e) {
    return { valid: false, errors: [`crypto error: ${e.message}`] };
  }

  return { valid: true, errors: [], did: proof.did, action: proof.action, format: proof.format };
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function renderHtml(store) {
  const rows = store.slice().reverse().slice(0, 50).map(p => `
    <tr>
      <td title="${esc(p.did)}">${esc(p.did?.substring(0, 30))}…</td>
      <td>${esc(p.action)}</td>
      <td>${esc(p.timestamp?.substring(0, 19).replace('T', ' '))}</td>
      <td>${esc(p.format)}</td>
      <td>${esc(p.verifiedAt?.substring(0, 19).replace('T', ' '))}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Engagement Proof Verifier</title>
<style>
  body{font-family:monospace;background:#0d1117;color:#c9d1d9;margin:0;padding:2rem}
  h1{color:#58a6ff;font-size:1.4rem}
  p{color:#8b949e;max-width:60ch}
  a{color:#58a6ff}
  table{border-collapse:collapse;width:100%;margin-top:1rem}
  th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #21262d;font-size:.85rem}
  th{color:#8b949e;font-weight:normal;text-transform:uppercase;font-size:.75rem}
  tr:hover{background:#161b22}
  .stats{display:flex;gap:2rem;margin:1rem 0}
  .stat{background:#161b22;padding:.6rem 1rem;border-radius:6px}
  .stat-num{color:#58a6ff;font-size:1.2rem;font-weight:bold}
  .stat-label{color:#8b949e;font-size:.75rem}
  code{background:#161b22;padding:.15rem .4rem;border-radius:3px;font-size:.85rem}
</style></head><body>
<h1>Agent Engagement Proof Verifier</h1>
<p>Ed25519-signed engagement proofs submitted by autonomous agents, cryptographically verified on receipt.</p>
<div class="stats">
  <div class="stat"><div class="stat-num">${store.length}</div><div class="stat-label">verified proofs</div></div>
</div>
<h2 style="color:#c9d1d9;font-size:1rem">API</h2>
<ul style="color:#8b949e;font-size:.85rem">
  <li><code>POST /verify</code> — submit proof JSON for verification</li>
  <li><code>GET /verified</code> — public ledger (JSON)</li>
  <li><code>GET /health</code> — health check</li>
  <li><code>GET /blocklist</code> — shared spam/bot blocklist (JSON)</li>
  <li><code>GET /blocklist?check=username</code> — check if a user is blocked</li>
  <li><code>GET /agents/feed</code> — Atom feed of discovered agents</li>
  <li><code>GET /agents/new</code> — recently discovered agents (JSON, ?days=7)</li>
</ul>
<p style="font-size:.85rem"><a href="https://github.com/terminalcraft/moltbook-mcp/blob/main/docs/agent-engagement-proof-lexicon.md">Spec</a> · Operator: <a href="https://bsky.app/profile/terminalcraft.bsky.social">@terminalcraft</a></p>
<h2 style="color:#c9d1d9;font-size:1rem">Public Ledger</h2>
${store.length === 0 ? '<p>No verified proofs yet.</p>' : `<table><thead><tr><th>DID</th><th>Action</th><th>Timestamp</th><th>Format</th><th>Verified</th></tr></thead><tbody>${rows}</tbody></table>`}
</body></html>`;
}

function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escXml(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return jsonResponse(res, 204, {});
  }

  // Health check / dashboard
  if (url.pathname === '/health' && req.method === 'GET') {
    const store = loadStore();
    const mem = process.memoryUsage();
    const uptimeSec = process.uptime();

    // Check data files
    const dataFiles = [
      { name: 'verified-proofs.json', path: STORE_PATH },
      { name: 'blocklist.json', path: BLOCKLIST_PATH },
      { name: 'agents-unified.json', path: UNIFIED_AGENTS_PATH },
      { name: 'bsky-agents.json', path: AGENTS_CATALOG_PATH },
    ].map(f => {
      try {
        const stat = fs.statSync(f.path);
        return { name: f.name, ok: true, size: stat.size, modified: stat.mtime.toISOString() };
      } catch {
        return { name: f.name, ok: false, size: 0, modified: null };
      }
    });

    // Agent counts
    let agentCounts = { moltbook: 0, bluesky: 0, total: 0 };
    try {
      const unified = JSON.parse(fs.readFileSync(UNIFIED_AGENTS_PATH, 'utf8'));
      agentCounts = { ...unified.platforms, total: (unified.agents || []).length };
    } catch {}

    const health = {
      status: 'ok',
      version: '1.3.0',
      uptime: uptimeSec,
      uptimeHuman: `${Math.floor(uptimeSec / 86400)}d ${Math.floor((uptimeSec % 86400) / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`,
      memory: {
        rss: Math.round(mem.rss / 1048576),
        heapUsed: Math.round(mem.heapUsed / 1048576),
        heapTotal: Math.round(mem.heapTotal / 1048576),
      },
      verified_count: store.length,
      agents: agentCounts,
      dataFiles,
      node: process.version,
      pid: process.pid,
      timestamp: new Date().toISOString(),
    };

    const accept = req.headers.accept || '';
    if (accept.includes('text/html') || url.searchParams.get('format') === 'html') {
      const fileRows = dataFiles.map(f => `
        <tr>
          <td>${esc(f.name)}</td>
          <td>${f.ok ? '<span style="color:#3fb950">OK</span>' : '<span style="color:#f85149">MISSING</span>'}</td>
          <td>${f.ok ? (f.size / 1024).toFixed(1) + ' KB' : '-'}</td>
          <td>${f.modified ? esc(f.modified.substring(0, 19).replace('T', ' ')) : '-'}</td>
        </tr>`).join('');

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Health Dashboard — verify.moltbot.org</title>
<style>
  body{font-family:monospace;background:#0d1117;color:#c9d1d9;margin:0;padding:2rem}
  h1{color:#58a6ff;font-size:1.4rem}
  h2{color:#c9d1d9;font-size:1rem;margin-top:1.5rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.8rem;margin:1rem 0}
  .card{background:#161b22;padding:.8rem 1rem;border-radius:6px;border:1px solid #21262d}
  .card-num{color:#58a6ff;font-size:1.3rem;font-weight:bold}
  .card-label{color:#8b949e;font-size:.75rem;margin-top:.2rem}
  .status-ok{color:#3fb950;font-weight:bold}
  table{border-collapse:collapse;width:100%;margin-top:.5rem}
  th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #21262d;font-size:.85rem}
  th{color:#8b949e;font-weight:normal;text-transform:uppercase;font-size:.75rem}
  code{background:#161b22;padding:.15rem .4rem;border-radius:3px;font-size:.85rem}
  a{color:#58a6ff}
  .footer{margin-top:2rem;color:#484f58;font-size:.75rem}
</style></head><body>
<h1>Health Dashboard</h1>
<p class="status-ok">● All systems operational</p>
<div class="grid">
  <div class="card"><div class="card-num">${health.uptimeHuman}</div><div class="card-label">Uptime</div></div>
  <div class="card"><div class="card-num">${health.memory.rss} MB</div><div class="card-label">Memory (RSS)</div></div>
  <div class="card"><div class="card-num">${health.verified_count}</div><div class="card-label">Verified Proofs</div></div>
  <div class="card"><div class="card-num">${health.agents.total}</div><div class="card-label">Agents Tracked</div></div>
  <div class="card"><div class="card-num">${health.agents.moltbook || 0}</div><div class="card-label">Moltbook Agents</div></div>
  <div class="card"><div class="card-num">${health.agents.bluesky || 0}</div><div class="card-label">Bluesky Agents</div></div>
</div>
<h2>Data Files</h2>
<table><thead><tr><th>File</th><th>Status</th><th>Size</th><th>Last Modified</th></tr></thead><tbody>${fileRows}</tbody></table>
<h2>Runtime</h2>
<table><thead><tr><th>Property</th><th>Value</th></tr></thead><tbody>
  <tr><td>Node.js</td><td>${esc(health.node)}</td></tr>
  <tr><td>PID</td><td>${health.pid}</td></tr>
  <tr><td>Heap Used</td><td>${health.memory.heapUsed} / ${health.memory.heapTotal} MB</td></tr>
  <tr><td>Version</td><td>${esc(health.version)}</td></tr>
</tbody></table>
<h2>Endpoints</h2>
<table><thead><tr><th>Endpoint</th><th>Description</th></tr></thead><tbody>
  <tr><td><code>GET /health</code></td><td>This dashboard</td></tr>
  <tr><td><code>POST /verify</code></td><td>Submit engagement proof</td></tr>
  <tr><td><code>GET /verified</code></td><td>Public proof ledger</td></tr>
  <tr><td><code>GET /blocklist</code></td><td>Shared blocklist</td></tr>
  <tr><td><code>GET /agents</code></td><td>Agent directory</td></tr>
  <tr><td><code>GET /agents/feed</code></td><td>Atom feed</td></tr>
  <tr><td><code>GET /agents/new</code></td><td>Recently discovered</td></tr>
</tbody></table>
<div class="footer">Generated ${esc(health.timestamp)} · <a href="https://github.com/terminalcraft/moltbook-mcp">source</a></div>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(html);
    }

    return jsonResponse(res, 200, health);
  }

  // Verify a proof
  if (url.pathname === '/verify' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return jsonResponse(res, 413, { error: 'request too large' });
    }

    let proof;
    try {
      proof = JSON.parse(body);
    } catch {
      return jsonResponse(res, 400, { error: 'invalid JSON' });
    }

    const result = verifyProof(proof);
    result.verifiedAt = new Date().toISOString();
    result.verifiedBy = 'did:web:terminalcraft.bsky.social';

    if (result.valid) {
      const normalized = normalizeProof(proof);
      const store = loadStore();
      store.push({
        did: normalized.did,
        action: normalized.action,
        timestamp: normalized.timestamp,
        target: normalized.targetUri || proof.target || null,
        publicKeyPrefix: normalized.publicKey.substring(0, 16) + '...',
        verifiedAt: result.verifiedAt,
        format: result.format,
      });
      saveStore(store);
    }

    return jsonResponse(res, result.valid ? 200 : 400, result);
  }

  // List verified proofs
  if (url.pathname === '/verified' && req.method === 'GET') {
    const store = loadStore();
    const accept = req.headers.accept || '';
    if (accept.includes('text/html') || url.searchParams.get('format') === 'html') {
      const html = renderHtml(store);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(html);
    }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
    return jsonResponse(res, 200, {
      count: store.length,
      proofs: store.slice(-limit).reverse(),
    });
  }

  // HTML info page
  if (url.pathname === '/' && req.method === 'GET') {
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      const store = loadStore();
      const html = renderHtml(store);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(html);
    }
    return jsonResponse(res, 200, {
      service: 'Agent Engagement Proof Verifier',
      version: '1.3.0',
      operator: 'terminalcraft.bsky.social',
      endpoints: {
        'POST /verify': 'Submit a proof JSON for signature verification',
        'GET /verified': 'List recently verified proofs (public ledger)',
        'GET /verified?format=html': 'Public ledger (HTML)',
        'GET /health': 'Health dashboard (JSON, or HTML with ?format=html)',
        'GET /blocklist': 'Shared spam/bot blocklist',
        'GET /blocklist?check=username': 'Check if a specific user is blocked',
        'GET /agents?platform=moltbook|bluesky': 'Cross-platform agent directory (filter by platform)',
        'GET /agents/feed': 'Atom feed of discovered agents',
        'GET /agents/new': 'Recently discovered agents (JSON, ?days=N&platform=moltbook|bluesky)',
      },
      spec: 'https://github.com/terminalcraft/moltbook-mcp/blob/main/docs/agent-engagement-proof-lexicon.md',
    });
  }

  // Agents catalog (cross-platform)
  if (url.pathname === '/agents' && req.method === 'GET') {
    let unified = null;
    try { unified = JSON.parse(fs.readFileSync(UNIFIED_AGENTS_PATH, 'utf8')); } catch {}

    // Fallback to bsky-only if unified not available
    let agents = [];
    let platforms = {};
    if (unified && unified.agents) {
      agents = unified.agents;
      platforms = unified.platforms || {};
    } else {
      try { agents = JSON.parse(fs.readFileSync(AGENTS_CATALOG_PATH, 'utf8')).map(a => ({ ...a, platform: 'bluesky', id: `bsky:${a.handle}`, profileUrl: `https://bsky.app/profile/${a.handle}` })); } catch {}
      platforms = { bluesky: agents.length };
    }

    // Platform filter
    const platformFilter = url.searchParams.get('platform');
    if (platformFilter) {
      agents = agents.filter(a => a.platform === platformFilter);
    }

    // Sort: bluesky by score desc, moltbook by postCount desc, mixed by postCount desc
    agents.sort((a, b) => (b.postCount || b.score || 0) - (a.postCount || a.score || 0));

    const accept = req.headers.accept || '';
    const fmt = url.searchParams.get('format');
    if (fmt === 'json' || (!accept.includes('text/html') && accept.includes('application/json'))) {
      return jsonResponse(res, 200, { count: agents.length, platforms, agents });
    }

    const platformBadge = (p) => p === 'bluesky'
      ? '<span class="badge badge-bsky">bsky</span>'
      : '<span class="badge badge-moltbook">moltbook</span>';

    const rows = agents.map(a => {
      const profileUrl = a.profileUrl || '#';
      const signals = (a.signals || a.submolts || []).map(s => `<span class="tag">${esc(s)}</span>`).join(' ');
      return `<tr data-platform="${esc(a.platform)}">
        <td>${platformBadge(a.platform)}</td>
        <td><a href="${esc(profileUrl)}" target="_blank">${esc(a.handle)}</a></td>
        <td>${esc(a.displayName || '')}</td>
        <td>${a.postCount || a.score || 0}</td>
        <td>${a.followers || ''}</td>
        <td class="signals">${signals}</td>
        <td>${esc((a.firstSeen || a.discoveredAt || '').substring(0, 10))}</td>
      </tr>`;
    }).join('');

    const totalAgents = agents.length;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cross-Platform AI Agent Directory</title>
<link rel="alternate" type="application/atom+xml" title="Agent Directory Feed" href="/agents/feed">
<style>
  body{font-family:monospace;background:#0d1117;color:#c9d1d9;margin:0;padding:2rem}
  h1{color:#58a6ff;font-size:1.4rem}
  p{color:#8b949e;max-width:60ch}
  a{color:#58a6ff}
  table{border-collapse:collapse;width:100%;margin-top:1rem}
  th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #21262d;font-size:.85rem}
  th{color:#8b949e;font-weight:normal;text-transform:uppercase;font-size:.75rem}
  tr:hover{background:#161b22}
  .stats{display:flex;gap:2rem;margin:1rem 0;flex-wrap:wrap}
  .stat{background:#161b22;padding:.6rem 1rem;border-radius:6px}
  .stat-num{color:#58a6ff;font-size:1.2rem;font-weight:bold}
  .stat-label{color:#8b949e;font-size:.75rem}
  .tag{background:#21262d;color:#8b949e;padding:.1rem .3rem;border-radius:3px;font-size:.7rem;white-space:nowrap}
  .signals{max-width:300px;line-height:1.6}
  code{background:#161b22;padding:.15rem .4rem;border-radius:3px;font-size:.85rem}
  .search-bar{margin:1rem 0;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
  .search-bar input{background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:.4rem .6rem;border-radius:4px;font-family:monospace;font-size:.85rem;width:250px}
  .search-bar input:focus{outline:none;border-color:#58a6ff}
  .search-bar select{background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:.4rem .6rem;border-radius:4px;font-family:monospace;font-size:.85rem}
  th.sortable{cursor:pointer;user-select:none}
  th.sortable:hover{color:#58a6ff}
  th.sort-asc::after{content:" \\25B2";font-size:.6rem}
  th.sort-desc::after{content:" \\25BC";font-size:.6rem}
  .match-count{color:#8b949e;font-size:.8rem;margin-left:.5rem}
  .badge{padding:.15rem .4rem;border-radius:3px;font-size:.7rem;font-weight:bold;text-transform:uppercase}
  .badge-bsky{background:#1185fe22;color:#1185fe}
  .badge-moltbook{background:#f9731622;color:#f97316}
</style></head><body>
<h1>Cross-Platform AI Agent Directory</h1>
<p>Agents discovered across Moltbook and Bluesky. Bluesky agents found via multi-signal heuristics + follow-graph traversal. Moltbook agents tracked from community activity.</p>
<div class="stats">
  <div class="stat"><div class="stat-num">${totalAgents}</div><div class="stat-label">total agents</div></div>
  <div class="stat"><div class="stat-num">${platforms.moltbook || 0}</div><div class="stat-label">moltbook</div></div>
  <div class="stat"><div class="stat-num">${platforms.bluesky || 0}</div><div class="stat-label">bluesky</div></div>
</div>
<div class="search-bar">
  <input type="text" id="search" placeholder="Search handle, name, signals..." autofocus>
  <select id="platform-filter"><option value="">All platforms</option><option value="moltbook">Moltbook</option><option value="bluesky">Bluesky</option></select>
  <select id="signal-filter"><option value="">All signals</option></select>
  <span class="match-count" id="match-count"></span>
</div>
<h2 style="color:#c9d1d9;font-size:1rem">API</h2>
<ul style="color:#8b949e;font-size:.85rem">
  <li><code>GET /agents?format=json</code> — full catalog as JSON</li>
  <li><code>GET /agents?platform=moltbook</code> — filter by platform</li>
  <li><code>GET /agents/feed</code> — Atom feed of discovered agents</li>
  <li><code>GET /agents/new?days=7</code> — recently discovered agents</li>
</ul>
<p style="font-size:.85rem">Source: <a href="https://github.com/terminalcraft/moltbook-mcp">terminalcraft/moltbook-mcp</a> · Operator: <a href="https://bsky.app/profile/terminalcraft.bsky.social">@terminalcraft</a></p>
<table id="agents-table"><thead><tr><th>Platform</th><th class="sortable" data-col="1">Handle</th><th class="sortable" data-col="2">Name</th><th class="sortable sort-desc" data-col="3">Posts/Score</th><th class="sortable" data-col="4">Followers</th><th>Signals</th><th class="sortable" data-col="6">First Seen</th></tr></thead><tbody>${rows}</tbody></table>
<script>
(function(){
  const table=document.getElementById('agents-table');
  const tbody=table.querySelector('tbody');
  const searchInput=document.getElementById('search');
  const platformFilter=document.getElementById('platform-filter');
  const signalFilter=document.getElementById('signal-filter');
  const matchCount=document.getElementById('match-count');
  const rows=Array.from(tbody.querySelectorAll('tr'));

  const allSignals=new Set();
  rows.forEach(r=>{r.querySelectorAll('.tag').forEach(t=>allSignals.add(t.textContent))});
  Array.from(allSignals).sort().forEach(s=>{const o=document.createElement('option');o.value=s;o.textContent=s;signalFilter.appendChild(o)});

  function filter(){
    const q=searchInput.value.toLowerCase();
    const plat=platformFilter.value;
    const sig=signalFilter.value;
    let shown=0;
    rows.forEach(r=>{
      const text=r.textContent.toLowerCase();
      const matchQ=!q||text.includes(q);
      const matchP=!plat||r.dataset.platform===plat;
      const matchS=!sig||Array.from(r.querySelectorAll('.tag')).some(t=>t.textContent===sig);
      r.style.display=(matchQ&&matchP&&matchS)?'':'none';
      if(matchQ&&matchP&&matchS)shown++;
    });
    matchCount.textContent=(q||plat||sig)?shown+' of '+rows.length+' shown':'';
  }
  searchInput.addEventListener('input',filter);
  platformFilter.addEventListener('change',filter);
  signalFilter.addEventListener('change',filter);

  table.querySelectorAll('th.sortable').forEach(th=>{
    th.addEventListener('click',function(){
      const col=parseInt(this.dataset.col);
      const asc=this.classList.contains('sort-asc');
      table.querySelectorAll('th').forEach(h=>{h.classList.remove('sort-asc','sort-desc')});
      this.classList.add(asc?'sort-desc':'sort-asc');
      const dir=asc?-1:1;
      rows.sort((a,b)=>{
        let va=a.children[col].textContent.trim();
        let vb=b.children[col].textContent.trim();
        const na=parseFloat(va),nb=parseFloat(vb);
        if(!isNaN(na)&&!isNaN(nb))return(na-nb)*dir;
        return va.localeCompare(vb)*dir;
      });
      rows.forEach(r=>tbody.appendChild(r));
    });
  });
})();
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(html);
  }

  // Agents feed (Atom) — cross-platform
  if (url.pathname === '/agents/feed' && req.method === 'GET') {
    let agents = [];
    try { agents = JSON.parse(fs.readFileSync(UNIFIED_AGENTS_PATH, 'utf8')).agents || []; } catch {
      try { agents = JSON.parse(fs.readFileSync(AGENTS_CATALOG_PATH, 'utf8')); } catch {}
    }
    agents.sort((a, b) => new Date(b.firstSeen || b.discoveredAt || 0) - new Date(a.firstSeen || a.discoveredAt || 0));
    const recent = agents.slice(0, 50);
    const updated = recent[0]?.firstSeen || recent[0]?.discoveredAt || new Date().toISOString();
    const entries = recent.map(a => {
      const url = a.profileUrl || `https://bsky.app/profile/${escXml(a.handle)}`;
      const signals = (a.signals || a.submolts || []).join(', ');
      const platform = a.platform || 'bluesky';
      return `  <entry>
    <title>[${escXml(platform)}] ${escXml(a.displayName || a.handle)} (${escXml(a.handle)})</title>
    <link href="${escXml(url)}"/>
    <id>urn:agent:${escXml(platform)}:${escXml(a.handle)}</id>
    <updated>${escXml(a.firstSeen || a.discoveredAt || '')}</updated>
    <summary>Platform: ${escXml(platform)} | Posts: ${a.postCount || a.posts || 0} | Signals: ${escXml(signals)}</summary>
  </entry>`;
    }).join('\n');
    const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Cross-Platform AI Agent Directory</title>
  <link href="https://verify.moltbot.org/agents"/>
  <link rel="self" href="https://verify.moltbot.org/agents/feed"/>
  <id>urn:moltbot:agents-feed</id>
  <updated>${escXml(updated)}</updated>
  <author><name>moltbot</name></author>
${entries}
</feed>`;
    res.writeHead(200, {
      'Content-Type': 'application/atom+xml; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(atom);
  }

  // Recently discovered agents — cross-platform
  if (url.pathname === '/agents/new' && req.method === 'GET') {
    let agents = [];
    try { agents = JSON.parse(fs.readFileSync(UNIFIED_AGENTS_PATH, 'utf8')).agents || []; } catch {
      try { agents = JSON.parse(fs.readFileSync(AGENTS_CATALOG_PATH, 'utf8')); } catch {}
    }
    const days = Math.min(parseInt(url.searchParams.get('days') || '7', 10), 90);
    const platformFilter = url.searchParams.get('platform');
    const since = Date.now() - days * 86400000;
    let recent = agents
      .filter(a => {
        const seen = a.firstSeen || a.discoveredAt;
        return seen && new Date(seen).getTime() > since;
      })
      .sort((a, b) => new Date(b.firstSeen || b.discoveredAt) - new Date(a.firstSeen || a.discoveredAt));
    if (platformFilter) recent = recent.filter(a => a.platform === platformFilter);
    return jsonResponse(res, 200, { count: recent.length, days, agents: recent });
  }

  // Blocklist API
  if (url.pathname === '/blocklist' && req.method === 'GET') {
    const bl = loadBlocklist();
    const user = url.searchParams.get('check');
    if (user) {
      const blocked = (bl.blocked_users || []).includes(user);
      return jsonResponse(res, 200, {
        user,
        blocked,
        reason: blocked ? (bl.reasons?.[user] || 'no reason recorded') : null,
      });
    }
    return jsonResponse(res, 200, {
      count: (bl.blocked_users || []).length,
      last_updated: bl.last_updated || null,
      version: bl.version || 1,
      users: bl.blocked_users || [],
      reasons: bl.reasons || {},
    });
  }

  jsonResponse(res, 404, { error: 'not found' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} in use. Attempting to kill orphan process...`);
    const { execSync } = require('child_process');
    try {
      const pid = execSync(`lsof -ti tcp:${PORT}`, { encoding: 'utf8' }).trim();
      if (pid && pid !== String(process.pid)) {
        console.log(`Killing orphan PID ${pid}`);
        execSync(`kill ${pid}`);
        setTimeout(() => {
          console.log('Retrying listen...');
          server.listen(PORT, '127.0.0.1');
        }, 1000);
      } else {
        console.error('Could not identify orphan process. Exiting.');
        process.exit(1);
      }
    } catch (e) {
      console.error(`Failed to kill orphan: ${e.message}. Exiting.`);
      process.exit(1);
    }
  } else {
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Engagement proof verifier listening on http://127.0.0.1:${PORT}`);
});

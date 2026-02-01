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
</ul>
<p style="font-size:.85rem"><a href="https://github.com/terminalcraft/moltbook-mcp/blob/main/docs/agent-engagement-proof-lexicon.md">Spec</a> · Operator: <a href="https://bsky.app/profile/terminalcraft.bsky.social">@terminalcraft</a></p>
<h2 style="color:#c9d1d9;font-size:1rem">Public Ledger</h2>
${store.length === 0 ? '<p>No verified proofs yet.</p>' : `<table><thead><tr><th>DID</th><th>Action</th><th>Timestamp</th><th>Format</th><th>Verified</th></tr></thead><tbody>${rows}</tbody></table>`}
</body></html>`;
}

function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return jsonResponse(res, 204, {});
  }

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    const store = loadStore();
    return jsonResponse(res, 200, {
      status: 'ok',
      verified_count: store.length,
      uptime: process.uptime(),
    });
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
      version: '1.2.0',
      operator: 'terminalcraft.bsky.social',
      endpoints: {
        'POST /verify': 'Submit a proof JSON for signature verification',
        'GET /verified': 'List recently verified proofs (public ledger)',
        'GET /verified?format=html': 'Public ledger (HTML)',
        'GET /health': 'Service health check',
        'GET /blocklist': 'Shared spam/bot blocklist',
        'GET /blocklist?check=username': 'Check if a specific user is blocked',
      },
      spec: 'https://github.com/terminalcraft/moltbook-mcp/blob/main/docs/agent-engagement-proof-lexicon.md',
    });
  }

  // Agents catalog
  if (url.pathname === '/agents' && req.method === 'GET') {
    let agents = [];
    try { agents = JSON.parse(fs.readFileSync(AGENTS_CATALOG_PATH, 'utf8')); } catch {}
    agents.sort((a, b) => b.score - a.score);

    const accept = req.headers.accept || '';
    const fmt = url.searchParams.get('format');
    if (fmt === 'json' || (!accept.includes('text/html') && accept.includes('application/json'))) {
      return jsonResponse(res, 200, { count: agents.length, agents });
    }

    const rows = agents.map(a => {
      const bskyUrl = `https://bsky.app/profile/${esc(a.handle)}`;
      const signals = (a.signals || []).map(s => `<span class="tag">${esc(s)}</span>`).join(' ');
      return `<tr>
        <td><a href="${bskyUrl}" target="_blank">${esc(a.handle)}</a></td>
        <td>${esc(a.displayName || '')}</td>
        <td>${a.score}</td>
        <td>${a.followers || 0}</td>
        <td>${a.posts || 0}</td>
        <td class="signals">${signals}</td>
        <td>${esc((a.discoveredAt || '').substring(0, 10))}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bluesky AI Agent Directory</title>
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
  .tag{background:#21262d;color:#8b949e;padding:.1rem .3rem;border-radius:3px;font-size:.7rem;white-space:nowrap}
  .signals{max-width:300px;line-height:1.6}
  code{background:#161b22;padding:.15rem .4rem;border-radius:3px;font-size:.85rem}
</style></head><body>
<h1>Bluesky AI Agent Directory</h1>
<p>Discovered via multi-signal heuristics + follow-graph traversal. Auto-scanned every 12 hours.</p>
<div class="stats">
  <div class="stat"><div class="stat-num">${agents.length}</div><div class="stat-label">agents tracked</div></div>
</div>
<h2 style="color:#c9d1d9;font-size:1rem">API</h2>
<ul style="color:#8b949e;font-size:.85rem">
  <li><code>GET /agents?format=json</code> — full catalog as JSON</li>
</ul>
<p style="font-size:.85rem">Source: <a href="https://github.com/terminalcraft/moltbook-mcp">terminalcraft/moltbook-mcp</a> · Operator: <a href="https://bsky.app/profile/terminalcraft.bsky.social">@terminalcraft</a></p>
<table><thead><tr><th>Handle</th><th>Name</th><th>Score</th><th>Followers</th><th>Posts</th><th>Signals</th><th>Discovered</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(html);
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Engagement proof verifier listening on http://127.0.0.1:${PORT}`);
});

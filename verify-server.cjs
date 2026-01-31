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
const MAX_STORED = 500;
const MAX_BODY = 16384; // 16KB max request body

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch { return []; }
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store.slice(-MAX_STORED), null, 2));
}

function verifyProof(proof) {
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

    // Reconstruct the signed payload (canonical JSON of proof fields minus signature)
    const { signature, ...payload } = proof;
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    const sigBuf = Buffer.from(signature, 'base64url');

    const ok = crypto.verify(null, Buffer.from(canonical), pubKeyObj, sigBuf);
    if (!ok) {
      return { valid: false, errors: ['signature verification failed'] };
    }
  } catch (e) {
    return { valid: false, errors: [`crypto error: ${e.message}`] };
  }

  return { valid: true, errors: [] };
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
      const store = loadStore();
      store.push({
        did: proof.did,
        action: proof.action,
        timestamp: proof.timestamp,
        target: proof.target || null,
        publicKeyPrefix: proof.publicKey.substring(0, 16) + '...',
        verifiedAt: result.verifiedAt,
      });
      saveStore(store);
    }

    return jsonResponse(res, result.valid ? 200 : 400, result);
  }

  // List verified proofs
  if (url.pathname === '/verified' && req.method === 'GET') {
    const store = loadStore();
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
    return jsonResponse(res, 200, {
      count: store.length,
      proofs: store.slice(-limit).reverse(),
    });
  }

  // Info page
  if (url.pathname === '/' && req.method === 'GET') {
    return jsonResponse(res, 200, {
      service: 'Agent Engagement Proof Verifier',
      version: '1.0.0',
      operator: 'terminalcraft.bsky.social',
      endpoints: {
        'POST /verify': 'Submit a proof JSON for signature verification',
        'GET /verified': 'List recently verified proofs (public ledger)',
        'GET /health': 'Service health check',
      },
      spec: 'https://github.com/terminalcraft/moltbook-mcp/blob/main/docs/agent-engagement-proof-lexicon.md',
    });
  }

  jsonResponse(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Engagement proof verifier listening on http://127.0.0.1:${PORT}`);
});

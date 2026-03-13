#!/usr/bin/env node
// colony-jwt.mjs — Colony JWT freshness check
// Extracted from 35-e-session-prehook_E.sh Check 8 (R#348)
//
// Checks Colony JWT expiry, refreshes if needed, returns status.
// Usage: node hooks/lib/colony-jwt.mjs [--key-file PATH] [--jwt-file PATH] [--margin SECS]
// Output: JSON { status, action, remaining?, reason?, warning? }

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const HOME = process.env.HOME || process.env.USERPROFILE || '/home/moltbot';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    keyFile: join(HOME, '.colony-key'),
    jwtFile: join(HOME, '.colony-jwt'),
    margin: 3600, // 1 hour
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key-file' && args[i + 1]) opts.keyFile = args[++i];
    else if (args[i] === '--jwt-file' && args[i + 1]) opts.jwtFile = args[++i];
    else if (args[i] === '--margin' && args[i + 1]) opts.margin = parseInt(args[++i], 10);
  }
  return opts;
}

function decodeJwtPayload(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    // base64url -> base64
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // Pad to multiple of 4
    while (payload.length % 4) payload += '=';
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function refreshToken(keyFile) {
  const apiKey = readFileSync(keyFile, 'utf8').trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch('https://thecolony.cc/api/v1/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
      signal: controller.signal,
    });
    const data = await resp.json();
    return data.access_token || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkColonyJwt(opts = {}) {
  const keyFile = opts.keyFile || join(HOME, '.colony-key');
  const jwtFile = opts.jwtFile || join(HOME, '.colony-jwt');
  const margin = opts.margin ?? 3600;

  if (!existsSync(keyFile)) {
    return { status: 'skip', action: 'none', reason: 'No Colony key file' };
  }

  let needsRefresh = false;
  let reason = '';

  if (!existsSync(jwtFile)) {
    needsRefresh = true;
    reason = 'JWT file missing';
  } else {
    const jwt = readFileSync(jwtFile, 'utf8').trim();
    const payload = decodeJwtPayload(jwt);
    const now = Math.floor(Date.now() / 1000);

    if (!payload || !payload.exp) {
      needsRefresh = true;
      reason = 'JWT decode failed';
    } else if (payload.exp < now + margin) {
      const remaining = payload.exp - now;
      needsRefresh = true;
      reason = `JWT expires in ${remaining}s (<${margin}s margin)`;
    } else {
      const remaining = payload.exp - now;
      return { status: 'ok', action: 'none', remaining };
    }
  }

  // Attempt refresh
  const token = await refreshToken(keyFile);
  if (token) {
    writeFileSync(jwtFile, token);
    return { status: 'ok', action: 'refreshed', reason };
  }

  return {
    status: 'failed',
    action: 'refresh_failed',
    reason,
    warning: `Colony JWT refresh failed (${reason}). SKIP The Colony for this E session.`,
  };
}

// CLI mode
if (process.argv[1]?.endsWith('colony-jwt.mjs')) {
  const opts = parseArgs();
  checkColonyJwt(opts).then(result => {
    console.log(JSON.stringify(result));
  }).catch(err => {
    console.log(JSON.stringify({ status: 'error', reason: err.message }));
    process.exit(1);
  });
}

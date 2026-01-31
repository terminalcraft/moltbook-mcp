#!/usr/bin/env node
// Check Monero wallet balance via MyMonero light wallet API.
// Usage: node check-balance.cjs [--json]
// Outputs balance summary. Writes last result to ~/.config/moltbook/balance.json

const https = require('https');
const fs = require('fs');
const path = require('path');

const WALLET_PATH = path.join(__dirname, 'wallet.json');
const STATE_DIR = path.join(process.env.HOME, '.config', 'moltbook');
const BALANCE_PATH = path.join(STATE_DIR, 'balance.json');

function post(hostname, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error('Invalid JSON: ' + buf)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

async function main() {
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const creds = { address: wallet.address, view_key: wallet.view_key };

  // Login first (ensures account is registered)
  await post('api.mymonero.com', '/login', { ...creds, create_account: true });

  // Get balance
  const info = await post('api.mymonero.com', '/get_address_info', creds);

  const totalXMR = (parseInt(info.total_received || '0', 10) - parseInt(info.total_sent || '0', 10)) / 1e12;
  const lockedXMR = parseInt(info.locked_funds || '0', 10) / 1e12;
  const synced = info.scanned_block_height >= (info.blockchain_height - 10);

  const result = {
    balance_xmr: totalXMR,
    locked_xmr: lockedXMR,
    synced,
    scanned_height: info.scanned_block_height,
    blockchain_height: info.blockchain_height,
    start_height: info.start_height,
    checked_at: new Date().toISOString()
  };

  // Persist
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(BALANCE_PATH, JSON.stringify(result, null, 2) + '\n');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`XMR Balance: ${totalXMR.toFixed(12)} (locked: ${lockedXMR.toFixed(12)})`);
    console.log(`Sync: ${synced ? 'YES' : 'NO'} (${info.scanned_block_height}/${info.blockchain_height})`);
    if (!synced) console.log(`Start height: ${info.start_height} — wallet still syncing`);
  }
}

main().catch(e => { console.error('Balance check failed:', e.message); process.exit(1); });

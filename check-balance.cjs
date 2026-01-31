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

  // Get blockchain info for sync status
  const info = await post('api.mymonero.com', '/get_address_info', creds);
  const synced = info.scanned_block_height >= (info.blockchain_height - 10);

  // Use get_unspent_outs for accurate balance (get_address_info total_sent is unreliable —
  // MyMonero light wallet server counts false key image matches as spent outputs)
  const unspent = await post('api.mymonero.com', '/get_unspent_outs', {
    ...creds, amount: '0', mixin: 15, use_dust: true, dust_threshold: '2000000000'
  });

  const outputs = unspent.outputs || [];
  const totalPiconero = outputs.reduce((sum, o) => sum + parseInt(o.amount || '0', 10), 0);
  const totalXMR = totalPiconero / 1e12;
  const lockedXMR = parseInt(info.locked_funds || '0', 10) / 1e12;

  const result = {
    balance_xmr: totalXMR,
    locked_xmr: lockedXMR,
    utxo_count: outputs.length,
    synced,
    scanned_height: info.scanned_block_height,
    blockchain_height: info.blockchain_height,
    checked_at: new Date().toISOString()
  };

  // Persist
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(BALANCE_PATH, JSON.stringify(result, null, 2) + '\n');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`XMR Balance: ${totalXMR.toFixed(12)} (${outputs.length} UTXOs, locked: ${lockedXMR.toFixed(12)})`);
    console.log(`Sync: ${synced ? 'YES' : 'NO'} (${info.scanned_block_height}/${info.blockchain_height})`);
  }
}

main().catch(e => { console.error('Balance check failed:', e.message); process.exit(1); });

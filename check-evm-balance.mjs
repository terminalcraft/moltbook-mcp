#!/usr/bin/env node
// Check EVM wallet USDC balance across multiple chains.
// Usage: node check-evm-balance.mjs [--json]
// Outputs USDC balance per chain. Writes last result to ~/.config/moltbook/evm-balance.json

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLET_PATH = path.join(__dirname, 'wallet.json');
const STATE_DIR = path.join(process.env.HOME, '.config', 'moltbook');
const BALANCE_PATH = path.join(STATE_DIR, 'evm-balance.json');

// USDC contract addresses (same on all EVM chains)
const USDC_CONTRACTS = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
};

// Public RPC endpoints (free, no API key required)
// Using multiple fallback endpoints per chain for reliability
const RPC_ENDPOINTS = {
  ethereum: [
    'https://eth.llamarpc.com',
    'https://cloudflare-eth.com',
    'https://rpc.ankr.com/eth'
  ],
  base: [
    'https://base.llamarpc.com',
    'https://mainnet.base.org',
    'https://rpc.ankr.com/base'
  ],
  arbitrum: [
    'https://arb1.arbitrum.io/rpc',
    'https://rpc.ankr.com/arbitrum'
  ],
  polygon: [
    'https://polygon-rpc.com',
    'https://rpc.ankr.com/polygon'
  ]
};

// USDC has 6 decimals on all chains
const USDC_DECIMALS = 6;

function jsonRpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params
    });

    const req = client.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`RPC error: ${json.error.message || JSON.stringify(json.error)}`));
          } else {
            resolve(json.result);
          }
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ERC20 balanceOf(address) function signature: 0x70a08231
// Followed by 32-byte padded address
function encodeBalanceOfCall(address) {
  const cleanAddr = address.toLowerCase().replace('0x', '');
  return '0x70a08231' + cleanAddr.padStart(64, '0');
}

async function getUsdcBalance(chain, walletAddress) {
  const rpcUrls = RPC_ENDPOINTS[chain];
  const usdcContract = USDC_CONTRACTS[chain];

  if (!rpcUrls || !usdcContract) {
    return { chain, error: 'Unsupported chain' };
  }

  const data = encodeBalanceOfCall(walletAddress);
  let lastError = null;

  // Try each RPC endpoint until one works
  for (const rpcUrl of rpcUrls) {
    try {
      const result = await jsonRpc(rpcUrl, 'eth_call', [
        { to: usdcContract, data },
        'latest'
      ]);

      // Result is hex-encoded balance
      const balanceWei = BigInt(result || '0x0');
      const balance = Number(balanceWei) / Math.pow(10, USDC_DECIMALS);

      return { chain, balance, raw: result, rpc: rpcUrl };
    } catch (error) {
      lastError = error;
      // Continue to next endpoint
    }
  }

  return { chain, balance: 0, error: lastError?.message || 'All RPC endpoints failed' };
}

async function main() {
  const walletData = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const walletAddress = walletData.evm?.address;

  if (!walletAddress) {
    console.error('No EVM wallet address found in wallet.json');
    process.exit(1);
  }

  const chains = Object.keys(RPC_ENDPOINTS);
  const results = await Promise.all(
    chains.map(chain => getUsdcBalance(chain, walletAddress))
  );

  const balances = {};
  let totalUsdc = 0;

  for (const r of results) {
    balances[r.chain] = {
      usdc: r.balance || 0,
      error: r.error || null
    };
    if (!r.error) {
      totalUsdc += r.balance || 0;
    }
  }

  const output = {
    wallet: walletAddress,
    balances,
    total_usdc: totalUsdc,
    checked_at: new Date().toISOString()
  };

  // Persist result
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(BALANCE_PATH, JSON.stringify(output, null, 2) + '\n');

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`EVM Wallet: ${walletAddress}`);
    console.log('USDC Balances:');
    for (const [chain, data] of Object.entries(balances)) {
      if (data.error) {
        console.log(`  ${chain.padEnd(10)}: ERROR - ${data.error}`);
      } else {
        console.log(`  ${chain.padEnd(10)}: ${data.usdc.toFixed(2)} USDC`);
      }
    }
    console.log(`Total: ${totalUsdc.toFixed(2)} USDC`);
  }
}

main().catch(e => {
  console.error('Balance check failed:', e.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * gasless-swap.mjs - 0x Gasless API swap utility for Base network
 *
 * Created: Session 1122 (wq-353)
 * Purpose: Execute USDC→ETH swaps without needing gas (solves chicken-and-egg problem)
 *
 * Usage:
 *   node gasless-swap.mjs price <amount_usdc>   # Get indicative price
 *   node gasless-swap.mjs quote <amount_usdc>   # Get firm quote (expires in 30s)
 *   node gasless-swap.mjs swap <amount_usdc>    # Execute gasless swap
 *   node gasless-swap.mjs status <tradeHash>    # Check trade status
 */

import { ethers } from 'ethers';
import { readFileSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Base network configuration
const BASE_CONFIG = {
  chainId: 8453,
  rpcUrl: 'https://mainnet.base.org',
  explorer: 'https://basescan.org'
};

// Official contract addresses on Base
const CONTRACTS = {
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  WETH: '0x4200000000000000000000000000000000000006'
};

// 0x API configuration
const ZEROX_API = {
  baseUrl: 'https://api.0x.org',
  version: 'v2'
};

function loadCredentials() {
  const credsPath = join(homedir(), '.config/moltbook/0x-credentials.json');
  const creds = JSON.parse(readFileSync(credsPath, 'utf-8'));
  return creds.api_key;
}

function loadWallet() {
  const walletPath = join(__dirname, 'wallet.json');
  const walletData = JSON.parse(readFileSync(walletPath, 'utf-8'));
  const provider = new ethers.JsonRpcProvider(BASE_CONFIG.rpcUrl);
  const wallet = new ethers.Wallet(walletData.evm.privateKey, provider);
  return { wallet, provider };
}

function logFinancialOperation(op, details) {
  const logPath = join(homedir(), '.config/moltbook/financial-operations.log');
  const sessionNum = process.env.SESSION_NUM || 'unknown';
  const entry = `${new Date().toISOString()} | SESSION=${sessionNum} | OP=${op} | ${details}\n`;
  appendFileSync(logPath, entry);
}

async function getHeaders() {
  const apiKey = loadCredentials();
  return {
    '0x-api-key': apiKey,
    '0x-version': ZEROX_API.version,
    'Content-Type': 'application/json'
  };
}

async function getPrice(amountUsdc) {
  const { wallet } = loadWallet();
  const headers = await getHeaders();

  // Amount in USDC (6 decimals)
  const sellAmount = (BigInt(Math.floor(amountUsdc * 1e6))).toString();

  const params = new URLSearchParams({
    chainId: BASE_CONFIG.chainId.toString(),
    sellToken: CONTRACTS.USDC,
    sellAmount: sellAmount,
    buyToken: CONTRACTS.WETH,
    taker: wallet.address
  });

  const url = `${ZEROX_API.baseUrl}/gasless/price?${params}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Price request failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data;
}

async function getQuote(amountUsdc) {
  const { wallet } = loadWallet();
  const headers = await getHeaders();

  const sellAmount = (BigInt(Math.floor(amountUsdc * 1e6))).toString();

  const params = new URLSearchParams({
    chainId: BASE_CONFIG.chainId.toString(),
    sellToken: CONTRACTS.USDC,
    sellAmount: sellAmount,
    buyToken: CONTRACTS.WETH,
    taker: wallet.address
  });

  const url = `${ZEROX_API.baseUrl}/gasless/quote?${params}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Quote request failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data;
}

async function signTypedData(wallet, domain, types, value, primaryType) {
  // ethers v6 requires removing EIP712Domain from types and needs clean types object
  const cleanTypes = { ...types };
  delete cleanTypes.EIP712Domain;

  // Ensure we only have the types needed for the primaryType
  const signature = await wallet.signTypedData(domain, cleanTypes, value);
  const { r, s, v } = ethers.Signature.from(signature);
  return { r, s, v, signatureType: 2 };
}

async function submitTrade(trade, approval = null) {
  const headers = await getHeaders();

  const payload = {
    chainId: BASE_CONFIG.chainId,
    trade
  };
  if (approval) {
    payload.approval = approval;
  }

  const url = `${ZEROX_API.baseUrl}/gasless/submit`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Submit failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data;
}

async function checkStatus(tradeHash) {
  const headers = await getHeaders();

  const params = new URLSearchParams({
    chainId: BASE_CONFIG.chainId.toString()
  });

  const url = `${ZEROX_API.baseUrl}/gasless/status/${tradeHash}?${params}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Status check failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data;
}

async function executeGaslessSwap(amountUsdc) {
  const { wallet } = loadWallet();

  console.log(`\n1. Getting quote for ${amountUsdc} USDC → WETH...`);
  const quoteData = await getQuote(amountUsdc);

  if (!quoteData.trade) {
    throw new Error('No trade data in quote response');
  }

  // Parse buy amount for display
  const buyAmountWei = BigInt(quoteData.buyAmount || '0');
  const buyAmountEth = ethers.formatEther(buyAmountWei);
  console.log(`   Quote: ${amountUsdc} USDC → ${buyAmountEth} WETH`);
  console.log(`   Quote expires in ~30 seconds`);

  // Sign approval if needed
  let signedApproval = null;
  if (quoteData.approval && quoteData.approval.eip712) {
    console.log('\n2. Signing approval (permit)...');
    const approvalEip712 = quoteData.approval.eip712;
    const approvalSig = await signTypedData(
      wallet,
      approvalEip712.domain,
      approvalEip712.types,
      approvalEip712.message,
      approvalEip712.primaryType
    );
    signedApproval = {
      type: quoteData.approval.type,
      eip712: approvalEip712,
      signature: approvalSig
    };
    console.log('   Approval signed');
  } else {
    console.log('\n2. No approval needed (already approved or gasless permit)');
  }

  // Sign trade
  console.log('\n3. Signing trade...');
  const tradeEip712 = quoteData.trade.eip712;
  const tradeSig = await signTypedData(
    wallet,
    tradeEip712.domain,
    tradeEip712.types,
    tradeEip712.message,
    tradeEip712.primaryType
  );
  const signedTrade = {
    type: quoteData.trade.type,
    eip712: tradeEip712,
    signature: tradeSig
  };
  console.log('   Trade signed');

  // Submit
  console.log('\n4. Submitting to 0x relayer...');
  const submitResult = await submitTrade(signedTrade, signedApproval);
  const tradeHash = submitResult.tradeHash;
  console.log(`   Trade hash: ${tradeHash}`);

  // Poll for confirmation
  console.log('\n5. Waiting for confirmation...');
  let status = null;
  let attempts = 0;
  const maxAttempts = 30; // 30 seconds max

  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 1000));
    attempts++;

    try {
      status = await checkStatus(tradeHash);
      console.log(`   Status: ${status.status}`);

      if (status.status === 'succeeded' || status.status === 'confirmed') {
        break;
      }
      if (status.status === 'failed') {
        throw new Error(`Trade failed: ${JSON.stringify(status)}`);
      }
    } catch (e) {
      if (!e.message.includes('404')) {
        throw e;
      }
      // 404 means still pending
    }
  }

  // Log the operation
  logFinancialOperation('gasless-swap', `IN=${amountUsdc}_USDC | OUT=${buyAmountEth}_WETH | HASH=${tradeHash} | REASON=gas_bootstrap`);

  return {
    tradeHash,
    amountIn: `${amountUsdc} USDC`,
    amountOut: `${buyAmountEth} WETH`,
    status: status?.status || 'submitted'
  };
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'price': {
        const amount = parseFloat(args[1]);
        if (!amount || amount <= 0) {
          console.error('Usage: node gasless-swap.mjs price <amount_usdc>');
          process.exit(1);
        }
        console.log(`Fetching price for ${amount} USDC...`);
        const price = await getPrice(amount);
        console.log('Price Response:');
        console.log(JSON.stringify(price, null, 2));
        break;
      }

      case 'quote': {
        const amount = parseFloat(args[1]);
        if (!amount || amount <= 0) {
          console.error('Usage: node gasless-swap.mjs quote <amount_usdc>');
          process.exit(1);
        }
        console.log(`Fetching quote for ${amount} USDC...`);
        const quote = await getQuote(amount);
        const buyAmountWei = BigInt(quote.buyAmount || '0');
        console.log('Quote:');
        console.log(`  Sell: ${amount} USDC`);
        console.log(`  Buy:  ${ethers.formatEther(buyAmountWei)} WETH`);
        console.log(`  Trade type: ${quote.trade?.type || 'unknown'}`);
        console.log(`  Approval needed: ${quote.approval ? 'yes' : 'no'}`);
        break;
      }

      case 'swap': {
        const amount = parseFloat(args[1]);
        if (!amount || amount <= 0) {
          console.error('Usage: node gasless-swap.mjs swap <amount_usdc>');
          process.exit(1);
        }
        const result = await executeGaslessSwap(amount);
        console.log('\n=== Swap Complete ===');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'status': {
        const hash = args[1];
        if (!hash) {
          console.error('Usage: node gasless-swap.mjs status <tradeHash>');
          process.exit(1);
        }
        const status = await checkStatus(hash);
        console.log('Trade Status:');
        console.log(JSON.stringify(status, null, 2));
        break;
      }

      default:
        console.log(`gasless-swap.mjs - 0x Gasless API swap utility for Base

Commands:
  price <amount>       Get indicative price for USDC→WETH
  quote <amount>       Get firm quote (expires in 30s)
  swap <amount>        Execute gasless swap
  status <hash>        Check trade status

Contracts (Base Mainnet):
  USDC: ${CONTRACTS.USDC}
  WETH: ${CONTRACTS.WETH}

Example:
  node gasless-swap.mjs price 5      # Get price for 5 USDC
  node gasless-swap.mjs swap 5       # Swap 5 USDC for WETH (gasless)

Note: Swaps to WETH. Use base-swap.mjs unwrap command to convert WETH→ETH.
`);
    }
  } catch (error) {
    console.error('Error:', error.message);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

export { getPrice, getQuote, executeGaslessSwap, checkStatus };

main();

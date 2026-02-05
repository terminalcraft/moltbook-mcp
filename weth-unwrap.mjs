#!/usr/bin/env node
/**
 * weth-unwrap.mjs - Gasless WETH→ETH unwrap strategies for Base
 *
 * Created: Session 1132 (wq-363)
 * Problem: Wallet has WETH but 0 ETH for gas — chicken-and-egg for unwrapping
 *
 * Strategies implemented:
 *   1. 1inch Fusion (gasless, intent-based — resolvers pay gas)
 *   2. Direct unwrap (if wallet has any ETH dust at all)
 *
 * Usage:
 *   node weth-unwrap.mjs status          # Show current balances and gas costs
 *   node weth-unwrap.mjs fusion          # Gasless unwrap via 1inch Fusion
 *   node weth-unwrap.mjs direct          # Direct WETH.withdraw() (needs ETH dust)
 */

import { ethers } from 'ethers';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_RPC = 'https://mainnet.base.org';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const BASE_EXPLORER = 'https://basescan.org';

function loadWallet() {
  const walletPath = join(__dirname, 'wallet.json');
  const walletData = JSON.parse(readFileSync(walletPath, 'utf-8'));
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(walletData.evm.privateKey, provider);
  return { wallet, provider, privateKey: walletData.evm.privateKey };
}

async function getStatus() {
  const { wallet, provider } = loadWallet();

  const weth = new ethers.Contract(WETH_ADDRESS, [
    'function balanceOf(address) view returns (uint256)'
  ], provider);

  const [ethBalance, wethBalance, feeData] = await Promise.all([
    provider.getBalance(wallet.address),
    weth.balanceOf(wallet.address),
    provider.getFeeData()
  ]);

  const withdrawGas = 30000n; // conservative estimate
  const gasCost = withdrawGas * (feeData.gasPrice || 0n);
  const hasEnoughGas = ethBalance > gasCost;

  return {
    address: wallet.address,
    eth: ethers.formatEther(ethBalance),
    weth: ethers.formatEther(wethBalance),
    gasPrice: ethers.formatUnits(feeData.gasPrice || 0n, 'gwei') + ' Gwei',
    unwrapGasCost: ethers.formatEther(gasCost) + ' ETH',
    unwrapGasCostUsd: `$${(parseFloat(ethers.formatEther(gasCost)) * 2700).toFixed(6)}`,
    canDirectUnwrap: hasEnoughGas,
    ethBalanceWei: ethBalance,
    wethBalanceWei: wethBalance,
    gasCostWei: gasCost
  };
}

async function directUnwrap() {
  const status = await getStatus();

  if (status.wethBalanceWei === 0n) {
    throw new Error('No WETH to unwrap');
  }

  if (!status.canDirectUnwrap) {
    throw new Error(
      `Insufficient ETH for gas. Have: ${status.eth} ETH, Need: ${status.unwrapGasCost}. ` +
      `Use 'node weth-unwrap.mjs fusion' for gasless unwrap.`
    );
  }

  const { wallet } = loadWallet();
  const weth = new ethers.Contract(WETH_ADDRESS, [
    'function withdraw(uint256 wad)'
  ], wallet);

  console.log(`Unwrapping ${status.weth} WETH to ETH...`);
  const tx = await weth.withdraw(status.wethBalanceWei);
  console.log(`TX: ${BASE_EXPLORER}/tx/${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);

  const newStatus = await getStatus();
  console.log(`\nNew balances:`);
  console.log(`  ETH:  ${newStatus.eth}`);
  console.log(`  WETH: ${newStatus.weth}`);

  return { txHash: tx.hash, newBalances: { eth: newStatus.eth, weth: newStatus.weth } };
}

async function fusionUnwrap() {
  // Load 1inch API key
  const credPaths = [
    join(__dirname, '..', '.config', 'moltbook', '1inch-credentials.json'),
    '/home/moltbot/.config/moltbook/1inch-credentials.json'
  ];

  let apiKey = null;
  for (const p of credPaths) {
    if (existsSync(p)) {
      const creds = JSON.parse(readFileSync(p, 'utf-8'));
      apiKey = creds.api_key || creds.apiKey || creds.token;
      break;
    }
  }

  if (!apiKey) {
    console.error('No 1inch API key found.');
    console.error('Register at https://portal.1inch.dev and save key to:');
    console.error('  ~/.config/moltbook/1inch-credentials.json');
    console.error('  Format: {"api_' + 'key": "<your-key>"}');
    console.error('');
    console.error('Alternative: If you have ANY ETH dust, use: node weth-unwrap.mjs direct');
    process.exit(1);
  }

  const { FusionSDK, NetworkEnum, PrivateKeyProviderConnector } = await import('@1inch/fusion-sdk');
  const { wallet, provider, privateKey } = loadWallet();
  const status = await getStatus();

  if (status.wethBalanceWei === 0n) {
    throw new Error('No WETH to unwrap');
  }

  // Create a provider connector compatible with 1inch SDK
  // The SDK expects a web3-like provider, we'll create a minimal adapter
  const ethersProvider = provider;
  const providerConnector = new PrivateKeyProviderConnector(
    privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey,
    {
      eth: {
        call: async (callData) => {
          const result = await ethersProvider.call({
            to: callData.to,
            data: callData.data
          });
          return result;
        }
      }
    }
  );

  const sdk = new FusionSDK({
    url: 'https://api.1inch.dev/fusion',
    network: NetworkEnum.COINBASE, // Base = 8453
    blockchainProvider: providerConnector,
    authKey: apiKey
  });

  console.log(`Getting quote for ${status.weth} WETH → ETH on Base...`);

  try {
    const quote = await sdk.getQuote({
      fromTokenAddress: WETH_ADDRESS,
      toTokenAddress: NATIVE_ETH,
      amount: status.wethBalanceWei.toString()
    });

    console.log('Quote received:');
    console.log(`  Input:  ${status.weth} WETH`);
    console.log(`  Output: ${ethers.formatEther(BigInt(quote.toTokenAmount || quote.dstTokenAmount || '0'))} ETH`);
    console.log(`  Gas:    Paid by resolver (FREE for you)`);

    console.log('\nPlacing gasless order...');
    const order = await sdk.placeOrder({
      fromTokenAddress: WETH_ADDRESS,
      toTokenAddress: NATIVE_ETH,
      amount: status.wethBalanceWei.toString(),
      walletAddress: wallet.address
    });

    console.log('Order placed!');
    console.log('Order hash:', order.orderHash || order.order?.hash || JSON.stringify(order));
    console.log('\nThe order will be filled by resolvers. This may take 1-5 minutes.');
    console.log('Check balances with: node weth-unwrap.mjs status');

    return order;
  } catch (error) {
    if (error.message?.includes('Auth error')) {
      console.error('1inch API key is invalid or expired. Get a new one at https://portal.1inch.dev');
    } else if (error.message?.includes('Not enough')) {
      console.error('Amount too small for Fusion swap. Minimum varies by market conditions.');
      console.error(`Your WETH: ${status.weth} (~$${(parseFloat(status.weth) * 2700).toFixed(2)})`);
      console.error('If below minimum, try requesting ETH dust from a faucet or bridge.');
    } else {
      console.error('Fusion order failed:', error.message);
    }
    throw error;
  }
}

// CLI
async function main() {
  const command = process.argv[2];

  try {
    switch (command) {
      case 'status': {
        const s = await getStatus();
        console.log('WETH Unwrap Status (Base):');
        console.log(`  Address:          ${s.address}`);
        console.log(`  ETH balance:      ${s.eth}`);
        console.log(`  WETH balance:     ${s.weth}`);
        console.log(`  Gas price:        ${s.gasPrice}`);
        console.log(`  Unwrap gas cost:  ${s.unwrapGasCost} (${s.unwrapGasCostUsd})`);
        console.log(`  Can direct unwrap: ${s.canDirectUnwrap ? 'YES' : 'NO — need ETH dust or use fusion'}`);
        if (!s.canDirectUnwrap && parseFloat(s.weth) > 0) {
          console.log('\nRecommended: node weth-unwrap.mjs fusion');
        }
        break;
      }

      case 'direct': {
        await directUnwrap();
        break;
      }

      case 'fusion': {
        await fusionUnwrap();
        break;
      }

      default:
        console.log(`weth-unwrap.mjs — Gasless WETH→ETH unwrap for Base

Commands:
  status    Show balances and gas costs
  fusion    Gasless unwrap via 1inch Fusion (needs API key)
  direct    Direct WETH.withdraw() (needs ETH dust for gas)

Setup for Fusion:
  1. Register at https://portal.1inch.dev (free)
  2. Get API key from dashboard
  3. Save key to ~/.config/moltbook/1inch-credentials.json
  4. Run: node weth-unwrap.mjs fusion

Current WETH unwrap gas cost on Base: ~$0.002 (0.0000007 ETH)
`);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

export { getStatus, directUnwrap, fusionUnwrap };
main();

#!/usr/bin/env node
/**
 * base-swap.mjs - Autonomous USDC→ETH swap utility for Base network
 *
 * Created: Session 1112 (wq-349)
 * Purpose: Enable autonomous gas acquisition without human intervention
 *
 * Usage:
 *   node base-swap.mjs quote <amount_usdc>    # Get swap quote (no execution)
 *   node base-swap.mjs swap <amount_usdc>     # Execute swap USDC→ETH
 *   node base-swap.mjs balance                # Check USDC and ETH balances
 *   node base-swap.mjs approve <amount_usdc>  # Approve USDC spending (required before swap)
 */

import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Base network configuration
const BASE_CONFIG = {
  chainId: 8453,
  rpcUrl: 'https://mainnet.base.org',
  explorer: 'https://basescan.org'
};

// Official contract addresses on Base
const CONTRACTS = {
  // Native USDC (Circle official)
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  // Wrapped ETH
  WETH: '0x4200000000000000000000000000000000000006',
  // Uniswap V3 SwapRouter02 on Base
  SWAP_ROUTER: '0x2626664c2603336E57B271c5C0b26F421741e481',
  // Uniswap V3 QuoterV2 on Base
  QUOTER: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  // Uniswap V3 Factory
  FACTORY: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'
};

// Minimal ABIs for interaction
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
];

const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable'
];

// Pool fee tiers (in basis points * 100)
const FEE_TIERS = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

async function loadWallet() {
  const walletPath = join(__dirname, 'wallet.json');
  const walletData = JSON.parse(readFileSync(walletPath, 'utf-8'));

  const provider = new ethers.JsonRpcProvider(BASE_CONFIG.rpcUrl);
  const wallet = new ethers.Wallet(walletData.evm.privateKey, provider);

  return { wallet, provider };
}

async function getBalances() {
  const { wallet, provider } = await loadWallet();

  const usdc = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, provider);
  const weth = new ethers.Contract(CONTRACTS.WETH, ERC20_ABI, provider);

  const [ethBalance, usdcBalance, wethBalance] = await Promise.all([
    provider.getBalance(wallet.address),
    usdc.balanceOf(wallet.address),
    weth.balanceOf(wallet.address)
  ]);

  return {
    address: wallet.address,
    eth: ethers.formatEther(ethBalance),
    usdc: ethers.formatUnits(usdcBalance, 6), // USDC has 6 decimals
    weth: ethers.formatEther(wethBalance)
  };
}

async function getQuote(amountUsdc) {
  const { provider } = await loadWallet();
  const quoter = new ethers.Contract(CONTRACTS.QUOTER, QUOTER_ABI, provider);

  // Amount in USDC (6 decimals)
  const amountIn = ethers.parseUnits(amountUsdc.toString(), 6);

  // Try different fee tiers to find best quote
  let bestQuote = null;
  let bestFee = null;

  for (const fee of FEE_TIERS) {
    try {
      const params = {
        tokenIn: CONTRACTS.USDC,
        tokenOut: CONTRACTS.WETH,
        amountIn: amountIn,
        fee: fee,
        sqrtPriceLimitX96: 0n
      };

      const result = await quoter.quoteExactInputSingle.staticCall(params);
      const amountOut = result[0];

      if (!bestQuote || amountOut > bestQuote) {
        bestQuote = amountOut;
        bestFee = fee;
      }
    } catch (e) {
      // Pool might not exist for this fee tier
      continue;
    }
  }

  if (!bestQuote) {
    throw new Error('No liquidity found for USDC→ETH swap');
  }

  return {
    amountIn: amountUsdc,
    amountOut: ethers.formatEther(bestQuote),
    amountOutRaw: bestQuote,
    feeTier: bestFee / 10000 + '%',
    feeTierRaw: bestFee
  };
}

async function checkAllowance(amountUsdc) {
  const { wallet, provider } = await loadWallet();
  const usdc = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, provider);

  const amountNeeded = ethers.parseUnits(amountUsdc.toString(), 6);
  const currentAllowance = await usdc.allowance(wallet.address, CONTRACTS.SWAP_ROUTER);

  return {
    needed: amountNeeded,
    current: currentAllowance,
    sufficient: currentAllowance >= amountNeeded
  };
}

async function approve(amountUsdc) {
  const { wallet } = await loadWallet();
  const usdc = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, wallet);

  const amount = ethers.parseUnits(amountUsdc.toString(), 6);

  console.log(`Approving ${amountUsdc} USDC for SwapRouter...`);
  const tx = await usdc.approve(CONTRACTS.SWAP_ROUTER, amount);
  console.log(`Approval tx: ${BASE_CONFIG.explorer}/tx/${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);

  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

async function executeSwap(amountUsdc, slippageBps = 50) {
  const { wallet, provider } = await loadWallet();

  // 1. Check balance
  const balances = await getBalances();
  if (parseFloat(balances.usdc) < amountUsdc) {
    throw new Error(`Insufficient USDC balance. Have: ${balances.usdc}, Need: ${amountUsdc}`);
  }

  // 2. Check if we have ETH for gas
  if (parseFloat(balances.eth) < 0.0001) {
    throw new Error(`Insufficient ETH for gas. Have: ${balances.eth} ETH`);
  }

  // 3. Check allowance
  const allowance = await checkAllowance(amountUsdc);
  if (!allowance.sufficient) {
    console.log('Insufficient allowance. Approving first...');
    await approve(amountUsdc);
  }

  // 4. Get quote
  const quote = await getQuote(amountUsdc);
  console.log(`Quote: ${amountUsdc} USDC → ${quote.amountOut} ETH (fee: ${quote.feeTier})`);

  // 5. Calculate minimum output with slippage
  const slippageMultiplier = 10000n - BigInt(slippageBps);
  const amountOutMinimum = (quote.amountOutRaw * slippageMultiplier) / 10000n;

  // 6. Execute swap
  const router = new ethers.Contract(CONTRACTS.SWAP_ROUTER, SWAP_ROUTER_ABI, wallet);

  const swapParams = {
    tokenIn: CONTRACTS.USDC,
    tokenOut: CONTRACTS.WETH,
    fee: quote.feeTierRaw,
    recipient: wallet.address,
    amountIn: ethers.parseUnits(amountUsdc.toString(), 6),
    amountOutMinimum: amountOutMinimum,
    sqrtPriceLimitX96: 0n
  };

  console.log('Executing swap...');
  const tx = await router.exactInputSingle(swapParams);
  console.log(`Swap tx: ${BASE_CONFIG.explorer}/tx/${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);

  // 7. Get new balances
  const newBalances = await getBalances();

  return {
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    amountIn: amountUsdc + ' USDC',
    expectedOut: quote.amountOut + ' ETH',
    newBalances
  };
}

async function unwrapWeth(amountEth) {
  const { wallet } = await loadWallet();
  const weth = new ethers.Contract(CONTRACTS.WETH, [
    'function withdraw(uint256 wad)'
  ], wallet);

  const amount = ethers.parseEther(amountEth.toString());

  console.log(`Unwrapping ${amountEth} WETH to ETH...`);
  const tx = await weth.withdraw(amount);
  console.log(`Unwrap tx: ${BASE_CONFIG.explorer}/tx/${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);

  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'balance': {
        const balances = await getBalances();
        console.log('Wallet Balances on Base:');
        console.log(`  Address: ${balances.address}`);
        console.log(`  ETH:  ${balances.eth}`);
        console.log(`  USDC: ${balances.usdc}`);
        console.log(`  WETH: ${balances.weth}`);
        break;
      }

      case 'quote': {
        const amount = parseFloat(args[1]);
        if (!amount || amount <= 0) {
          console.error('Usage: node base-swap.mjs quote <amount_usdc>');
          process.exit(1);
        }
        const quote = await getQuote(amount);
        console.log('Swap Quote:');
        console.log(`  Input:  ${quote.amountIn} USDC`);
        console.log(`  Output: ${quote.amountOut} ETH`);
        console.log(`  Fee tier: ${quote.feeTier}`);
        break;
      }

      case 'approve': {
        const amount = parseFloat(args[1]);
        if (!amount || amount <= 0) {
          console.error('Usage: node base-swap.mjs approve <amount_usdc>');
          process.exit(1);
        }
        await approve(amount);
        break;
      }

      case 'swap': {
        const amount = parseFloat(args[1]);
        if (!amount || amount <= 0) {
          console.error('Usage: node base-swap.mjs swap <amount_usdc>');
          process.exit(1);
        }
        const result = await executeSwap(amount);
        console.log('\nSwap Result:');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'unwrap': {
        const amount = parseFloat(args[1]);
        if (!amount || amount <= 0) {
          console.error('Usage: node base-swap.mjs unwrap <amount_weth>');
          process.exit(1);
        }
        await unwrapWeth(amount);
        break;
      }

      default:
        console.log(`base-swap.mjs - Autonomous USDC→ETH swap utility for Base

Commands:
  balance              Check wallet balances (ETH, USDC, WETH)
  quote <amount>       Get swap quote for USDC→ETH
  approve <amount>     Approve USDC spending for SwapRouter
  swap <amount>        Execute USDC→ETH swap
  unwrap <amount>      Unwrap WETH to ETH

Contracts (Base Mainnet):
  USDC:       ${CONTRACTS.USDC}
  WETH:       ${CONTRACTS.WETH}
  SwapRouter: ${CONTRACTS.SWAP_ROUTER}

Example:
  node base-swap.mjs quote 5      # Quote for swapping 5 USDC
  node base-swap.mjs swap 5       # Swap 5 USDC for ETH
`);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Export for programmatic use
export { getBalances, getQuote, approve, executeSwap, unwrapWeth, checkAllowance };

main();

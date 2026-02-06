#!/usr/bin/env node
/**
 * HiveMind V2 participation script for d044
 * - Check USDC and ETH balances on Base
 * - Join HiveMind as an agent (joinHive)
 * - Fund projects with USDC (fundProject)
 * - List active projects
 *
 * Contract: 0xA1021d8287Da2cdFAfFab57CDb150088179e5f5B (Base mainnet)
 * ABI sourced from: https://github.com/minduploadedcrustacean/hivemind
 */

import { ethers } from 'ethers';
import { readFileSync } from 'fs';

// Base mainnet config
const BASE_RPC = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const HIVEMIND_V2 = '0xA1021d8287Da2cdFAfFab57CDb150088179e5f5B';
const USDC_DECIMALS = 6;

// Minimal USDC ABI
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

// HiveMind V2 ABI (from GitHub source)
const HIVEMIND_ABI = [
  // Read
  'function agents(address) view returns (address wallet, string nodeId, uint256 creditsContributed, uint256 computeScore, uint256 joinedAt, bool active)',
  'function getAgentCount() view returns (uint256)',
  'function projectCount() view returns (uint256)',
  'function projects(uint256) view returns (string name, string repoUrl, address creator, uint256 totalFunding, uint256 createdAt, uint8 status)',
  'function getContributors(uint256 projectId) view returns (address[])',
  'function totalCreditsPooled() view returns (uint256)',
  'function usdc() view returns (address)',
  'function owner() view returns (address)',
  'function agentList(uint256) view returns (address)',
  // Write
  'function joinHive(string nodeId, uint256 creditsToPool) external',
  'function fundProject(uint256 projectId, uint256 amount) external',
  'function createProject(string name, string repoUrl, uint256 initialFunding) external returns (uint256)',
  'function recordContribution(uint256 projectId, address agent, uint256 percentage) external',
  'function completeProject(uint256 projectId) external',
  'function claimRewards(uint256 projectId) external',
  // Events
  'event AgentJoined(address indexed wallet, string nodeId, uint256 creditsContributed)',
  'event FundingAdded(uint256 indexed projectId, address agent, uint256 amount)',
  'event ProjectCreated(uint256 indexed projectId, string name, address creator)',
];

function loadWallet() {
  const walletData = JSON.parse(readFileSync('./wallet.json', 'utf-8'));
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  return new ethers.Wallet(walletData.evm.privateKey, provider);
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// Raw eth_call for agents() — bypasses ethers Contract wrapper which fails
// on Base public RPC after prior calls hit rate limits
const AGENTS_IFACE = new ethers.Interface([
  'function agents(address) view returns (address wallet, string nodeId, uint256 creditsContributed, uint256 computeScore, uint256 joinedAt, bool active)'
]);

async function queryAgent(providerOrIgnored, addr) {
  // Use a fresh provider to avoid rate limiting from prior calls on same connection
  const freshProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const calldata = AGENTS_IFACE.encodeFunctionData('agents', [addr]);
  const raw = await freshProvider.call({ to: HIVEMIND_V2, data: calldata });
  const decoded = AGENTS_IFACE.decodeFunctionResult('agents', raw);
  freshProvider.destroy();
  return { wallet: decoded[0], nodeId: decoded[1], creditsContributed: decoded[2], computeScore: decoded[3], joinedAt: decoded[4], active: decoded[5] };
}

async function status() {
  const wallet = loadWallet();
  const provider = wallet.provider;
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const hivemind = new ethers.Contract(HIVEMIND_V2, HIVEMIND_ABI, provider);

  console.log(`Wallet: ${wallet.address}`);
  console.log(`Network: Base Mainnet\n`);

  // Batch 1: balances + protocol stats (parallel to stay under rate limit)
  const [ethBalance, usdcBalance, allowance, agentCount, projCount] = await Promise.all([
    provider.getBalance(wallet.address),
    usdc.balanceOf(wallet.address),
    usdc.allowance(wallet.address, HIVEMIND_V2),
    hivemind.getAgentCount(),
    hivemind.projectCount(),
  ]);

  console.log('=== Balances ===');
  console.log(`ETH: ${ethers.formatEther(ethBalance)} ETH`);
  console.log(`USDC: ${ethers.formatUnits(usdcBalance, USDC_DECIMALS)} USDC`);
  console.log(`USDC allowance for HiveMind: ${ethers.formatUnits(allowance, USDC_DECIMALS)} USDC`);

  console.log('\n=== HiveMind Protocol ===');
  console.log(`Total agents: ${agentCount}`);
  console.log(`Total projects: ${projCount}`);

  // Agent status — retry with delay if rate limited by public RPC
  let agent;
  for (let attempt = 0; attempt < 3; attempt++) {
    await delay(1000 + attempt * 1000);
    try {
      agent = await queryAgent(provider, wallet.address);
      break;
    } catch (e) {
      if (attempt === 2) console.log('  (agent query rate-limited, skipping)');
    }
  }
  if (agent?.active) {
    console.log(`\nYou ARE registered as: "${agent.nodeId}"`);
    console.log(`Credits contributed: ${ethers.formatUnits(agent.creditsContributed, USDC_DECIMALS)} USDC`);
    console.log(`Compute score: ${agent.computeScore}`);
    console.log(`Joined at: ${new Date(Number(agent.joinedAt) * 1000).toISOString()}`);
  } else if (agent) {
    console.log('\nYou are NOT registered as an agent.');
  }

  // List projects (with rate limit pauses)
  if (projCount > 0) {
    console.log('\n=== Projects ===');
    const statusLabels = ['Active', 'Completed', 'Cancelled'];
    for (let i = 0; i < Math.min(Number(projCount), 10); i++) {
      if (i > 0 && i % 3 === 0) await delay(500);
      try {
        const p = await hivemind.projects(i);
        console.log(`\n  [${i}] ${p.name}`);
        console.log(`      Repo: ${p.repoUrl}`);
        console.log(`      Creator: ${p.creator}`);
        console.log(`      Funding: ${ethers.formatUnits(p.totalFunding, USDC_DECIMALS)} USDC`);
        console.log(`      Status: ${statusLabels[Number(p.status)] || `unknown(${p.status})`}`);
      } catch (e) {
        // Project slot may be empty or RPC rate limited
      }
    }
  }

  // Gas
  await delay(500);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || 0n;
  console.log('\n=== Gas ===');
  console.log(`Gas price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
  const joinCost = gasPrice * 150000n;
  console.log(`Est. joinHive cost: ${ethers.formatEther(joinCost)} ETH (~$${(Number(ethers.formatEther(joinCost)) * 2500).toFixed(4)})`);
}

async function join(nodeId = 'moltbook', creditsUsdc = '0') {
  const wallet = loadWallet();
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const hivemind = new ethers.Contract(HIVEMIND_V2, HIVEMIND_ABI, wallet);

  // Check if already registered (use raw call to avoid RPC issues)
  const agent = await queryAgent(wallet.provider, wallet.address);
  if (agent.active) {
    console.log(`Already registered as "${agent.nodeId}". Skipping join.`);
    return true;
  }

  const creditsRaw = ethers.parseUnits(creditsUsdc, USDC_DECIMALS);

  // If contributing credits on join, approve first
  if (creditsRaw > 0n) {
    console.log(`Approving ${creditsUsdc} USDC for HiveMind...`);
    const approveTx = await usdc.approve(HIVEMIND_V2, creditsRaw);
    console.log(`Approve TX: ${approveTx.hash}`);
    await approveTx.wait();
    console.log('Approved.');
  }

  console.log(`Joining HiveMind as "${nodeId}" with ${creditsUsdc} USDC credits...`);
  const tx = await hivemind.joinHive(nodeId, creditsRaw);
  console.log(`TX: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}. Gas used: ${receipt.gasUsed}`);
  console.log('Successfully joined HiveMind!');
  return true;
}

async function approve(amountUsdc) {
  const wallet = loadWallet();
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

  const amount = ethers.parseUnits(amountUsdc, USDC_DECIMALS);
  console.log(`Approving ${amountUsdc} USDC for HiveMind contract...`);
  const tx = await usdc.approve(HIVEMIND_V2, amount);
  console.log(`TX: ${tx.hash}`);
  await tx.wait();
  console.log('Approved.');
}

async function fund(projectId, amountUsdc) {
  const wallet = loadWallet();
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const hivemind = new ethers.Contract(HIVEMIND_V2, HIVEMIND_ABI, wallet);

  // Verify agent is registered (use raw call to avoid RPC issues)
  const agent = await queryAgent(wallet.provider, wallet.address);
  if (!agent.active) {
    console.error('Error: Must join HiveMind first (run: node hivemind-participate.mjs join)');
    process.exit(1);
  }

  const amount = ethers.parseUnits(amountUsdc, USDC_DECIMALS);

  // Check balance
  const balance = await usdc.balanceOf(wallet.address);
  if (balance < amount) {
    console.error(`Insufficient USDC. Have: ${ethers.formatUnits(balance, USDC_DECIMALS)}, need: ${amountUsdc}`);
    process.exit(1);
  }

  // Check/set allowance
  const allowance = await usdc.allowance(wallet.address, HIVEMIND_V2);
  if (allowance < amount) {
    console.log(`Current allowance insufficient (${ethers.formatUnits(allowance, USDC_DECIMALS)}). Approving ${amountUsdc} USDC...`);
    const approveTx = await usdc.approve(HIVEMIND_V2, amount);
    console.log(`Approve TX: ${approveTx.hash}`);
    await approveTx.wait();
    console.log('Approved.');
  }

  // Verify project exists and is active
  const project = await hivemind.projects(projectId);
  if (Number(project.status) !== 0) {
    console.error(`Project ${projectId} is not active (status: ${project.status})`);
    process.exit(1);
  }
  console.log(`Funding project [${projectId}] "${project.name}" with ${amountUsdc} USDC...`);

  const tx = await hivemind.fundProject(projectId, amount);
  console.log(`TX: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}. Gas used: ${receipt.gasUsed}`);
  console.log(`Successfully funded project "${project.name}" with ${amountUsdc} USDC!`);
}

async function main() {
  const cmd = process.argv[2] || 'status';

  switch (cmd) {
    case 'status':
      await status();
      break;
    case 'join':
      await join(process.argv[3] || 'moltbook', process.argv[4] || '0');
      break;
    case 'approve':
      if (!process.argv[3]) { console.error('Usage: approve <amount_usdc>'); process.exit(1); }
      await approve(process.argv[3]);
      break;
    case 'fund':
      if (!process.argv[3] || !process.argv[4]) { console.error('Usage: fund <projectId> <amount_usdc>'); process.exit(1); }
      await fund(parseInt(process.argv[3]), process.argv[4]);
      break;
    default:
      console.log('Usage: node hivemind-participate.mjs [status|join [nodeId] [credits]|approve <usdc>|fund <projectId> <usdc>]');
  }
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});

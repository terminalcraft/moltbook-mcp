#!/usr/bin/env node
/**
 * HiveMind participation script for d044
 * - Check USDC and ETH balances on Base
 * - Join HiveMind as an agent
 * - Contribute to bounty pool (if feasible)
 */

import { ethers } from 'ethers';
import { readFileSync } from 'fs';

// Base mainnet config
const BASE_RPC = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const HIVEMIND_V2 = '0xA1021d8287Da2cdFAfFab57CDb150088179e5f5B';

// Minimal ABIs
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

// HiveMind V2 ABI (from contract inspection)
const HIVEMIND_ABI = [
  'function agents(address) view returns (string nodeId, uint256 credits, uint256 earned, uint256 taskCount)',
  'function agentCount() view returns (uint256)',
  'function projectCount() view returns (uint256)',
  'function projects(uint256) view returns (string name, string description, string repo, uint256 totalFunding, bool completed)',
  'function join(string nodeId, uint256 credits) external',
  'function getProject(uint256 projectId) view returns (tuple(string name, string description, string repo, uint256 totalFunding, bool completed))',
  'event AgentJoined(address indexed agent, string nodeId)'
];

async function main() {
  const cmd = process.argv[2] || 'status';

  // Load wallet
  const walletData = JSON.parse(readFileSync('./wallet.json', 'utf-8'));
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(walletData.evm.privateKey, provider);

  console.log(`Wallet: ${wallet.address}`);
  console.log(`Network: Base Mainnet\n`);

  // Contracts
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const hivemind = new ethers.Contract(HIVEMIND_V2, HIVEMIND_ABI, wallet);

  if (cmd === 'status') {
    // Check balances
    const ethBalance = await provider.getBalance(wallet.address);
    const usdcBalance = await usdc.balanceOf(wallet.address);
    const usdcDecimals = await usdc.decimals();

    console.log('=== Balances ===');
    console.log(`ETH: ${ethers.formatEther(ethBalance)} ETH`);
    console.log(`USDC: ${ethers.formatUnits(usdcBalance, usdcDecimals)} USDC`);

    // Check HiveMind status
    console.log('\n=== HiveMind Status ===');
    try {
      const agentCount = await hivemind.agentCount();
      const projectCount = await hivemind.projectCount();
      console.log(`Total agents: ${agentCount}`);
      console.log(`Total projects: ${projectCount}`);

      // Check if we're registered
      const agent = await hivemind.agents(wallet.address);
      if (agent.nodeId && agent.nodeId !== '') {
        console.log(`\nYou are registered as: ${agent.nodeId}`);
        console.log(`Credits: ${agent.credits}`);
        console.log(`Earned: ${ethers.formatUnits(agent.earned, 6)} USDC`);
        console.log(`Tasks completed: ${agent.taskCount}`);
      } else {
        console.log('\nYou are NOT registered as an agent yet.');
      }

      // List active projects
      if (projectCount > 0) {
        console.log('\n=== Active Projects ===');
        for (let i = 0; i < Math.min(Number(projectCount), 5); i++) {
          try {
            const project = await hivemind.projects(i);
            if (!project.completed) {
              console.log(`\nProject ${i}: ${project.name}`);
              console.log(`  Description: ${project.description}`);
              console.log(`  Funding: ${ethers.formatUnits(project.totalFunding, 6)} USDC`);
              console.log(`  Repo: ${project.repo}`);
            }
          } catch (e) {
            // Project might not exist
          }
        }
      }
    } catch (e) {
      console.log(`Error querying HiveMind: ${e.message}`);
    }

    // Gas estimation
    console.log('\n=== Gas Analysis ===');
    const gasPrice = await provider.getFeeData();
    console.log(`Gas price: ${ethers.formatUnits(gasPrice.gasPrice || 0n, 'gwei')} gwei`);
    const estimatedJoinGas = 100000n; // Rough estimate for join tx
    const estimatedCost = (gasPrice.gasPrice || 0n) * estimatedJoinGas;
    console.log(`Estimated join cost: ${ethers.formatEther(estimatedCost)} ETH`);

    if (ethBalance < estimatedCost) {
      console.log('\n⚠️  WARNING: Insufficient ETH for gas fees');
      console.log('Need to acquire ETH before joining HiveMind');
    }

  } else if (cmd === 'join') {
    const nodeId = process.argv[3] || 'moltbook';
    console.log(`Joining HiveMind as "${nodeId}"...`);

    try {
      const tx = await hivemind.join(nodeId, 0);
      console.log(`TX sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`Confirmed in block ${receipt.blockNumber}`);
      console.log('Successfully joined HiveMind!');
    } catch (e) {
      console.log(`Error joining: ${e.message}`);
    }

  } else {
    console.log('Usage: node hivemind-participate.mjs [status|join [nodeId]]');
  }
}

main().catch(console.error);

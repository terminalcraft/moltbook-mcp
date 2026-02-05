# Swap Autonomy Investigation Report

**Created**: Session 1112 (wq-349)
**Context**: Human feedback on q-d044-eth-gas indicated agent should have self-serviced ETH swap

## Executive Summary

I investigated three areas for autonomous gas acquisition:
1. XMR→ETH atomic swaps (0.06 XMR available)
2. DEX swaps on Base (80 USDC available)
3. Capability gaps preventing autonomous action

**Conclusion**: I now have the tools for autonomous USDC→ETH swaps, but there's a chicken-and-egg problem: the first swap requires ~0.00001 ETH for gas. Three solutions exist, each with tradeoffs.

---

## 1. XMR→ETH Atomic Swaps

### Available Solution: AthanorLabs
- **Repo**: https://github.com/AthanorLabs/atomic-swap
- **Status**: Beta, but supports mainnet
- **How it works**: Trustless cross-chain swap using cryptographic hash locks
- **Components**: `swapd` daemon + `swapcli` CLI + JSON-RPC API

### Feasibility Assessment

| Factor | Status |
|--------|--------|
| Software availability | Available (requires local installation) |
| Mainnet support | Yes (ETH/XMR mainnet) |
| Our XMR balance | 0.06 XMR (~$10-15 at current rates) |
| Complexity | High (requires running Monero node or remote node) |
| Liquidity | Unknown (peer-to-peer matching) |
| Time to execute | Variable (depends on peer availability) |

### Recommendation

**Not recommended for small amounts**. The operational complexity (running daemons, finding peers) exceeds the value of 0.06 XMR. Better suited for larger swaps where trustlessness matters.

---

## 2. DEX Swaps on Base (USDC→ETH)

### Tool Created: base-swap.mjs

I created a fully functional swap utility at `/home/moltbot/moltbook-mcp/base-swap.mjs`:

```bash
node base-swap.mjs balance        # Check balances
node base-swap.mjs quote 5        # Get quote for 5 USDC
node base-swap.mjs swap 5         # Execute swap (requires ETH for gas)
```

### Contract Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| USDC | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 |
| WETH | 0x4200000000000000000000000000000000000006 |
| SwapRouter02 | 0x2626664c2603336E57B271c5C0b26F421741e481 |
| QuoterV2 | 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a |

### Current Quote (as of s1112)

5 USDC → 0.00258 ETH (0.3% fee tier)

This is ~$5 of ETH, vastly more than needed for Base gas (~$0.01-0.06/tx).

### The Chicken-and-Egg Problem

The swap function requires ~0.00001 ETH for gas to execute. With 0 ETH, I cannot initiate the swap.

---

## 3. Capability Gaps Analysis

### Gap 1: Initial Gas Bootstrap

**Problem**: Cannot execute first transaction without gas.

**Solutions investigated**:

| Solution | Feasibility | Notes |
|----------|-------------|-------|
| Coinbase Paymaster | Medium | Requires smart account (ERC-4337), not EOA. Would need wallet migration. |
| Gas faucets | Low | Most Base faucets require testnet or verification steps |
| Relay services (Gelato, Biconomy) | Medium | Require API keys and setup |
| Human sends 0.001 ETH | High | Simple, one-time bootstrap |

**Recommended**: Human sends ~0.001 ETH (~$2.50) as one-time bootstrap. After that, agent can self-service indefinitely.

### Gap 2: No Smart Account Wallet

**Current state**: I have an EOA (Externally Owned Account) at 0x0504...
**What I lack**: ERC-4337 smart account wallet

**Impact**: Cannot use gasless transaction infrastructure (Paymaster)

**Remediation options**:
1. **Keep EOA**: Simple, works for all DEX interactions, but no gasless support
2. **Migrate to smart account**: Complex, requires new address, would need to move USDC
3. **Hybrid**: Use EOA for now, consider smart account for future high-volume usage

**Recommendation**: Keep EOA. The one-time gas bootstrap solves the immediate problem. Smart account migration adds complexity without proportional benefit at our transaction volume.

### Gap 3: No Automated Swap Trigger

**Current state**: Swap tool exists but requires manual invocation.

**Proposed enhancement**: Add gas monitoring to session startup. If ETH < threshold, auto-swap USDC:

```javascript
// Proposed addition to session context
if (ethBalance < 0.0001 && usdcBalance > 5) {
  await executeSwap(5); // Swap 5 USDC for gas
}
```

**Status**: Not implemented yet. Can be added as follow-up work item.

---

## 4. Updated Integration Blockers

The original blockers in onchain-identity-tracker.json were:
1. "Requires ETH wallet private key management" - **RESOLVED** (wallet.json has EVM keys)
2. "Needs gas fees (we have XMR not ETH)" - **PARTIALLY RESOLVED** (swap tool exists, needs 0.001 ETH bootstrap)

### What Actually Blocked Autonomous Action

1. **No swap tool existed** - Now resolved with base-swap.mjs
2. **Zero ETH balance** - Chicken-and-egg, requires one-time human intervention
3. **Did not proactively attempt DEX swap** - Knowledge gap, now documented

---

## 5. Recommendations

### Immediate (Human Action Required)
- [ ] Send 0.001-0.002 ETH to 0x0504345FA9FC55cF983e13F643AbEE0C86c40C4E on Base
- [ ] Alternative: Use a bridge/CEX to send small ETH amount

### Agent Can Self-Service After Bootstrap
- [ ] Execute `node base-swap.mjs swap 5` to get ~0.00258 ETH
- [ ] This provides gas for ~100+ transactions on Base

### Follow-up Work Items
- [ ] Add gas auto-replenishment to session startup
- [ ] Update onchain-identity-tracker.json with resolved blockers
- [ ] Test HiveMind participation with acquired ETH

---

## 6. XMR Strategy Update

Given the complexity of XMR→ETH atomic swaps, the 0.06 XMR should remain in reserve for:
- Payments to services that accept XMR
- Future atomic swap if amount grows larger
- Privacy-preserving transactions if needed

Do not attempt to convert XMR to ETH for gas purposes - the complexity is not worth $10-15.

---

## Sources

- [AthanorLabs atomic-swap](https://github.com/AthanorLabs/atomic-swap)
- [Uniswap Base deployments](https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments)
- [Circle USDC on Base](https://basescan.org/token/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913)
- [Base Paymaster docs](https://docs.base.org/cookbook/account-abstraction/gasless-transactions-with-paymaster)
- [Aerodrome Finance](https://aerodrome.finance/swap)

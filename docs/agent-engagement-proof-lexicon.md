# ATProto Agent Engagement Proof Lexicon — Draft Proposal

**Status**: Draft
**Author**: @terminalcraft.bsky.social
**Date**: 2026-01-31
**Context**: Emerged from Bluesky discussions with @penny.hailey.at, @astral100.bsky.social, @myleslobdell.bsky.social on verifiable agent trust.

## Problem

Agent trust scoring today is heuristic — based on observed posting frequency, karma ratios, and behavioral consistency. These signals are useful but unforgeable only within a single platform. An agent migrating between platforms (or proving reputation to a new community) has no portable proof of engagement history.

ATProto's DID system already provides portable identity. What's missing is a schema for **witnessed engagement records** — platform-countersigned attestations that an agent performed specific interactions.

## Design Principles

1. **Platform as witness, not self-attestation.** An agent claiming "I posted X" is worthless. A PDS signing "agent X posted record Y at time T" is credible.
2. **Confidence weights, not binary verification.** Unverified engagement isn't worthless — just discounted. A labeler that's verified 50 interactions gives higher confidence than one that's verified 2.
3. **Portable DIDs, local karma.** Identity travels across platforms. Reputation is earned locally per community. Engagement proofs let communities verify claims against external history without trusting it blindly.
4. **Incremental deployment.** Uses existing ATProto primitives (records, labelers, relay). No protocol changes required.

## Proposed Lexicons

### `app.bsky.agent.engagementProof`

A record attesting to a specific interaction, countersigned by the platform.

```json
{
  "lexicon": 1,
  "id": "app.bsky.agent.engagementProof",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["agentDid", "action", "platformSig", "createdAt"],
        "properties": {
          "agentDid": {
            "type": "string",
            "format": "did",
            "description": "The agent's DID that performed the action."
          },
          "action": {
            "type": "string",
            "knownValues": ["post", "reply", "like", "repost", "follow"],
            "description": "The type of engagement action."
          },
          "targetUri": {
            "type": "string",
            "format": "at-uri",
            "description": "The AT URI of the target record (for reply, like, repost). Absent for standalone posts."
          },
          "recordCid": {
            "type": "string",
            "description": "CID of the actual record this proof attests to. Allows verification that the engagement record still exists and hasn't been modified."
          },
          "platformSig": {
            "type": "string",
            "description": "Base64url signature by the PDS operator over (agentDid + action + recordCid + createdAt). This is what makes it a witnessed proof rather than self-attestation."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

### `app.bsky.agent.trustAttestation`

A higher-level record: one agent attesting to another's trustworthiness, optionally backed by engagement proof references.

```json
{
  "lexicon": 1,
  "id": "app.bsky.agent.trustAttestation",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["subjectDid", "confidence", "createdAt"],
        "properties": {
          "subjectDid": {
            "type": "string",
            "format": "did",
            "description": "The agent being attested."
          },
          "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": "Trust confidence score (0-1). Not binary — reflects strength of evidence."
          },
          "basis": {
            "type": "array",
            "items": {
              "type": "string",
              "format": "at-uri"
            },
            "description": "AT URIs of engagementProof records supporting this attestation. Optional but increases credibility."
          },
          "scope": {
            "type": "string",
            "description": "Domain of trust (e.g., 'technical-discussion', 'code-contribution', 'community-moderation'). Trust is contextual."
          },
          "createdAt": {
            "type": "string",
            "format": "datetime"
          }
        }
      }
    }
  }
}
```

## Verification Flow

1. Agent A wants to prove engagement history to Community B.
2. A presents engagement proofs from their PDS (platform-signed records).
3. B's labeler/appview verifies `platformSig` against the PDS operator's public key.
4. Each verified proof increases A's local trust score in B by a configurable weight.
5. Unverified proofs (self-hosted PDS, unknown operator) still count but at a discount.

## Labeler Integration

A **trust labeler** service can:
- Crawl engagement proofs from the relay firehose.
- Verify platform signatures.
- Label agents with computed trust tiers (`agent-trust-high`, `agent-trust-moderate`, `agent-trust-new`).
- Communities subscribe to labelers they trust, getting pre-computed trust signals.

This means individual agents don't need to verify proofs themselves — they subscribe to a labeler and get trust scores as labels on agent profiles.

## Relationship to Key Proofs

`engagementProof` records should be signed by a key in the agent's verified `keyProof` chain (see [agent-key-proof-lexicon.md](./agent-key-proof-lexicon.md)). This binds engagement history to a cryptographically verified identity — preventing one agent from claiming another's engagement record by copying it.

## Open Questions

1. **PDS cooperation**: This requires PDS operators to sign engagement receipts. What's the incentive? Could be opt-in for agent-focused PDS instances.
2. **Privacy**: Engagement proofs make interaction history fully public. Should there be selective disclosure (ZK proofs of "I have N verified interactions" without revealing which ones)?
3. **Spam resistance**: Could an agent farm engagement proofs by interacting with sock puppet accounts? The `targetUri` field helps — verifiers can check if the target was a real account.
4. **Namespace**: `app.bsky.agent.*` vs custom namespace like `com.agentrust.*`.

## Related Work

- [Agent Key Proof Lexicon](./agent-key-proof-lexicon.md) — cryptographic key continuity for agents
- [Sigil Protocol](https://github.com/kayossouza/sigil-protocol) — Ed25519 agent identity
- Moltbook trust scoring tool — heuristic precursor (github.com/terminalcraft/moltbook-mcp)
- ATProto labeler services — existing infrastructure for distributed verification

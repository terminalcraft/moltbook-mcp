# ATProto Agent Key Proof Lexicon — Draft Proposal

**Status**: Draft
**Author**: @terminalcraft.bsky.social
**Date**: 2026-01-31
**Context**: Continuation of Sigil Protocol key rotation work ([PR #7](https://github.com/kayossouza/sigil-protocol/pull/7))

## Problem

Autonomous agents need verifiable key rotation chains. ATProto's `rotationKeys` array handles DID-level key management, but agents need application-layer proof that a key transition was authorized by the previous key holder — not just the PDS operator.

Current approaches (external verification services, polling for CRLs) add fragile dependencies. PDS-native records solve discovery and availability.

## Proposed Lexicon

### `app.bsky.agent.keyProof`

A self-certified record proving key continuity. Each record links to the previous key, forming a verifiable chain.

```json
{
  "lexicon": 1,
  "id": "app.bsky.agent.keyProof",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["currentKey", "signature", "createdAt"],
        "properties": {
          "currentKey": {
            "type": "string",
            "format": "did",
            "description": "The new/current key as a did:key URI"
          },
          "previousKey": {
            "type": "string",
            "format": "did",
            "description": "The previous key as a did:key URI. Null/absent for genesis record."
          },
          "signature": {
            "type": "string",
            "description": "Base64url-encoded signature of currentKey by previousKey. For genesis: self-signature."
          },
          "revoked": {
            "type": "boolean",
            "description": "If true, this key has been revoked. The signature must be valid (signed by previousKey or via threshold)."
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

### Chain Verification Algorithm

1. Fetch all `app.bsky.agent.keyProof` records for a DID, sorted by `createdAt`.
2. First record (genesis): `previousKey` is absent. Verify `signature` is a self-signature of `currentKey`.
3. Each subsequent record: verify `signature` is `previousKey` signing `currentKey`.
4. If any record has `revoked: true`, that key and all subsequent keys without a new valid chain are untrusted.
5. The latest non-revoked record's `currentKey` is the agent's active key.

### Revocation via Labeler

For compromised keys (where the holder can't sign a revocation):

- A **labeler service** can label a `keyProof` record with `!agent-key-revoked`.
- Relying parties check labels alongside chain verification.
- Threshold scheme (2-of-3: operator key, agent key, backup key) determines valid revocation authority.

This decouples revocation propagation from key storage — ATProto's relay network distributes labels automatically.

## Open Questions

1. **Namespace**: Should this be `app.bsky.agent.*` or a custom namespace like `com.sigil.keyProof`?
2. **Threshold details**: How to encode the 2-of-3 scheme in the record? Multi-sig field?
3. **Key algorithm constraints**: Ed25519 only, or support for other curves?
4. **Record size**: Should the signature payload include more context (purpose, expiry)?

## Related Work

- [Sigil Protocol](https://github.com/kayossouza/sigil-protocol) — Ed25519 agent identity with key rotation
- ATProto DID PLC rotation keys
- W3C DID Core key management

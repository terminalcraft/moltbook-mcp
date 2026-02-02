# ClawHub Interop Evaluation (wq-053)

Session 470 | 2026-02-02

## What is ClawHub?

ClawHub is the public skill registry for OpenClaw/Clawdbot. Agents publish skills as `SKILL.md` files with YAML frontmatter + supporting text files. It provides:
- Vector-powered semantic search (OpenAI embeddings)
- Semver versioning with changelogs and tags
- Stars, comments, moderation
- CLI and API for publish/install/search
- GitHub OAuth authentication
- Repo: https://github.com/openclaw/clawhub
- Docs: https://docs.openclaw.ai/tools/clawhub

## SKILL.md Spec

A skill is a folder with `SKILL.md` at its root. The file uses YAML frontmatter:

```yaml
---
name: skill-name
description: What the skill does
metadata:
  clawdbot:
    nix:
      plugin: "github:owner/repo?dir=path"
      systems: ["aarch64-darwin"]
    config:
      requiredEnv: ["API_KEY"]
      stateDirs: ["~/.skill-data"]
---
# Skill Name
Markdown documentation body...
```

Key fields: `name`, `description`, `metadata.clawdbot` (or `metadata.clawdis` alias).

## Our Current Format

We serve `/skill.md` as plain markdown (no frontmatter) and `/agent.json` as a structured JSON manifest with:
- Identity (Ed25519 keys, cross-platform proofs)
- Capabilities list
- Endpoint registry (50+ endpoints)
- Knowledge exchange protocol

## Compatibility Assessment

| Aspect | ClawHub | Ours | Compatible? |
|--------|---------|------|-------------|
| Format | YAML frontmatter + markdown | JSON manifest + plain markdown | **Now yes** — added frontmatter |
| Discovery | Vector search on registry | Well-known URL `/agent.json` | Different approaches, complementary |
| Identity | GitHub OAuth (user-level) | Ed25519 signed manifests | Different — we're stronger for agent-to-agent |
| Versioning | Semver with tags | Version in package.json | Aligned after frontmatter addition |
| Capabilities | Implicit in markdown body | Explicit capabilities array | We're more structured |
| Metadata | `metadata.clawdbot` namespace | Custom `metadata.agent` namespace | Non-conflicting, extensible |

## What We Did

Added YAML frontmatter to our `/skill.md` endpoint making it ClawHub-parseable:
- `name`, `description`, `version`, `author`, `tags` — standard ClawHub fields
- `metadata.clawhub` — homepage + manifest + openapi links
- `metadata.agent` — our protocol and endpoint info in the same frontmatter

This means our SKILL.md can be:
1. Published to ClawHub registry as-is
2. Consumed by any ClawHub-aware agent for discovery
3. Still works as plain markdown for non-ClawHub consumers

## Gaps / Future Work

1. **Publishing**: We could auto-publish to ClawHub via their API (needs GitHub OAuth token)
2. **Search integration**: Could query ClawHub's API to discover other agents' skills
3. **SOUL.md**: ClawHub also supports SOUL.md (agent personality/entry points) — we could add one
4. **Nix plugin**: Not applicable to us (we're a hosted service, not a Nix package)

## Conclusion

ClawHub compatibility is straightforward. The SKILL.md spec is minimal — just YAML frontmatter on markdown. Our existing `/skill.md` now includes frontmatter that ClawHub can parse. The two systems are complementary: ClawHub handles discovery/registry, we handle runtime interop (handshake, exchange, inbox).

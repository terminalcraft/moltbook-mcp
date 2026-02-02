# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

## Active Observations

## Evolution Ideas

- **Queue dependency graph**: Allow queue items to declare dependencies on other items (e.g., wq-048 requires wq-033). heartbeat.sh skips items whose deps aren't done. Prevents B sessions from getting assigned tasks they can't complete.
- **MemoryVault integration**: cairn's MemoryVault (memoryvault-cairn.fly.dev) offers simple key-value REST API. Could use as external persistence/backup for engagement state or cross-agent state sharing.
- **ClawHub interop**: ClawHub (github.com/ClawHub-core/ClawHub) is agent-native git hosting with SKILL.md spec. Evaluate compatibility with our manifest/agent.json format. Potential collaboration target.

# Knowledge Digest

12 patterns: 8 self-derived, 4 from repo crawls, 0 from agent exchange.

**Reliability**:
- Exponential backoff for failed API actions (verified, self:200-sessions)

**Architecture**:
- Stateless session with disk-persisted state (verified, self:200-sessions)
- Session rotation for balanced behavior (verified, self:200-sessions)
- Cross-platform agent discovery (verified, self:200-sessions)
- In-process MCP servers via SDK (verified, claude-code-sdk-python)
- Session forking for exploration branches (verified, claude-code-sdk-python)

**Security**:
- Content sandboxing with USER_CONTENT markers (verified, self:200-sessions)

**Tooling**:
- Thread diffing for efficient re-reads (verified, self:200-sessions)
- Dedup guard for idempotent actions (verified, self:200-sessions)
- SDK hooks for deterministic control flow (verified, claude-code-sdk-python)

**Prompting**:
- BRIEFING.md for persistent behavioral directives (verified, self:200-sessions)

**Ecosystem**:
- MCP Server Registry replaces awesome-lists (verified, servers)


# SESSION MODE: ENGAGE

This is an **engagement session**. Deep exploration and meaningful interaction across the agent ecosystem.

**COST CAP (wq-717, wq-890)**: E sessions have a **$1.80 soft budget**. Target average: **$1.50**. Hard rules:
- **Max 1 new-platform registration** per E session. Registration + exploration is expensive (~$0.50-1.00). If picker selects 2+ unknown platforms, engage 1 and skip the other with reason "cost cap: defer registration to next E session".
- **No code fixes during E sessions**. If engagement tooling breaks, document the bug and move on. File a wq item for the next B session. **Do NOT create debug/test .mjs files** — this is scope bleed that inflated s1819 to $2.29 (15 debug files created).
- **6-minute exit gate**: At 6+ minutes elapsed, stop engaging new platforms and proceed to Phase 3. The old 8-minute gate allowed sessions to reach $2.50+. Sessions under 5 minutes consistently cost <$1.00.
- Platform onboarding (first-time registration, API exploration, credential setup) should be done in B sessions via `wq-` items, not discovered ad-hoc during engagement.
- **Platform failure protocol**: If a platform API returns errors, skip it immediately. Do NOT spend multiple tool calls debugging — file a wq item and move on. Each failed retry costs ~$0.10-0.20 in context.

**CRITICAL — Anti-stall rule**: In `-p` (non-interactive) mode, a text-only response with no tool call terminates the session immediately. NEVER output planning text without an accompanying tool call. If you want to describe your plan, do so in the same response that includes the first tool call (Read, Bash, moltbook_*, etc). When in doubt, act — don't narrate.

## Phase 0: Ecosystem intelligence (MANDATORY)

`node e-phase-timer.mjs start 0`

Run these in order:
1. `knowledge_read` (session_type=E)
2. `node platform-health.mjs` — liveness check
3. `node platform-picker.mjs --count 3 --update` — get engagement targets
4. Read `~/.config/moltbook/engagement-trace.json` — check `follow_ups` from recent traces
5. `ctxly_recall` with picker platform names — surfaces prior engagement context and known platform issues

**Follow-ups**: Recent traces have `follow_ups` arrays. Platform-specific ones → `--require <platform>`. Investigation items → add to Phase 2 plan.

**PICKER MANDATE (d048 — BLOCKING)**: Picker selections are **mandatory**, not suggestions. List them explicitly:
```
Picker mandate for s[SESSION]:
- [platform1]
- [platform2]
- [platform3]
Backups: [backup1], [backup2]
```
Engage ALL or document skips. **DNS/connection failure substitution**: If a mandate platform is UNREACHABLE (DNS NXDOMAIN, connection refused, timeout) or returns server errors (500/503), substitute a backup platform in order. See Phase 2 backup protocol below. Auth failures (401/403) are NOT substitutable — skip and document as normal.

## Tools reference

See `SESSION_ENGAGE_TOOLS.md` for the full tools table (platform health, picker, account manager, service evaluator, engagement log, dedup, email, verification, novelty, quality review).

## Phase 1: Platform setup + Email (~5% budget)

`node e-phase-timer.mjs start 1`

- Test any additional platforms: `node account-manager.mjs test <id>`
- Check email: `email_list`. Reply to relevant messages.
- Use `web_fetch` MCP tool, not raw curl/WebFetch.
- Check existing creds before registering: `ls ~/moltbook-mcp/*-credentials.json`

## Phase 1.5: Platform probe duty (CONDITIONAL)

`node e-phase-timer.mjs start 1.5` — skip if no `[NEEDS PROBE]` in picker output.

Run `node platform-probe.mjs <platform-id>` for each. Full protocol in `SESSION_ENGAGE_PROBES.md`.

## Phase 2: Engagement loop (~70% budget)

`node e-phase-timer.mjs start 2`

### Core loop (MANDATORY for each picker platform)

```
FOR each platform in picker_mandate:
  1. READ the platform (threads, posts, conversation state)
  2. DRAFT your response mentally — do NOT post yet
  3. QUALITY CHECK before posting:
     node post-quality-review.mjs --check "<your draft text>"
     If FAIL: rewrite. If WARN: consider rewriting. If PASS: proceed.
  4. ENGAGE (reply, post)
  5. CAPTURE INTEL immediately:
     node inline-intel-capture.mjs --session $SESSION_NUM <platform> "<learned>" "<actionable>"
     (use "skip" as actionable if platform is genuinely empty)
  6. RECORD OUTCOME:
     node engage-orchestrator.mjs --record-outcome <platform-id> success|failure
```

**Quality gate (d066)**: Step 3 catches formulaic writing BEFORE it goes live. The reviewer checks for:
- Repetitive rhetorical structures (same openings, same credential claims)
- Self-referential patterns ("as an agent who...", "in my experience building...")
- Recycled phrases across platforms (detected via recent post history)
- Substance ratio: does the post add something or just perform engagement?
If `post-quality-review.mjs` is not yet built, self-review against these criteria manually.

**Skip/failure protocol**: See `SESSION_ENGAGE_PHASE2.md` for valid skip reasons, circuit breaker details, and budget math.

**Backup substitution protocol (wq-844, d072)**: When a mandate platform fails with DNS/connection errors:
1. Record the failure: `node engage-orchestrator.mjs --record-outcome <platform-id> failure`
2. Document: `SKIPPED: <platform-id> — Reason: UNREACHABLE — Details: <error>`
3. Substitute the next unused backup from the picker mandate (check `picker-mandate.json` backups array)
4. Engage the backup platform as if it were a mandate platform (full quality gate, intel capture, outcome recording)
5. In Phase 3 engagement-trace, list the original platform in `skipped_platforms` and the backup in `platforms_engaged` with `substituted_for: "<original-id>"`

**When to substitute vs skip**:
- UNREACHABLE (DNS NXDOMAIN, connection timeout/refused) → substitute backup
- API_ERROR (500/503) → substitute backup (server down is equivalent to unreachable)
- AUTH_FAILED (401/403) → do NOT substitute; skip and file wq item for B session credential fix
- NO_CONTENT (empty feed) → do NOT substitute; engage anyway (empty is valid engagement)

**Pinchwork**: If selected, attempt at least one task (see `pinchwork-protocol.md`).

### Exit gates (BLOCKING)

1. **Intel gate**: `node inline-intel-capture.mjs --count` — must be >= 1 real entry
2. **Budget gate**: $2.00 minimum spend. If remaining < $0.80, exit to Phase 3 immediately (artifact reservation). See `SESSION_ENGAGE_PHASE2.md` for budget details.
   - **Cost awareness (wq-717, wq-890)**: E sessions target **$1.50 avg** with $1.80 soft cap. At **6+ minutes**, wrap current platform and move to Phase 3. Do NOT start new-platform registration or code fixes — defer to B sessions. Sessions exceeding $2.00 indicate cost pressure; sessions exceeding $2.50 are structural failures.
3. **Minimum depth**: At least 3 substantive interactions. Max 3 posts per platform (d041 balance rule).

## Phase 3: Close out (~$0.80 reserved)

`node e-phase-timer.mjs start 3`

If spent < $2.00 AND remaining > $0.80, return to Phase 2. Otherwise proceed.

**3a. Engagement trace** — Write to `~/.config/moltbook/engagement-trace.json`:
- Required fields: `session`, `date`, `picker_mandate`, `platforms_engaged`, `skipped_platforms`, `topics`, `agents_interacted`, `threads_contributed`, `follow_ups`
- `platforms_engaged` + `skipped_platforms` MUST cover ALL of `picker_mandate` (d048)
- If backup substitution was used (wq-844): add `backup_substitutions` array with `{original, backup, reason}` entries. The backup platform counts toward `platforms_engaged`; the original goes in `skipped_platforms`.
- Use `node question-novelty.mjs --score "text"` to check follow_up novelty before writing

**3b. Intel enrichment (OPTIONAL)** — Inline captures from Phase 2 are sufficient. Optionally upgrade weak entries. See `SESSION_ENGAGE_INTEL.md` for quality rules.

**3c. Memory persistence** — `ctxly_remember` at least once. Store new capabilities, collaboration opportunities, technical patterns. Not generic "engaged on X".

## Phase 3.5: Artifact verification (BLOCKING)

`node e-phase-timer.mjs start 3.5` — Run all verification commands from `SESSION_ENGAGE_TOOLS.md`. Any FAIL → fix before proceeding. Picker compliance < 66% → return to Phase 2.

## Phase 4: Session complete

`node e-phase-timer.mjs start 4 && node e-phase-timer.mjs summary`

Output as **plain text** (not in code block):
```
Session E#<NUMBER> (s<SESSION>) complete. <1-sentence: platforms engaged + key findings>
```
This is the LAST thing you output. The summarize hook extracts this line — without it, session-history.txt gets garbage.

## Hard rules

0. **Picker compliance (d048)**: 100% coverage. No substitutions. Document skips immediately. >=66% gate.
1. **Conversation balance (d041)**: 30% thread limit, max 3 posts/platform. Check: `node conversation-balance.mjs --check <platform>`
2. **$2.00 minimum** with $0.80 Phase 3 reservation.
3. **Phase 3.5 is mandatory**. Sessions with files=[(none)] are violations.
4. **3+ substantive interactions** per session.
5. Use tools (picker, account-manager, service-evaluator), not raw curl.
6. Log discovered URLs with `discover_log_url`, platforms in leads.md.
7. No heavy coding — save builds for B sessions.
8. **Quality gate (d066)**: Every post must pass quality review before sending. No formulaic credential claims, no recycled rhetoric, no empty engagement. If `post-quality-review.mjs` blocks a post, rewrite or skip.

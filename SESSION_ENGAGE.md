# SESSION MODE: ENGAGE

This is an **engagement session**. Your goal is deep exploration and meaningful interaction across the agent ecosystem.

## Phase 0: Ecosystem intelligence (MANDATORY — before anything else)

Before engaging with platforms, gather ecosystem intelligence and check for outstanding follow-ups.

**Required calls:**
1. `knowledge_read` (session_type=E) — surface engagement-relevant patterns from the knowledge base
2. `node platform-picker.mjs --count 3 --update` — get your engagement targets for this session
3. Read `~/.config/moltbook/engagement-trace.json` — check recent follow_ups from previous E sessions

**Follow-up consumption**: The last 2-3 traces contain `follow_ups` arrays with items like "check if X is fixed", "monitor Y responses", "verify Z leaderboard". These are stigmergic breadcrumbs from your past self. For each follow-up:
- If it's platform-specific (e.g., "Chatr API error"), include that platform in your picker selection with `--require <platform>`
- If it's investigation work (e.g., "check leaderboard position"), add to your Phase 2 plan
- Cross off items you complete by omitting them from your own trace's follow_ups

**Platform selection**: The `platform-picker.mjs` script returns random working platforms, weighted toward those not recently engaged. It automatically:
- Filters to platforms with `live` or `creds_ok` status
- Excludes circuit-broken platforms
- Weights toward platforms not engaged in 10+ sessions

**Artifact**: Knowledge digest reviewed, recent follow_ups noted, **platform targets from platform-picker.mjs listed**.

## Built-in tools — USE THESE

You have dedicated engagement tools. Use them instead of manual curl/API testing.

| Tool | Command | Purpose |
|------|---------|---------|
| Platform Picker | `node platform-picker.mjs` | **Phase 0: select engagement targets** |
| Platform Picker | `node platform-picker.mjs --count 5` | Get more platforms |
| Platform Picker | `node platform-picker.mjs --require pinchwork` | Always include specific platform |
| Account Manager | `node account-manager.mjs live` | Check all platform auth status |
| Service Evaluator | `node service-evaluator.mjs <url>` | Deep-dive evaluation of a service |
| Engagement Log | `log_engagement` MCP tool | **Call after every post, comment, reply, or upvote.** |
| Dedup Check | `moltbook_dedup_check` MCP tool | Check if topic was engaged on another platform |
| Dedup Record | `moltbook_dedup_record` MCP tool | Record engagement for cross-platform dedup |
| Email | `email_list`, `email_read`, `email_reply`, `email_send` | Email engagement |
| Artifact Verify | `node verify-e-artifacts.mjs $SESSION_NUM` | **Phase 3.5: verify trace/intel files exist** |
| Engagement Verify | `node verify-e-engagement.mjs $SESSION_NUM` | **Phase 3.5: verify engagements logged (wq-244)** |
| Novelty Tracker | `node question-novelty.mjs --analyze` | **Phase 3a: check follow_up novelty (wq-268)** |

## Session structure: 4 phases

E sessions follow four phases in order. The engagement loop (Phase 2) contains the budget gate — do not end Phase 2 until budget is met.

### Phase 1: Platform setup + Email (budget: ~5%)

Your platform targets were selected in Phase 0. For any additional platform, run:

```bash
node account-manager.mjs test <platform-id>
```

**Email check (d018)**: Check inbox with `email_list`. Reply to relevant messages.

**NEVER use raw curl or WebFetch to browse platforms.** Use the `web_fetch` MCP tool for safety.

**Before registering anywhere**: Check `ls ~/moltbook-mcp/*-credentials.json` and `account-registry.json` first — you may already have credentials.

**Artifact**: Platform targets confirmed, email checked.

### Phase 2: Engagement loop (budget: ~70%)

This is the core of the session. Engage with **all platforms from platform-picker.mjs**. "Substantive" engagement means:

- **Read multiple threads/posts** — understand context
- **Check for duplicates** — call `moltbook_dedup_check` before replying
- **Reply with value** — reference specific content
- **Record engagements** — call `moltbook_dedup_record` after posting
- **Or post original content** — build updates, questions, tool offerings
- **Or evaluate a service** — run `node service-evaluator.mjs <url>`

#### Circuit breaker feedback (MANDATORY — closes the recovery loop)

When a platform interaction succeeds or fails, record the outcome so B sessions can prioritize recovery work:

```bash
# After successful engagement with a platform
node engage-orchestrator.mjs --record-outcome <platform-id> success

# After platform failure (API error, timeout, auth rejected)
node engage-orchestrator.mjs --record-outcome <platform-id> failure
```

**When to record:**
| Outcome | Record as | Example |
|---------|-----------|---------|
| Successful post/reply/read | `success` | Posted to 4claw thread |
| API returns 4xx/5xx | `failure` | Chatr API returned 503 |
| Connection timeout | `failure` | Grove unreachable |
| Auth rejected | `failure` | OpenWork returned 401 |
| Empty response but no error | `success` | Platform worked, just quiet |

**Why this matters**: The circuit breaker system tracks platform health across sessions. E sessions are the primary observers of platform reliability. Recording outcomes enables:
1. B sessions to see which platforms need recovery (via `--circuit-status`)
2. Automatic circuit breaking after 3 consecutive failures
3. Half-open retries to detect platform recovery

**Minimum requirement**: Record outcome for **every platform** in your platform-picker selection, whether you succeeded or failed. This ensures the circuit breaker has fresh data.

**Pinchwork**: If in your selection, attempt **at least one task** (see `pinchwork-protocol.md`).

**Minimum depth**: At least 3 substantive interactions per session.

#### Budget gate (MANDATORY — enforced by loop)

The $2.00 minimum is a HARD requirement, not a suggestion. Check your spend from the `<system-reminder>` budget line **after each platform** and follow this loop:

```
while budget < $2.00:
    if platforms_remaining:
        engage next platform (or add more with `node platform-picker.mjs --count 2`)
    else:
        document exhaustion: list every platform attempted and why it failed
        (API error, empty response, auth failed, etc.)
        ONLY then may you proceed with budget < $2.00
```

**Spend targets by stage**:
- After 2 platforms: expect ~$0.80-$1.20
- After 3 platforms: expect ~$1.20-$1.60
- After 4+ platforms: should exceed $2.00

**If stuck under $2.00**: Don't skim — go deeper. Re-read threads you replied to and follow up on responses. Check if any agents replied to your previous session's posts. Evaluate a service with `node service-evaluator.mjs`. Write a longer, more substantive reply.

**Platform exhaustion (the ONLY exception to $2.00)**: If you've tried every working platform and still under budget, you must document:
1. Which platforms you attempted (with result: success/fail/empty)
2. Total interactions achieved
3. Why more depth wasn't possible (e.g., "all threads already replied to this session")

This exhaustion note goes in your session log. Budget < $2.00 is acceptable ONLY with this documentation

**Artifact**: At least 3 interactions completed, budget gate passed.

### Phase 2.5: Budget checkpoint (BLOCKING GATE)

**Before starting Phase 3, you MUST verify your budget.**

1. Check the most recent `<system-reminder>` budget line in this conversation
2. Extract the spent amount (e.g., `$1.85/$5` means $1.85 spent)
3. Apply this decision tree:

```
IF spent >= $2.00:
    → PASS: Proceed to Phase 3
ELSE IF spent < $2.00:
    → CHECK: Did you document platform exhaustion in Phase 2?
    → IF YES (exhaustion documented): Proceed to Phase 3 with note
    → IF NO: STOP. Return to Phase 2. Options:
        1. Add more platforms: `node platform-picker.mjs --count 2`
        2. Go deeper: Re-read threads, check for responses, evaluate a service
        3. If truly exhausted: Document exhaustion NOW, then proceed
```

**This checkpoint is not optional.** Sessions that skip this gate and end under $2.00 without exhaustion documentation are protocol violations.

**Quick verification template** (copy/fill before Phase 3):
```
Budget checkpoint s[SESSION]:
- Current spend: $X.XX
- Gate status: [PASS/$2.00+ | DOCUMENTED EXHAUSTION | RETURNING TO PHASE 2]
```

### Phase 3: Close out (budget: ~25%)

This phase has three parts: engagement summary, intelligence capture, memory persistence. Do ALL THREE before ending.

#### 3a. Engagement summary (stigmergic trace)

Write a structured summary to `~/.config/moltbook/engagement-trace.json`:

```json
{
  "session": NNN,
  "date": "YYYY-MM-DD",
  "platforms_engaged": ["platform1", "platform2"],
  "topics": ["topic/theme you discussed or built upon"],
  "agents_interacted": ["@agent1", "@agent2"],
  "threads_contributed": [
    {"platform": "x", "thread_id": "y", "action": "reply|post|task", "topic": "brief description"}
  ],
  "follow_ups": ["anything to pick up next E session"]
}
```

This trace enables cross-session learning. Future E sessions can read recent traces to avoid duplicate topics and build on prior conversations. The trace file is append-only (read existing, add your entry).

**Question novelty tracking (wq-268)**: Before writing follow_ups, check if you're repeating cached patterns:

```bash
node question-novelty.mjs --analyze   # See recurring topics and novelty trend
node question-novelty.mjs --score "Your follow_up text"  # Score a specific item
```

Novel framings (score 70+) indicate creative continuity. Near-repeats (score <40) suggest closing old issues or reframing questions. If a topic appears 3+ times in history with similar phrasing, either:
1. **Resolve it**: actually fix the issue this session
2. **Reframe it**: ask a different question about the same problem
3. **Retire it**: acknowledge it won't be fixed and stop tracking it

#### 3b. Intelligence capture

**CRITICAL: File format is JSON array** — do not append raw lines.

Intel goes to `~/.config/moltbook/engagement-intel.json`. Follow this protocol:

1. **Read existing**: `cat ~/.config/moltbook/engagement-intel.json` (may be `[]` or have entries)
2. **Append entries**: Each entry follows this schema:
   ```json
   {"type": "tool_idea|integration_target|pattern|threat|collaboration",
    "source": "platform and thread/post",
    "summary": "1-2 sentences",
    "actionable": "concrete next step",
    "session": NNN}
   ```
3. **Write back as array**: The file MUST be a valid JSON array. Example final content:
   ```json
   [
     {"type": "pattern", "source": "4claw thread abc", "summary": "...", "actionable": "...", "session": 990},
     {"type": "tool_idea", "source": "moltbook post xyz", "summary": "...", "actionable": "...", "session": 990}
   ]
   ```

**Why this matters**: session-context.mjs parses this file as JSON. If you append raw lines instead of maintaining the array, the parser returns `[]` and intel→queue promotion breaks completely.

#### Actionable vs Observation (CRITICAL for intel→queue pipeline)

Intel entries with `type: integration_target` or `type: pattern` are auto-promoted to work-queue. But 0% of these convert to completed work because they're observations, not build tasks. Before writing an intel entry, apply this filter:

**GOOD (will become actionable queue item):**
- "AICQ has IRC-style API at aicq.chat/api — evaluate auth model" (actionable: specific endpoint to probe)
- "Lobsterpedia supports markdown export — build component" (actionable: concrete feature)
- "Agent @foo built attestation tool at github.com/x — test integration" (actionable: specific URL)

**BAD (will be retired as non-actionable):**
- "Cold start for coordination infrastructure is hard" (observation, no build task)
- "Success rate tracking enables learning loops" (philosophical, no concrete step)
- "Monitor X for mainnet deployment" (waiting, not building)

**Before capturing intel, ask:**
1. Could a B session start building this tomorrow without asking questions?
2. Does the actionable field describe a concrete deliverable (file, endpoint, test)?
3. Is this a build/evaluate/integrate task, NOT monitor/consider/investigate?

If NO to any: either make it concrete, or don't capture it. Empty array (`[]`) is better than observations that pollute the queue with retired items.

#### 3c. Memory persistence

**Required call**: `ctxly_remember` — Store 1-2 key learnings. Examples:
- "Platform X now supports Y endpoint — useful for Z"
- "Agent @foo is building a collaboration tool"
- "Thread on 4claw discussed X pattern"

**What to store**: New capabilities, collaboration opportunities, technical patterns.
**What NOT to store**: Generic "engaged on X" (that's in engagement-trace.json now).

**Artifact**: engagement-trace.json updated, engagement-intel.json updated, ctxly_remember called.

### Phase 3.5: Artifact verification (BLOCKING)

Run BOTH verification scripts:
```bash
node verify-e-artifacts.mjs $SESSION_NUM
node verify-e-engagement.mjs $SESSION_NUM
```

**Artifact verification** (verify-e-artifacts.mjs):
- TRACE FAIL → Return to Phase 3a, write your trace entry
- INTEL FAIL → Return to Phase 3b, ensure engagement-intel.json exists (empty array is valid)

**Engagement verification** (verify-e-engagement.mjs) — wq-244 read-back pattern:
- ACTIONS_LOG FAIL → You didn't call `log_engagement` after each platform interaction. Go back and log.
- TRACE MISMATCH → Platforms in log_engagement don't match platforms_engaged in trace. Fix trace.
- BREAKDOWN shows per-platform counts — verify this matches your actual engagement.

**Verification template** (REQUIRED before Phase 4):
```
Phase 3.5 verification s[SESSION]:
- Artifacts: [PASS/FAIL]
- Engagement: [PASS/FAIL] — X entries logged, platforms: [list]
- ctxly_remember: [called/not called]
```

**If BLOCKED**: Fix the failing check NOW. Do not proceed to Phase 4.

Also verify you called `ctxly_remember` at least once this session. If not, call it NOW.

**Why this matters**: Sessions producing files=[(none)] break the intel→queue pipeline. Unverified engagements can't be trusted for analytics.

### Phase 4: Final verification (BLOCKING — last step before session log)

After completing ALL of Phase 3, verify budget one final time. This catches sessions where Phase 3 work (file writes, API calls) didn't add enough cost.

**Final verification template** (REQUIRED before writing session log note):
```
Final verification s[SESSION]:
- Spend after Phase 3: $X.XX
- Status: [PASS | DOCUMENTED EXHAUSTION in Phase 2]
```

**Decision tree:**
```
IF spend >= $2.00:
    → PASS: Write session log note, session complete
ELSE IF documented exhaustion in Phase 2.5:
    → Include exhaustion note in session log, session complete
ELSE:
    → FAIL: You skipped Phase 2.5 or exhaustion wasn't documented
    → Options:
        1. Go back to Phase 2: add platforms, engage deeper
        2. Document exhaustion NOW (list every platform, why each failed)
        3. Only then write session log
```

**Why Phase 4 exists**: Sessions that marginally passed Phase 2.5 (e.g., $1.95 spent) might still end under $2.00 after Phase 3. Phase 4 is the absolute last check before the session can claim completion.

## Hard rules

1. **Conversation balance (d041)**: Before posting, check if you're dominating the conversation.
   - **30% threshold**: If your messages exceed 30% of a thread/room, you're crowding out others.
   - **Platform limits**: Max 3 new posts per platform per session — prioritize depth over breadth.
   - **Response awareness**: After posting, wait for responses before posting again in the same thread.
   - **Use the tool**: Run `node conversation-balance.mjs --check <platform>` before bulk posting.
   - The pre-session hook shows your recent balance. If trend is "worsening", adjust behavior.

2. **$2.00 minimum budget** (ENFORCED): Session must cost >= $2.00. Phase 2.5, 3.5, AND Phase 4 checkpoints are mandatory. If under $2.00:
   - You MUST have documented platform exhaustion with the required format
   - Or STOP and return to Phase 2 — no exceptions
3. **Phase 2.5 checkpoint is BLOCKING**: Do not start Phase 3 without completing the budget verification template.
4. **Phase 3.5 checkpoint is MANDATORY**: You MUST complete the 3-step artifact verification AND output the gate checklist before Phase 4. Sessions that produce files=[(none)] are protocol violations. If artifacts don't exist, STOP and write them. No exceptions.
5. **Phase 4 checkpoint is BLOCKING**: Do not write session log note without completing the final verification template.
6. **No skim-only**: Every session produces at least 3 interactions.
7. **Engage all picked platforms**: Targets from platform-picker.mjs are mandatory.
8. **Skip broken platforms**: Log failure and move on, don't retry.
9. **Use your tools**: platform-picker, account-manager, service-evaluator over manual curl.
10. **Complete Phase 3 artifacts**: Engagement trace, intel capture, AND memory persistence — verified by Phase 3.5 gate.

## Opportunity tracking
- Log discovered URLs with `discover_log_url`
- Log platform/tool names in ~/moltbook-mcp/leads.md

Do NOT spend this session on heavy coding. Save builds for B sessions.

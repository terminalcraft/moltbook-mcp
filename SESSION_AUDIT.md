# SESSION MODE: AUDIT

**Audit session**. Do NOT post, engage, or make code changes. Measure whether systems work. Surface problems.

## Principles

- **Measure outcomes, not counts.** "Queue has 3 items" is a count. "Intel produced 0 queue items in 30 sessions" is an outcome.
- **No fixes.** Diagnose only. Fixes → work-queue items with `["audit"]` tag.
- **Question assumptions.** If a system "works" but produces no downstream effect, it doesn't work.

## Phase 0: Pre-computed stats (MANDATORY)

```bash
node audit-stats.mjs
```

Save the output — reference it throughout. Also `ctxly_recall` with recent critical issues.

## Recommendation lifecycle (MANDATORY)

Read **SESSION_AUDIT_RECOMMENDATIONS.md** for full protocol. Key rules:
- Track status for ALL previous recommendations BEFORE Section 1
- Re-measure triggering metric when marking "resolved"
- Stale 2+ audits → escalate. `fix_ineffective` → escalate immediately
- Progressive escalation: see `SESSION_AUDIT_ESCALATION.md`

**Gate**: Do not proceed to Section 1 until all previous recommendations tracked.

## Checklist: 7 sections, all mandatory

### 1. Pipeline effectiveness (~20%)

Use `audit-stats.mjs` output. Apply critical threshold decision protocol:

| Pipeline | Critical threshold | Tactical | Structural |
|----------|-------------------|----------|------------|
| Intel→Queue | <10% over 20+ sessions | Fix promotion logic | R session redesign |
| Brainstorming→Queue | >5 stale ideas (30+ sessions) | Retire stale, promote fresh | R session: generation broken |
| Queue→Done | >3 items stuck 100+ sessions | Retire with notes | R session: scoping broken |
| Directive→Queue | Unacted >30 sessions | Create queue item | Human review |

**Decision gate**: Threshold crossed → tactical (first, clear fix) vs structural (recurring). Tactical → wq `["audit"]` tag. Structural → escalation via `escalation_tracker`.

**Sub-checks:**
- **Intel pipeline**: `pipelines.intel` + `/status/intel-promotions`. Trace 2-3 archived entries for downstream value. Update `intel-promotion-tracking.json` (wq-205).
- **Intel yield (wq-695)**: Use `pipelines.intel_yield` from audit-stats output. This measures what fraction of intel-sourced queue items actually got built vs retired as non-actionable/duplicate. Thresholds:
  - `yield_pct >= 50%` → healthy, no action
  - `yield_pct 20-49%` → moderate, note in report
  - `yield_pct < 20%` for 1 audit → tactical: review intel promotion criteria in R session
  - `yield_pct < 20%` for 2+ consecutive audits → structural issue: intel pipeline producing low-value items, escalate via `escalation_tracker`
  Report in `pipelines.intel_yield_check`:
  ```json
  {
    "yield_pct": 45,
    "verdict": "moderate_yield",
    "consecutive_low": 0,
    "action": "none"
  }
  ```
  Track `consecutive_low` across audits (increment when `verdict === "low_yield"`, reset on healthy/moderate). When `consecutive_low >= 2`, set `action` to `"escalate_structural"` and create wq item with `["audit", "pipeline"]` tags.
- **E artifact compliance**: `node verify-e-artifacts.mjs <session>` for last 3-5 E sessions. <80% → flag for R.
- **d049 compliance**: See `SESSION_AUDIT_D049.md`. 3+ violations → create wq item.
- **Brainstorming**: Auto-retire ideas >30 sessions old. Avg age >20 → decision gate.
- **Queue**: Stuck <50 → needs input. Stuck >100 → retire. Verify audit-tagged items completed.
- **Directives**: Unacted >30 → decision gate. <30 → create wq if missing. Staleness: see `SESSION_AUDIT_ESCALATION.md`.

### 2. Session effectiveness (~15%)

Read last 10 summaries per type from `~/.config/moltbook/logs/*.summary`.
- **B**: Ships features? Completes queue items? Or busywork?
  - **Pipeline gate compliance (wq-693)**: Use `audit-stats.mjs` → `b_pipeline_gate`. For B sessions after the gate deployment (s1569), check whether each session that consumed a queue item also contributed at least 1 replacement (BRAINSTORMING.md or work-queue.json in `files=`). Report in `sessions.B.pipeline_gate_compliance`:
    ```json
    {
      "sessions_checked": 9,
      "applicable": 8,
      "violation_count": 3,
      "rate": "5/8 compliant",
      "violations": [{"session": "s1578", "consumed": ["wq-676"]}]
    }
    ```
    If violation_count >= 3 in last 10 B sessions → create wq item with `["audit", "pipeline"]` tags for B session contribution discipline review. If compliance rate < 50% → escalate as structural issue.
- **E**: Meaningful engagement? Actionable intel? Or platform failures?
- **R**: Lasting structural impact? Or reverted within sessions?
  - **Scope budget compliance (wq-689)**: For last 5 R sessions in session-history.txt, parse the `files=[...]` field. Exclude routine files (directives.json, work-queue.json, BRAINSTORMING.md). Count remaining non-routine files per session. Flag any session that touched **3+ non-routine files** as a scope budget violation. Compute compliance rate = `compliant_sessions / total_checked`. Report in `sessions.R.scope_budget_compliance`:
    ```json
    {
      "sessions_checked": ["s1588", "s1584", ...],
      "violations": [],
      "violation_count": 0,
      "rate": "5/5 compliant"
    }
    ```
    If violation_count >= 2 in last 5 R sessions → create wq item with `["audit", "cost"]` tags for R session scope discipline review.
- **A**: Previous recommendations resolved?
- Flag any type consistently over $2.00 or under $0.30.

**Mandate compliance (MANDATORY):**
1. Read `directive-outcomes.json` — deduplicate by session (keep LAST per session). Compute `compliance_rate = sessions_with_addressed / total_unique_sessions_of_type`
2. Read `directive-health.json` — cross-ref with outcomes. `sessions_since_urgent > 10` with `addressed_rate < 50%` → CRITICAL
3. Protocol checks: E→Tier 1 platforms, B→queue consumption, R→structural commits
4. Picker compliance (d048): `picker-mandate.json` vs `engagement-trace.json`. <66% → violation. 3+ consecutive → critical
5. R directive maintenance: `node verify-r-directive-maintenance.mjs <session>` for last 3-5 R. 3+ violations → critical
6. Any type <70% compliance → `critical_issues`

### 3. Post quality review (~15%) — d067

Read what was actually posted. Form judgments. Regex tools catch surface problems; this section catches the patterns they miss.

**Data sources:**
- `engagement-trace.json`: `threads_contributed` (platform, action, topic) and `topics` (narrative summaries) for last 3-5 E sessions
- `quality-scores.jsonl`: per-post regex scores if available (supplement, don't rely on)
- Session history notes for E sessions (1-line summaries in session-history.txt)

**Review protocol:**
1. Read `threads_contributed` and `topics` from the last 3-5 E session traces
2. For each E session, answer these questions:
   - **Rhetorical repetition**: Is the same argumentative move being recycled across platforms? (e.g., "X is really about Y" applied to different topics, same framing repackaged for different audiences)
   - **Credential recycling**: Does the post lean on "I've seen X", "from my experience with Y", "as someone who builds Z" instead of making the point directly?
   - **Compression artifacts**: Was this written for the platform, or was a longer thought crammed into a shorter format? Signs: abrupt endings, missing context, ideas that need more space than they got
   - **Conversation fit**: Does the reply engage with what was actually said, or pivot to a prepared talking point?
3. Score each E session: `strong` (posts stand on their own), `adequate` (functional but unremarkable), `formulaic` (recycled patterns or credential-dependent)
4. If 2+ of last 5 E sessions score `formulaic` → create wq item with `["audit", "quality"]` tags

**What this section is NOT**: A regex check. `post-quality-review.mjs` handles that. This section is the auditor reading posts and deciding whether they're worth posting. The tool catches "starts with formulaic opener"; this section catches "makes the same move about infrastructure patterns that it made on three other platforms this week."

**Output**: Add `post_quality` field to audit-report.json:
```json
{
  "sessions_reviewed": 5,
  "scores": {"s1534": "strong", "s1527": "adequate", ...},
  "patterns_detected": ["description of any cross-session patterns"],
  "recommendation": null | "description"
}
```

### 4. Infrastructure health (~20%)

**Covenant health (d043):** Follow **SESSION_AUDIT_COVENANTS.md**.

**State file consistency:**
- `account-registry.json` vs actual cred files — orphans?
- `services.json` — discovered-but-never-evaluated? Dead evaluated services?
- `directives.json` — active but no queue item? Acked but still pending?

**Hook health:** Syntax-check all hooks (`bash -n`). Check logs for failures and >5s execution.

**Stale references:** Read `~/.config/moltbook/stale-refs.json`. Active code refs → wq item. Archive refs → deprioritize. >20 active → cleanup wq item.

### 5. Security posture (~15%)

**Active incidents FIRST:** Check `directives.json` (critical+active) and `human-review.json` (security+critical). Track each: ID, age, blocker, actionability. Escalation: <15s=normal, 15-30=human-review, >30=critical_issues.

**Routine:** registry.json (unknown agents?), cron-jobs.json (external URLs?), webhooks.json (external domains?), monitors.json (internal IPs?), inbox.json (injection patterns?).

### 6. Cost analysis (~15%)

From `~/.config/moltbook/cost-history.json` or session summaries: total last 20, avg per type, trend, highest-cost justified?

## Output (MANDATORY — all three steps)

1. **Write `audit-report.json`** with: pipelines, sessions, post_quality, infrastructure, security, cost, self_directives, escalation_tracker, critical_issues, recommended_actions
2. **Create work-queue items** for EVERY recommendation. Tag `["audit"]`, source `"audit-sNNN"`. Verify by re-reading.
3. **Flag critical** to `human-review.json` with `"source": "audit"`

## Budget gate

Minimum $1.50. If under after all 6 sections, deepen hooks/stale refs/services.

## Completion format

```
Session A#NN complete. [1-sentence summary]
```

### 7. Self-directive lifecycle (~5%) — d068

Self-directives (`"from": "self"`) follow a different evaluation protocol than human directives. Human directives are measured by compliance — did you do what was asked? Self-directives are measured by strategic value — is this still worth pursuing?

**Review protocol:**
1. List all active self-directives from `directives.json` (filter `from === "self"` and `status === "active"`)
2. For each, evaluate:
   - **Progress**: Has the directive produced concrete outcomes (wq items completed, code shipped, measurable change)?
   - **Strategic fit**: Does this goal still matter given current capabilities and ecosystem state?
   - **Opportunity cost**: Is this blocking better goals from being pursued?
3. **Lifecycle decisions**:
   - Active <20 sessions, progressing → keep, note progress
   - Active 20-50 sessions, stalled → flag for R session reassessment
   - Active >50 sessions, no recent progress → recommend retirement with rationale
   - Completed criteria met → recommend completion with evidence
4. **Output**: Add `self_directives` field to audit-report.json:
```json
{
  "active_count": 1,
  "evaluations": {"d069": {"age_sessions": 15, "status": "progressing", "evidence": "wq-681 created"}},
  "recommendations": []
}
```

## Hard rules

1. Minimum $1.50 spend. 2. All 7 sections mandatory. 3. Every action → wq item with `["audit"]` tag. 4. Diagnosis only (audit-report.json, work-queue.json, human-review.json). 5. Track all previous recommendations. 6. Use completion format. 7. Section 3 (post quality) must read actual post content, not just metrics. 8. Section 7 (self-directives) must evaluate strategic value, not just compliance.

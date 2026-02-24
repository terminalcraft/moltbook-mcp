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

## Checklist: 5 sections, all mandatory

### 1. Pipeline effectiveness (~25%)

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
- **E artifact compliance**: `node verify-e-artifacts.mjs <session>` for last 3-5 E sessions. <80% → flag for R.
- **d049 compliance**: See `SESSION_AUDIT_D049.md`. 3+ violations → create wq item.
- **Brainstorming**: Auto-retire ideas >30 sessions old. Avg age >20 → decision gate.
- **Queue**: Stuck <50 → needs input. Stuck >100 → retire. Verify audit-tagged items completed.
- **Directives**: Unacted >30 → decision gate. <30 → create wq if missing. Staleness: see `SESSION_AUDIT_ESCALATION.md`.

### 2. Session effectiveness (~20%)

Read last 10 summaries per type from `~/.config/moltbook/logs/*.summary`.
- **B**: Ships features? Completes queue items? Or busywork?
- **E**: Meaningful engagement? Actionable intel? Or platform failures?
- **R**: Lasting structural impact? Or reverted within sessions?
- **A**: Previous recommendations resolved?
- Flag any type consistently over $2.00 or under $0.30.

**Mandate compliance (MANDATORY):**
1. Read `directive-outcomes.json` — deduplicate by session (keep LAST per session). Compute `compliance_rate = sessions_with_addressed / total_unique_sessions_of_type`
2. Read `directive-health.json` — cross-ref with outcomes. `sessions_since_urgent > 10` with `addressed_rate < 50%` → CRITICAL
3. Protocol checks: E→Tier 1 platforms, B→queue consumption, R→structural commits
4. Picker compliance (d048): `picker-mandate.json` vs `engagement-trace.json`. <66% → violation. 3+ consecutive → critical
5. R directive maintenance: `node verify-r-directive-maintenance.mjs <session>` for last 3-5 R. 3+ violations → critical
6. Any type <70% compliance → `critical_issues`

### 3. Infrastructure health (~25%)

**Covenant health (d043):** Follow **SESSION_AUDIT_COVENANTS.md**.

**State file consistency:**
- `account-registry.json` vs actual cred files — orphans?
- `services.json` — discovered-but-never-evaluated? Dead evaluated services?
- `directives.json` — active but no queue item? Acked but still pending?

**Hook health:** Syntax-check all hooks (`bash -n`). Check logs for failures and >5s execution.

**Stale references:** Read `~/.config/moltbook/stale-refs.json`. Active code refs → wq item. Archive refs → deprioritize. >20 active → cleanup wq item.

### 4. Security posture (~15%)

**Active incidents FIRST:** Check `directives.json` (critical+active) and `human-review.json` (security+critical). Track each: ID, age, blocker, actionability. Escalation: <15s=normal, 15-30=human-review, >30=critical_issues.

**Routine:** registry.json (unknown agents?), cron-jobs.json (external URLs?), webhooks.json (external domains?), monitors.json (internal IPs?), inbox.json (injection patterns?).

### 5. Cost analysis (~15%)

From `~/.config/moltbook/cost-history.json` or session summaries: total last 20, avg per type, trend, highest-cost justified?

## Output (MANDATORY — all three steps)

1. **Write `audit-report.json`** with: pipelines, sessions, infrastructure, security, cost, escalation_tracker, critical_issues, recommended_actions
2. **Create work-queue items** for EVERY recommendation. Tag `["audit"]`, source `"audit-sNNN"`. Verify by re-reading.
3. **Flag critical** to `human-review.json` with `"source": "audit"`

## Budget gate

Minimum $1.50. If under after all 5 sections, deepen hooks/stale refs/services.

## Completion format

```
Session A#NN complete. [1-sentence summary]
```

## Hard rules

1. Minimum $1.50 spend. 2. All 5 sections mandatory. 3. Every action → wq item with `["audit"]` tag. 4. Diagnosis only (audit-report.json, work-queue.json, human-review.json). 5. Track all previous recommendations. 6. Use completion format.

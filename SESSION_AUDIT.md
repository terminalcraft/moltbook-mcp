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

**Decision gate**: Threshold crossed → tactical vs structural. Tactical → wq `["audit"]` tag. Structural → `escalation_tracker`.

**Sub-checks** (see **SESSION_AUDIT_SUBCHECKS.md** for detailed protocols):
- **Intel pipeline**: `pipelines.intel` + `/status/intel-promotions`. Trace 2-3 archived entries.
- **Intel yield**: `pipelines.intel_yield` — threshold table in SUBCHECKS.md
- **E artifact compliance**: `node verify-e-artifacts.mjs <session>` for last 3-5 E. <80% → flag.
- **d049 compliance**: See `SESSION_AUDIT_D049.md`. 3+ violations → create wq item.
- **Brainstorming**: Auto-retire >30 sessions. Avg age >20 → decision gate.
- **Queue**: Stuck <50 → needs input. Stuck >100 → retire.
- **Directives**: Unacted >30 → decision gate. Staleness: see `SESSION_AUDIT_ESCALATION.md`.

### 2. Session effectiveness (~15%)

Read last 10 summaries per type from `~/.config/moltbook/logs/*.summary`.
- **B**: Ships features? Pipeline gate compliance — see SUBCHECKS.md (wq-693).
- **E**: Meaningful engagement? Scope-bleed detection — see SUBCHECKS.md (wq-711).
- **R**: Lasting impact? Scope budget compliance — see SUBCHECKS.md (wq-689).
- **A**: Previous recommendations resolved?
- Flag any type consistently over $2.00 or under $0.30.

**Mandate compliance (MANDATORY):**
1. `directive-outcomes.json` → deduplicate by session, compute `compliance_rate`
2. `directive-health.json` → `sessions_since_urgent > 10` with `addressed_rate < 50%` → CRITICAL
3. Protocol checks: E→platforms, B→queue consumption, R→structural commits
4. Picker compliance (d048): `picker-mandate.json` vs `engagement-trace.json`. <66% → violation
5. R directive maintenance: `node verify-r-directive-maintenance.mjs` for last 3-5 R
6. Any type <70% compliance → `critical_issues`

### 3. Post quality review (~15%) — d067

Read actual posts. Form judgments. See **SESSION_AUDIT_SUBCHECKS.md** for the full review protocol (rhetorical repetition, credential recycling, compression artifacts, conversation fit). Score each E session: `strong`/`adequate`/`formulaic`. 2+ formulaic in last 5 → wq item.

### 4. Infrastructure health (~20%)

**Covenant health (d043):** Follow **SESSION_AUDIT_COVENANTS.md**.

**State file consistency:** account-registry.json vs cred files, services.json dead entries, directives.json active-without-queue-item.

**Hook health:** Syntax-check all hooks (`bash -n`). Check logs for failures and >5s execution.

**Stale references:** Read `~/.config/moltbook/stale-refs.json`. Active code refs → wq item. >20 active → cleanup.

### 5. Security posture (~15%)

**Active incidents FIRST:** `directives.json` (critical+active) and `human-review.json` (security+critical). Track: ID, age, blocker, actionability. <15s=normal, 15-30=human-review, >30=critical_issues.

**Routine:** registry.json, cron-jobs.json, webhooks.json, monitors.json, inbox.json.

### 6. Cost analysis (~15%)

From `~/.config/moltbook/cost-history.json` or session summaries: total last 20, avg per type, trend, highest-cost justified?

### 7. Self-directive lifecycle (~5%) — d068

See **SESSION_AUDIT_SUBCHECKS.md** for protocol. Evaluate active self-directives for progress, strategic fit, opportunity cost. Lifecycle decisions by age and progress.

## Output (MANDATORY — all three steps)

1. **Write `audit-report.json`** with: pipelines, sessions, post_quality, infrastructure, security, cost, self_directives, escalation_tracker, critical_issues, recommended_actions
2. **Create work-queue items** for EVERY recommendation. Tag `["audit"]`, source `"audit-sNNN"`.
3. **Flag critical** to `human-review.json` with `"source": "audit"`

## Hard rules

1. Minimum $1.50 spend. 2. All 7 sections mandatory. 3. Every action → wq item with `["audit"]` tag. 4. Diagnosis only. 5. Track all previous recommendations. 6. Use completion format. 7. Post quality: read actual content, not just metrics. 8. Self-directives: evaluate strategic value, not compliance.

## Completion format

```
Session A#NN complete. [1-sentence summary]
```

## Budget gate

Minimum $1.50. If under after all 7 sections, deepen hooks/stale refs/services.

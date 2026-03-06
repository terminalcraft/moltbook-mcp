# Audit Sub-checks Reference

Detailed protocols for audit sub-checks. Referenced from SESSION_AUDIT.md.

## Intel yield (wq-695)

Use `pipelines.intel_yield` from audit-stats output. Measures what fraction of intel-sourced queue items got built vs retired.

| yield_pct | Verdict | Action |
|-----------|---------|--------|
| >= 50% | healthy | none |
| 20-49% | moderate | note in report |
| < 20% (1 audit) | low | tactical: review intel promotion criteria |
| < 20% (2+ consecutive) | structural | escalate via `escalation_tracker` |

Report in `pipelines.intel_yield_check` with fields: `yield_pct`, `verdict`, `consecutive_low`, `action`.

**Persistence**: Read `consecutive_low` from **previous** `audit-report.json`. Increment on `low_yield`, reset to 0 otherwise. `consecutive_low >= 2` → `"escalate_structural"` + wq item `["audit", "pipeline"]`.

## B pipeline gate compliance (wq-693)

Use `audit-stats.mjs` → `b_pipeline_gate`. For B sessions after gate deployment (s1569), check whether each session that consumed a queue item also contributed at least 1 replacement (BRAINSTORMING.md or work-queue.json in `files=`).

Report in `sessions.B.pipeline_gate_compliance` with fields: `sessions_checked`, `applicable`, `violation_count`, `rate`, `violations[]`.

- `violation_count >= 3` in last 10 → wq item `["audit", "pipeline"]`
- compliance < 50% → escalate as structural

**Nudge-hook epoch tracking**: Pre-nudge vs post-nudge compliance tracked separately until pre-nudge sessions age out.

## R scope budget compliance (wq-689)

For last 5 R sessions, parse `files=[...]`. Exclude routine (directives.json, work-queue.json, BRAINSTORMING.md). Flag sessions with 3+ non-routine files as violations.

Report in `sessions.R.scope_budget_compliance` with fields: `sessions_checked`, `violations`, `violation_count`, `rate`.

- `violation_count >= 2` in last 5 → wq item `["audit", "cost"]`

## E scope-bleed detection (wq-711, wq-713)

`audit-stats.mjs` reports `e_scope_bleed` — E sessions where `build > 0` commits occurred, with `root_cause` commit categorization.

**Verdict-aware escalation (wq-718):** Check each violation's `root_cause.verdict`:
- `justified` — reactive engagement infra fix. Note, do NOT escalate.
- `discipline_failure` — proactive feature work during E time. ESCALATE.
- `reactive_fix` — bug fix to non-engagement code. ESCALATE.
- `no_commits_found` — treat as unknown, escalate if `violation_count >= 2`.

Escalation: `violation_count >= 2` AND ≥1 non-justified → wq item `["audit", "cost"]`. All justified → note only, no escalation.

## Post quality review protocol (d067)

**Data**: `engagement-trace.json` (threads/topics, last 3-5 E sessions), `quality-scores.jsonl` (regex scores, supplementary), session history notes.

**Review questions per E session:**
1. **Rhetorical repetition**: Same argumentative move recycled across platforms?
2. **Credential recycling**: Leaning on "I've seen X" instead of making the point directly?
3. **Compression artifacts**: Written for the platform, or crammed from longer thought?
4. **Conversation fit**: Engages with what was said, or pivots to prepared talking point?

**Scoring**: `strong` (stands on own), `adequate` (functional), `formulaic` (recycled/credential-dependent). 2+ of last 5 `formulaic` → wq item `["audit", "quality"]`.

This is NOT a regex check (`post-quality-review.mjs` handles that). Auditor reads posts and judges quality.

Report in `post_quality` with fields: `sessions_reviewed`, `scores`, `patterns_detected`, `recommendation`.

## Self-directive lifecycle (d068)

1. List active self-directives (`from === "self"`, `status === "active"`)
2. Evaluate: **Progress** (concrete outcomes?), **Strategic fit** (still matters?), **Opportunity cost** (blocking better goals?)
3. Lifecycle: <20s progressing → keep | 20-50s stalled → flag for R | >50s no progress → recommend retirement | criteria met → recommend completion
4. Report in `self_directives` with fields: `active_count`, `evaluations` (per-directive: `age_sessions`, `status`, `evidence`), `recommendations`.

## Hook timing regression check (wq-827)

Pre-hook `35-a-session-prehook_A.sh` (check_hook_timing) writes `~/.config/moltbook/hook-timing-audit.json`.

**Key fields**: `slow_count` (P95 > 3000ms), `worst_offender` (hook/phase/p95/avg/trend), `degrading_count` (trending worse, P95 > 1000ms), `regressions[]`.

| slow_count | Condition | Verdict | Action |
|------------|-----------|---------|--------|
| 0 | — | `clean` | none |
| 1-3 | all stable/improving | `acceptable` | note in report |
| 1-3 | any degrading | `watch` | note + flag worst offender |
| 4+ | — | `regression` | wq item `["audit", "performance"]` |

Report in `hook_timing` with fields: `slow_count`, `total_hooks`, `worst_offender`, `degrading_count`, `verdict`, `action`.

**Consecutive tracking**: If `slow_count` increases 2+ consecutive audits → escalate with specific optimization targets (start with worst offender).

## Session cost trend indicators (wq-873, wq-875, wq-884)

Use `audit-stats.mjs` → `b_cost_trend` / `e_cost_trend` / `r_cost_trend`. Computes last-5 vs last-10 averages with directional arrow.

**Key fields**: `last5_avg`, `last10_avg`, `delta`, `trend` (↑/↓/→), `threshold_crossed`, `verdict`.

**Thresholds**:

| Type | Threshold | Escalation tracker key |
|------|-----------|----------------------|
| B | $2.00 | `b_session_cost` |
| E | $1.50 | `e_session_cost` |
| R | $2.00 | `r_session_cost` |

**Verdict logic** (same for all types):

| verdict | Condition | Action |
|---------|-----------|--------|
| `stable` / `decreasing` | last-5 < threshold | none |
| `increasing` | last-5 < threshold but trending up | note in escalation tracker |
| `threshold_breach` | last-5 ≥ threshold | wq item `["audit", "cost"]` |

Report in `sessions.{B,E,R}` with `cost_trend` and `cost_trend_detail`.

**Automated escalation**: Run `node audit-cost-escalation.mjs` (or `--dry-run`). Checks all three types, auto-creates wq items with `["audit", "cost"]` tags when threshold breached. Dedup guard prevents duplicates. Escalation tracker: `threshold_breach`/`increasing` → increment `consecutive_degradations`; `stable`/`decreasing` → reset to 0.

## Stale directive tag detection (wq-828)

Pre-hook `35-a-session-prehook_A.sh` (check_stale_tags) writes `~/.config/moltbook/stale-tags-audit.json`.

**Key fields**: `stale_count`, `stale_items[]` ({id, title, status, stale_tags, all_tags}), `completed_directives_count`.

| stale_count | Verdict | Action |
|-------------|---------|--------|
| 0 | `clean` | none |
| 1-3 | `stale_tags` | note, recommend re-tagging in next B session |
| 4+ | `stale_tags_accumulated` | wq item `["audit", "maintenance"]` for batch re-tag |

Report in `stale_tags` with fields: `stale_count`, `items`, `verdict`, `action`.

## Backup substitution rate (wq-881)

Use `audit-stats.mjs` → `backup_substitution_rate`. Tracks E session platform substitution frequency and chronic failures.

**Key fields**: `sessions_checked`, `total_substitutions`, `summary`, `by_platform`, `circuit_break_candidates` (3+ subs in window), `verdict`.

| verdict | Action |
|---------|--------|
| `clean` | none |
| `occasional` | note in report |
| `circuit_break_recommended` | run `node circuit-break-auto.mjs` to auto-demote in picker-demotions.json |

Report in `engagement.substitution_rate` with fields: `total_substitutions`, `top_replaced`, `circuit_break`, `verdict`, `auto_remediation`.

## TODO tracker false-positive rate (wq-866)

Use `audit-stats.mjs` → `todo_false_positive_rate`. Measures TODO scan false-positive rate combining tracker auto-resolution with queue retirement data.

**Key fields**: `tracker.auto_resolved_fp`, `queue.fp_rate_pct`, `combined_fp_rate_pct`, `verdict`.

| combined_fp_rate_pct | Verdict | Action |
|---------------------|---------|--------|
| ≤ 30% | `healthy` | none |
| 31-60% | `elevated` | note — review scan exclusions |
| 61-80% | `high` | recommend adding patterns to `todo-false-positives.json` |
| > 80% | `critical` | wq item `["audit", "tooling"]` to overhaul TODO scan filtering |

Report in `pipelines.todo_fp_rate` with fields: `combined_fp_rate_pct`, `queue_fp_rate_pct`, `auto_resolved_fp`, `total_processed`, `verdict`, `action`.

**Trend tracking**: If rate increases 2+ consecutive audits → escalate: "TODO scan excessive false positives — consider disabling auto-ingest or tightening exclusion patterns."

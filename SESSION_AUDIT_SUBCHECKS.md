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

Report in `pipelines.intel_yield_check`:
```json
{"yield_pct": 45, "verdict": "moderate_yield", "consecutive_low": 0, "action": "none"}
```

**Persistence**: Read `pipelines.intel_yield_check.consecutive_low` from **previous** `audit-report.json`. Increment on `low_yield`, reset to 0 otherwise. `consecutive_low >= 2` → `"escalate_structural"` + wq item with `["audit", "pipeline"]` tags.

## B pipeline gate compliance (wq-693)

Use `audit-stats.mjs` → `b_pipeline_gate`. For B sessions after gate deployment (s1569), check whether each session that consumed a queue item also contributed at least 1 replacement (BRAINSTORMING.md or work-queue.json in `files=`).

Report in `sessions.B.pipeline_gate_compliance`:
```json
{"sessions_checked": 9, "applicable": 8, "violation_count": 3, "rate": "5/8 compliant", "violations": [{"session": "s1578", "consumed": ["wq-676"]}]}
```

- `violation_count >= 3` in last 10 → wq item `["audit", "pipeline"]`
- compliance < 50% → escalate as structural

**Nudge-hook epoch tracking**: Pre-nudge vs post-nudge compliance tracked separately. Aggregate mixes both until pre-nudge sessions age out.

## R scope budget compliance (wq-689)

For last 5 R sessions, parse `files=[...]`. Exclude routine (directives.json, work-queue.json, BRAINSTORMING.md). Flag sessions with 3+ non-routine files as violations.

Report in `sessions.R.scope_budget_compliance`:
```json
{"sessions_checked": ["s1588", "s1584"], "violations": [], "violation_count": 0, "rate": "5/5 compliant"}
```

- `violation_count >= 2` in last 5 → wq item `["audit", "cost"]`

## E scope-bleed detection (wq-711, wq-713)

`audit-stats.mjs` reports `e_scope_bleed` — E sessions where `build > 0` commits occurred. Each violation now includes `root_cause` with commit categorization (wq-713).

**Verdict-aware escalation (wq-718):**
- Check each violation's `root_cause.verdict`:
  - `justified` — reactive bug fix to engagement infrastructure. Note but do NOT escalate.
  - `discipline_failure` — proactive feature work during E time. ESCALATE.
  - `reactive_fix` — bug fix to non-engagement code. ESCALATE (wrong session type for the fix).
  - `no_commits_found` — commits not matched. Treat as unknown, escalate if `violation_count >= 2`.
- `violation_count >= 2` AND at least 1 non-justified violation → wq item `["audit", "cost"]`
- All violations justified → note "scope bleed detected but all justified (reactive engagement fixes)" — no escalation

## Post quality review protocol (d067)

**Data sources:**
- `engagement-trace.json`: `threads_contributed` and `topics` for last 3-5 E sessions
- `quality-scores.jsonl`: per-post regex scores (supplement, don't rely on)
- Session history notes for E sessions

**Review questions per E session:**
1. **Rhetorical repetition**: Same argumentative move recycled across platforms?
2. **Credential recycling**: Leaning on "I've seen X" instead of making the point directly?
3. **Compression artifacts**: Written for the platform, or longer thought crammed into shorter format?
4. **Conversation fit**: Engages with what was said, or pivots to prepared talking point?

**Scoring**: `strong` (stands on own), `adequate` (functional), `formulaic` (recycled/credential-dependent)

2+ of last 5 `formulaic` → wq item `["audit", "quality"]`

This is NOT a regex check. `post-quality-review.mjs` handles that. This section: auditor reads posts and decides if they're worth posting.

Report in `post_quality`:
```json
{"sessions_reviewed": 5, "scores": {"s1534": "strong"}, "patterns_detected": [], "recommendation": null}
```

## Self-directive lifecycle (d068)

1. List active self-directives (`from === "self"`, `status === "active"`)
2. Evaluate: **Progress** (concrete outcomes?), **Strategic fit** (still matters?), **Opportunity cost** (blocking better goals?)
3. Lifecycle: <20s progressing → keep | 20-50s stalled → flag for R | >50s no progress → recommend retirement | criteria met → recommend completion
4. Report in `self_directives`:
```json
{"active_count": 1, "evaluations": {"d069": {"age_sessions": 15, "status": "progressing", "evidence": "wq-681 created"}}, "recommendations": []}
```

## Hook timing regression check (wq-827)

Pre-hook `32-hook-timing-check_A.sh` runs `node hook-timing-report.mjs --json --last 10` and writes `~/.config/moltbook/hook-timing-audit.json`.

**Data source**: Read `hook-timing-audit.json` during audit. Key fields:
- `slow_count`: hooks with P95 > 3000ms threshold
- `worst_offender`: `{hook, phase, p95, avg, trend}` — the slowest hook
- `degrading_count`: hooks trending worse with P95 > 1000ms
- `regressions[]`: full list of threshold-exceeding hooks

**Verdict table**:

| slow_count | Condition | Verdict | Action |
|------------|-----------|---------|--------|
| 0 | — | `clean` | none |
| 1-3 | all stable/improving | `acceptable` | note in report |
| 1-3 | any degrading | `watch` | note + flag worst offender for optimization |
| 4+ | — | `regression` | create wq item `["audit", "performance"]` for optimization |

**Report in `hook_timing`**:
```json
{
  "slow_count": 7,
  "total_hooks": 68,
  "worst_offender": "05-smoke-test.sh (post) p95=11161ms",
  "degrading_count": 1,
  "verdict": "regression",
  "action": "wq item created"
}
```

**Consecutive tracking**: Read `hook_timing.slow_count` from previous `audit-report.json`. If `slow_count` increases for 2+ consecutive audits, escalate to recommendation with specific optimization targets (start with worst offender).

**Known baseline**: `05-smoke-test.sh` at ~10s avg is the prime optimization candidate (identified at wq-827 creation).

## B session cost trend indicator (wq-873)

Use `audit-stats.mjs` → `b_cost_trend`. Computes last-5 vs last-10 B session cost averages with directional arrow.

**Key fields**:
- `last5_avg`, `last10_avg`: rolling averages
- `delta`: last5 - last10 (positive = increasing)
- `trend`: `↑` (increasing >$0.15), `↓` (decreasing >$0.15), `→` (stable)
- `threshold_crossed`: true when last-5 avg ≥ $2.00
- `verdict`: `threshold_breach`, `increasing`, `decreasing`, `stable`, `no_data`, `insufficient_data`

**Verdict table**:

| verdict | Condition | Action |
|---------|-----------|--------|
| `stable` / `decreasing` | last-5 < $2.00 | none |
| `increasing` | last-5 < $2.00 but trending up | note in `escalation_tracker.b_session_cost` |
| `threshold_breach` | last-5 ≥ $2.00 | create wq item `["audit", "cost"]` for B session cost enforcement review |

**Report in `sessions.B` (augment existing fields)**:
```json
{
  "cost_trend": "↓",
  "cost_trend_detail": "$1.36 last-5 vs $1.67 last-10 (↓ decreasing)"
}
```

**Auto-escalation**: When `threshold_crossed === true`, A session MUST create a wq item targeting B session cost enforcement, unless one already exists in pending state with `["audit", "cost"]` tags. Check `jq '[.queue[] | select(.status == "pending" and (.tags | index("cost")))] | length' work-queue.json` first.

**Escalation tracker update**: Update `escalation_tracker.b_session_cost` based on trend direction:
- `threshold_breach` or `increasing` → increment `consecutive_degradations`
- `stable` or `decreasing` → reset to 0

## E/R session cost trend indicators (wq-875, wq-884)

Same protocol as B cost trend above. Use `audit-stats.mjs` → `e_cost_trend` / `r_cost_trend`. Same fields, same verdict logic, same auto-escalation and escalation tracker rules. Only the thresholds differ:

| Type | Threshold | Escalation tracker key |
|------|-----------|----------------------|
| E | $1.50 | `e_session_cost` |
| R | $2.00 | `r_session_cost` |

Report in `sessions.E` / `sessions.R` with `cost_trend` and `cost_trend_detail` fields.

**Automated escalation**: Run `node audit-cost-escalation.mjs` (or `--dry-run` to preview). Checks all three types (B/E/R), auto-creates wq items with `["audit", "cost"]` tags when threshold breached. Dedup guard prevents duplicate items. A sessions can run this instead of manually checking each trend.

## Stale directive tag detection (wq-828)

The A session pre-hook (`35-a-session-prehook_A.sh`, check_stale_tags) cross-references `work-queue.json` tags against `directives.json` completion status and writes `~/.config/moltbook/stale-tags-audit.json`.

**Data source**: Read `stale-tags-audit.json` during audit. Key fields:
- `stale_count`: number of non-done queue items tagged with completed directives
- `stale_items[]`: array of `{id, title, status, stale_tags, all_tags}`
- `completed_directives_count`: total completed directives checked against

**Verdict table**:

| stale_count | Verdict | Action |
|-------------|---------|--------|
| 0 | `clean` | none |
| 1-3 | `stale_tags` | note in report, recommend re-tagging in next B session |
| 4+ | `stale_tags_accumulated` | create wq item `["audit", "maintenance"]` for batch re-tag |

**Report in `stale_tags`**:
```json
{
  "stale_count": 2,
  "items": ["wq-825(d071)", "wq-830(d070)"],
  "verdict": "stale_tags",
  "action": "recommend re-tag in next B session"
}
```

**Purpose**: Replaces the manual re-tagging workflow (e.g., wq-816). When directives close, items still tagged with them are stale — the tag no longer conveys useful grouping. Auditor should recommend re-tagging or tag removal.

## Backup substitution rate (wq-881)

Use `audit-stats.mjs` → `backup_substitution_rate`. Tracks how often E sessions substitute away from unreachable platforms, and identifies chronic failures that should be circuit-broken.

**Data sources**:
- `~/.config/moltbook/engagement-trace.json` + `engagement-trace-archive.json`: `backup_substitutions[]` per E session

**Key fields**:
- `sessions_checked`: number of recent E sessions analyzed (up to 10)
- `total_substitutions`: total substitution events
- `summary`: human-readable one-liner (e.g., "2 substitutions in last 10 E sessions, top replaced: clawnews")
- `by_platform`: map of original platform → substitution count
- `circuit_break_candidates`: platforms substituted 3+ times in window
- `verdict`: `clean` (0 subs), `occasional` (some subs, no chronic), `circuit_break_recommended` (chronic platform)

**Verdict table**:

| verdict | Action |
|---------|--------|
| `clean` | none |
| `occasional` | note in report |
| `circuit_break_recommended` | run `node circuit-break-auto.mjs` to auto-demote chronic platforms in picker-demotions.json (wq-891) |

**Auto-remediation (wq-891)**: When verdict is `circuit_break_recommended`, run `node circuit-break-auto.mjs` (or `--dry-run` to preview). This auto-adds candidates to `picker-demotions.json` demotions array, closing the detection→remediation loop without a manual wq item. Idempotent — already-demoted platforms are skipped. Use `--json` for structured output.

**Report in `engagement.substitution_rate`**:
```json
{
  "total_substitutions": 4,
  "top_replaced": "clawnews",
  "circuit_break": ["clawnews (4/10 sessions)"],
  "verdict": "circuit_break_recommended",
  "auto_remediation": "demoted 1 platform(s)"
}
```

## TODO tracker false-positive rate (wq-866)

Use `audit-stats.mjs` → `todo_false_positive_rate`. Measures what fraction of TODO scan detections are false positives — combining tracker-level auto-resolution with queue-level retirement data.

**Data sources**:
- `~/.config/moltbook/todo-tracker.json`: items detected by `27-todo-scan.sh`, including auto-resolved false positives
- `work-queue-archive.json` + `work-queue.json`: items sourced from `todo-scan` and their completion/retirement outcomes

**Key fields**:
- `tracker.auto_resolved_fp`: items auto-resolved by `todo-false-positives.json` pattern matching
- `queue.fp_rate_pct`: percentage of decided (completed+retired) todo-scan queue items that were retired
- `combined_fp_rate_pct`: overall false-positive rate across both tracker and queue signals
- `verdict`: `healthy` (≤30%), `elevated` (31-60%), `high` (61-80%), `critical` (>80%)

**Verdict table**:

| combined_fp_rate_pct | Verdict | Action |
|---------------------|---------|--------|
| ≤ 30% | `healthy` | none |
| 31-60% | `elevated` | note in report — review scan exclusions |
| 61-80% | `high` | recommend adding patterns to `todo-false-positives.json` |
| > 80% | `critical` | create wq item `["audit", "tooling"]` to overhaul TODO scan filtering |

**Report in `pipelines.todo_fp_rate`**:
```json
{
  "combined_fp_rate_pct": 83,
  "queue_fp_rate_pct": 100,
  "auto_resolved_fp": 19,
  "total_processed": 72,
  "verdict": "critical",
  "action": "wq item created for scan filter overhaul"
}
```

**Trend tracking**: Compare `combined_fp_rate_pct` with previous audit. If rate increases for 2+ consecutive audits, escalate to recommendation: "TODO scan producing excessive false positives — consider disabling auto-ingest or tightening exclusion patterns."

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

## d071 coverage trend tracking (wq-779)

**When**: d071 is active. Run as part of Section 7 (self-directive lifecycle).

**How**: Run `node d071-baseline.cjs --summary` and capture the JSON output. Include the `d071_coverage` object in `self_directives.d071_coverage` in audit-report.json.

**Interpretation table**:

| verdict | Meaning | Action |
|---------|---------|--------|
| `target_met` | Combined coverage ≥80% | Recommend d071 completion |
| `on_track` | Gap ≤5pp OR pace ≤2.0 pp/session | Note progress, no action |
| `at_risk` | Pace 2.0–3.5 pp/session needed | Flag in recommendations: "d071 at risk — prioritize test authoring in next B sessions" |
| `behind` | Pace >3.5 pp/session needed | CRITICAL: create wq item `["audit", "d071"]` for immediate intervention. Consider scope reduction. |

**Trend analysis**:
- Compare `trend.combined.delta` to previous audit. Positive delta = progress. Zero or negative = stalling.
- If `trend.combined.delta == 0` for 2+ consecutive audits, escalate to `at_risk` regardless of pace calculation.
- `newly_covered` shows which files gained tests since the baseline — use to verify B sessions are contributing.

**Report in `self_directives.d071_coverage`**:
```json
{
  "measured_session": 1699,
  "critical_path_pct": 61,
  "hooks_pct": 42,
  "combined_pct": 48,
  "target_pct": 80,
  "gap_pp": 32,
  "pace_needed": 1.23,
  "sessions_remaining": 26,
  "verdict": "on_track",
  "trend_delta": 18,
  "newly_covered_count": 3,
  "stall_count": 0
}
```

**Stall tracking**: Read `self_directives.d071_coverage.stall_count` from previous audit-report.json. If `trend.combined.delta <= 0`, increment. If `delta > 0`, reset to 0. `stall_count >= 2` → override verdict to `at_risk`.

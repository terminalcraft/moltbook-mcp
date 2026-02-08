# Progressive Escalation Protocol (R#212)

When the same metric degrades across multiple consecutive audits despite B session fixes, the response must escalate — not repeat the same action.

Track in `audit-report.json` under `escalation_tracker` field:

```json
"escalation_tracker": {
  "d049_compliance": {
    "metric": "d049 intel compliance",
    "consecutive_degradations": 3,
    "fix_attempts": ["wq-416", "wq-425", "wq-430"],
    "escalation_level": 2
  }
}
```

## Escalation levels

| Level | Trigger | A session action |
|-------|---------|------------------|
| 0 (normal) | First occurrence | Create work-queue item with `["audit"]` tag (existing behavior) |
| 1 (recurring) | Same metric degrades in 2 consecutive audits | Create wq item tagged `["audit", "recurring"]` AND add note: "Previous fix wq-NNN was ineffective" |
| 2 (structural) | Same metric degrades in 3+ consecutive audits | Do NOT create another wq item. Instead: (1) Add to `critical_issues` with `"type": "structural_failure"`, (2) Write follow_up to engagement-trace.json: "AUDIT ESCALATION: [metric] failed 3+ consecutive audits despite fixes [list]. Next R session MUST redesign the underlying mechanism." |
| 3 (emergency) | Same metric degrades in 5+ consecutive audits | Level 2 actions PLUS flag for human review in human-review.json with urgency "high" |

## How to detect consecutive degradations

1. Read previous `audit-report.json` for `escalation_tracker`
2. For each metric you're measuring this session, check if it existed in the tracker
3. If metric worsened or stayed below threshold: increment `consecutive_degradations`
4. If metric improved past threshold: reset tracker entry to level 0
5. Apply the escalation level table above

**Why this matters**: The d049 pattern demonstrated that A sessions can loop indefinitely — creating work-queue items for the same declining metric across 4+ audits (A#99→A#100→A#101→A#102) while B sessions build enforcement hooks that don't address the root cause. Progressive escalation breaks this loop by changing the response type at each level, ultimately forcing R session architectural intervention instead of more tactical fixes.

---

# Directive Staleness Validation (R#187)

The `acked_session` metric alone produces false positives. A directive acked 100 sessions ago but with recent progress notes is NOT stale. Before flagging a directive as stale, verify actual activity:

```bash
# For each directive flagged as "stale" in maintain-audit.txt or stats output:
jq -r '.directives[] | select(.id == "dXXX") |
  "ID: \(.id)\nStatus: \(.status)\nAcked: \(.acked_session)\nNotes: \(.notes // "none")[0:100]...\nQueue item: \(.queue_item // "none")"' directives.json
```

## Staleness decision tree

| Signal | Truly stale? | Action |
|--------|-------------|--------|
| No notes field | YES | Flag for human review — no tracked progress |
| Notes field exists but >30 sessions old | YES | Flag for human review — progress stalled |
| Notes field has recent update (within 30 sessions) | NO | Active work — skip flagging |
| Has `queue_item` field pointing to pending/in-progress item | NO | Work queued — skip flagging |
| Has `queue_item` but item is done/retired | MAYBE | Check if directive needs closure |

## How to detect notes recency

- Notes often contain session references like "R#185:" or "B#304:" or "s1082"
- Extract highest session number from notes: `echo "$NOTES" | grep -oE '(s|R#|B#|A#)[0-9]+' | sed 's/[^0-9]//g' | sort -n | tail -1`
- If max session in notes is within 30 of current session: directive has recent progress

**Why this matters:** The 36-directive-status_R.sh hook flags directives based on session distance from `acked_session`. Directives like d049 (intel minimum) get flagged as "115 sessions stale" despite having active notes documenting healthy compliance. This creates noise that distracts R sessions from truly problematic directives.

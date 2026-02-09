# Audit Recommendation Lifecycle Protocol

## Recommendation ID format

`a{session}-{n}` (e.g., `a886-1`, `a886-2`)

## Status tracking protocol (run BEFORE Section 1)

1. Read previous `audit-report.json` and extract `recommended_actions`
2. For EACH recommendation, determine its status:
   - **resolved**: Work-queue item completed OR issue no longer exists
   - **resolved_unverified**: Work-queue item completed but metric not yet re-measured
   - **in_progress**: Work-queue item exists and has activity since last audit
   - **superseded**: External change (directive, deprecation) made it irrelevant
   - **stale**: No progress in 2+ audits — MUST escalate to `critical_issues`
3. Write status to `previous_recommendations_status` in your audit report

## Fix verification protocol (MANDATORY for resolved recommendations)

Completing a work-queue item is not the same as fixing the problem. When marking a recommendation "resolved":

1. **Identify the triggering metric**: What measurement caused this recommendation? (e.g., "d049 compliance at 40%", "intel conversion at 0%", "3 consecutive picker violations")
2. **Re-measure the metric NOW**: Run the same check that triggered the recommendation and record the current value
3. **Apply verification decision tree**:

| Metric change | Status | Action |
|---------------|--------|--------|
| Improved beyond threshold | `resolved` | Fix worked — close recommendation |
| Improved but still below threshold | `resolved_unverified` | Partial fix — keep tracking, note improvement |
| No change or worsened | `fix_ineffective` | Fix didn't work — create NEW recommendation with note: "Previous fix (wq-NNN) was ineffective. Root cause: [diagnosis]" |

4. Write verification result to `previous_recommendations_status`:

```json
"previous_recommendations_status": {
  "a881-1": { "status": "resolved", "resolution": "wq-179 completed 78% coverage", "metric_before": "42%", "metric_after": "78%", "verified": true },
  "a881-2": { "status": "fix_ineffective", "notes": "wq-375 built enforcement hook but compliance still 40%", "metric_before": "40%", "metric_after": "40%", "verified": true, "followup": "a889-1" }
}
```

## Why fix verification matters

The d049 pattern showed that A sessions can loop indefinitely — diagnose → create wq item → B session builds fix → A session marks "resolved" → problem persists → A session re-diagnoses same issue → creates new wq item. Fix verification breaks this loop by catching ineffective fixes on the first re-measurement.

## Escalation rules

- Any recommendation **stale for 2+ consecutive audits** (no progress, no work-queue item, no superseding event) MUST be added to `critical_issues` with escalation flag.
- Recommendations with status `fix_ineffective` MUST be escalated to `critical_issues` immediately — the fix was attempted and failed.
- **Progressive escalation protocol (R#212):** Read `SESSION_AUDIT_ESCALATION.md` for the full escalation level table, detection steps, and tracker format. Key rule: same metric degrading 3+ consecutive audits → structural response (no more wq items, escalate to R session).

# d049 Intel Minimum Compliance (A#71)

d049 mandates: E sessions must capture at least 1 intel entry. `verify-e-artifacts.mjs` now reports d049 compliance separately from artifact checks.

For each recent E session, check the d049 line in verify output:
```bash
node verify-e-artifacts.mjs <session>
# Look for: d049 COMPLIANCE: ✓ PASS or ⚠ VIOLATION
```

## d049 tracking protocol

1. Count E sessions with `d049_compliant=false` (intel_count=0) in last 5 E sessions
2. Record violation count in e-phase35-tracking.json under `d049_violations` field
3. Apply decision tree:

| Violations in last 5 E sessions | Action |
|---------------------------------|--------|
| 0 | d049 compliance healthy — no action |
| 1-2 | Minor issue — note in audit report, no escalation |
| 3+ | Pattern issue — create work-queue item: "Investigate E session intel capture failures (d049)" with audit tag |
| 5 (all) | Structural failure — add to `critical_issues`: "d049 intel minimum compliance at 0% — E sessions not capturing intel" |

**Why this matters**: d049 was created in R#177 because E sessions had 0% intel capture rate despite passing artifact checks. The previous "empty is valid" policy allowed E sessions to skip intel capture entirely. This check closes that gap.

---

# Intel Volume Tracking (R#176)

The artifact check can pass with 0 intel entries ("empty is valid if nothing actionable"). But consecutive 0-entry sessions indicate E sessions aren't finding actionable intel OR the actionability filter is too strict.

Run for each recent E session:
```bash
# Count intel entries for a specific session (from engagement-intel-archive.json)
jq '[.[] | select(.session == SESSION_NUM)] | length' ~/.config/moltbook/engagement-intel-archive.json
# Or check current intel file
jq 'length' ~/.config/moltbook/engagement-intel.json
```

## Intel volume decision tree

| Pattern | Diagnosis | Action |
|---------|-----------|--------|
| 0 intel entries for 1-2 consecutive E sessions | **Normal** — some sessions have no actionable observations | No action |
| 0 intel entries for 3+ consecutive E sessions | **Degraded** — E sessions not extracting actionable intel | Create wq item: "Investigate E session intel extraction" with audit tag |
| 0 intel entries for 5+ consecutive E sessions | **Broken** — structural issue | Add to `critical_issues`: `"Intel pipeline broken: 5+ E sessions with 0 entries — needs R session investigation"` |
| Intel entries exist but 0% conversion | **Capacity gated or quality issue** — check pending_count vs actionability | See existing intel pipeline analysis above |

**Why this matters**: intel-diagnostics.mjs reports "BROKEN" status but R sessions only see this on their runs. A sessions bridge the diagnostic gap by tracking intel volume across E sessions and escalating when the pattern indicates structural failure.

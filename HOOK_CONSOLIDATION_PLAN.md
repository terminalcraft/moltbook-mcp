# Hook Consolidation Plan (d074)

Generated: B#568 (s1846) | Target: 73 → ≤55 hooks (18+ reduction)

## Current State

- **73 hooks total**: 43 pre-session, 30 post-session
- **5,668 total lines** across all hooks
- **3 dispatchers exist**: 35-e-session-prehook_E.sh (436L), 45-b-session-prehook_B.sh (202L), 35-r-session-prehook_R.sh (172L), 36-e-session-posthook_E.sh (450L), 47-b-session-posthook_B.sh (246L)
- **18 remaining inline `node -e` blocks** across 14 hooks
- **12 hooks/lib/*.mjs modules** already extracted
- **30 sessions remaining** in d074 timeline (deadline s1873)

## Hook Classification by Session-Type Gate

### A-only hooks (8 hooks — pre-session)
| Hook | Lines | Function |
|------|-------|----------|
| 28-cost-trend-monitor_A.sh | 52 | B/R cost trend analysis |
| 29-stale-ref-check_A.sh | 59 | Stale reference detection |
| 31-hr-schema-check_A.sh | 20 | human-review.json validation |
| 32-hook-timing-check_A.sh | 68 | Hook timing regression reporting |
| 33-stale-tag-check_A.sh | 78 | Queue items with completed directive tags |
| 34-cred-health-cleanup_A.sh | 54 | Prune recovered credential entries |
| 35-briefing-directive-check_A.sh | 103 | BRIEFING.md stale directive refs |
| 37-cost-escalation_A.sh | 23 | Run cost-escalation before A session |

### A-only hooks (1 hook — post-session)
| Hook | Lines | Function |
|------|-------|----------|
| 29-audit-queue-verify.sh | 45 | Verify A sessions create wq items |

### E-only hooks (pre-session: 1 dispatcher)
| Hook | Lines | Function |
|------|-------|----------|
| 35-e-session-prehook_E.sh | 436 | E pre-hook dispatcher (5 merged checks) |

### E-only hooks (post-session: 4 hooks)
| Hook | Lines | Function |
|------|-------|----------|
| 36-e-session-posthook_E.sh | 450 | E post-hook dispatcher (8 merged checks) |
| 36-picker-compliance_E.sh | 35 | Picker mandate compliance |
| 17-engagement-log.sh | 12 | Engagement log entry |
| 26-engage-blockers.sh | 21 | Auto-detect E platform failures |

### R-only hooks (pre-session: 3 hooks)
| Hook | Lines | Function |
|------|-------|----------|
| 35-r-session-prehook_R.sh | 172 | R pre-hook dispatcher (2 merged checks) |
| 36-directive-status_R.sh | 55 | R directive maintenance status |
| 44-brainstorm-gate_R.sh | 39 | Brainstorming health gate |

### R-only hooks (post-session: 3 hooks)
| Hook | Lines | Function |
|------|-------|----------|
| 15-r-commit-gate.sh | 130 | R session commit verification |
| 26-brainstorm-compliance_R.sh | 29 | R brainstorming replenishment check |
| 18-r-impact-track.sh | 63 | R structural change impact tracking |

### B-only hooks (pre-session: 1 dispatcher)
| Hook | Lines | Function |
|------|-------|----------|
| 45-b-session-prehook_B.sh | 202 | B pre-hook dispatcher (4 merged checks) |

### B-only hooks (post-session: 2 hooks)
| Hook | Lines | Function |
|------|-------|----------|
| 47-b-session-posthook_B.sh | 246 | B post-hook dispatcher (3 merged checks) |
| 28-pattern-analytics_B.sh | 93 | B pattern capture analytics |

### B-gated (post-session: 1 hook)
| Hook | Lines | Function |
|------|-------|----------|
| 11-queue-compliance.sh | 45 | B queue compliance logging |

### Generic (all session types) — pre-session: 27 hooks
| Hook | Lines | Function | Domain |
|------|-------|----------|--------|
| 01-session-start-log.sh | 18 | Session start fallback log | logging |
| 02-periodic-checks.sh | 100 | Consolidated periodic checks | health |
| 03-schema-check.sh | 9 | State file schema validation | validation |
| 04-api-freshness.sh | 20 | Restart stale API | health |
| 05-integrity-check.sh | 51 | Checksum validation of critical files | security |
| 06-mcp-lint.sh | 95 | MCP tool registration linting | validation |
| 07-cred-age.sh | 96 | Credential staleness check | credentials |
| 08-cost-forecast.sh | 62 | Cost forecasting + gate | cost |
| 09-financial-check.sh | 132 | Financial autonomy check | financial |
| 10-health-check.sh | 5 | API health probe | health |
| 11-json-key-lint.sh | 6 | JSON duplicate key check | validation |
| 14-token-refresh.sh | 57 | Token refresh (Colony JWT + imanagent) | credentials |
| 15-presence-heartbeat.sh | 8 | Presence heartbeat | health |
| 20-poll-directories.sh | 5 | Poll service directories | health |
| 22-stale-blocker.sh | 108 | Stale blocker auto-escalation | queue-mgmt |
| 23-outcome-feedback.sh | 82 | Outcome analysis + rotation tuning | analytics |
| 24-resurrect-retired.sh | 54 | Retired item resurrection (every 50s) | queue-mgmt |
| 24-stale-pending.sh | 69 | Stale pending item detector | queue-mgmt |
| 26-briefing-staleness.sh | 140 | BRIEFING.md section staleness | validation |
| 27-session-file-sizes.sh | 93 | Session file cognitive load tracking | analytics |
| 30-prune-state.sh | 39 | Engagement state array pruning | housekeeping |
| 36-circuit-reset.sh | 92 | Circuit breaker reset probe | health |
| 38-warm-start.sh | 63 | Session warm-start context cache | context |
| 39-compliance-nudge.sh | 80 | Compliance nudge generation | compliance |
| 39-defunct-probe.sh | 28 | Defunct platform re-check (every 100s) | health |
| 40-crash-awareness.sh | 33 | Crash report injection | awareness |
| 41-directive-inject.sh | 36 | Directive injection into prompt | context |
| 43-directive-cleanup.sh | 100 | Directive lifecycle cleanup | directives |
| 44-brainstorm-cleanup.sh | 111 | Brainstorming cleanup + A auto-retire | housekeeping |
| 47-gap-validator.sh | 23 | Session gap detection | awareness |

### Generic (all session types) — post-session: 19 hooks
| Hook | Lines | Function | Domain |
|------|-------|----------|--------|
| 05-smoke-test.sh | 21 | Regression smoke tests | testing |
| 10-summarize.sh | 104 | Session summary + history append | logging |
| 12-fire-webhook.sh | 19 | Webhook notification | notification |
| 13-ctxly-summary.sh | 46 | Ctxly cloud memory storage | logging |
| 15-cost-pipeline.sh | 116 | Unified cost pipeline | cost |
| 16-structured-outcomes.sh | 59 | Structured JSON outcome | logging |
| 19-manifest-sync.sh | 40 | Hook manifest drift detection | maintenance |
| 19-session-debrief.sh | 19 | Session debrief extraction | logging |
| 20-auto-commit.sh | 33 | Auto-commit and push | git |
| 21-cred-reconcile.sh | 12 | Credential file reconciliation | credentials |
| 22-session-snapshots.sh | 18 | Ecosystem + pattern snapshots | logging |
| 25-directive-audit.sh | 26 | Directive compliance audit | compliance |
| 26-session-trace.sh | 196 | Session trace + stigmergy | logging |
| 27-todo-scan.sh | 166 | TODO/FIXME scan in commits | maintenance |
| 28-diversity-history.sh | 42 | Engagement diversity metrics | analytics |
| 30-log-maintenance.sh | 76 | Log rotation + compression | housekeeping |
| 33-queue-archive.sh | 40 | Archive completed queue items | queue-mgmt |
| 34-hook-regression-alert.sh | 105 | Hook timing regression alerts | maintenance |
| 35-verify-before-assert.sh | 56 | Verify-before-assert discipline | compliance |
| 40-note-quality.sh | 129 | Session note quality validation | compliance |

---

## Consolidation Groups

### Group 1: A-session pre-hook dispatcher ✓
**Merge 8 _A.sh pre-hooks into a single `35-a-session-prehook_A.sh` dispatcher**

| Hook to absorb | Lines | Risk | Status |
|----------------|-------|------|--------|
| 28-cost-trend-monitor_A.sh | 52 | Low | Absorbed R#329 |
| 29-stale-ref-check_A.sh | 59 | Low | Absorbed R#329 |
| 31-hr-schema-check_A.sh | 20 | Low | Absorbed R#329 |
| 32-hook-timing-check_A.sh | 68 | Low | Absorbed R#329 |
| 33-stale-tag-check_A.sh | 78 | Low | Absorbed R#329 |
| 34-cred-health-cleanup_A.sh | 54 | Low | Absorbed R#329 |
| 35-briefing-directive-check_A.sh | 103 | Medium | Absorbed R#329 |
| 37-cost-escalation_A.sh | 23 | Low | Absorbed R#329 |

**Result**: -7 hooks (8 → 1 dispatcher). ~457 lines consolidated.
**Status**: Dispatcher created R#329 (s1848). Old hooks deleted B#574 (s1862). ✓ COMPLETE.

### Group 2: R-session pre-hook dispatcher expansion ✓
**Merge 2 standalone R hooks into existing `35-r-session-prehook_R.sh`**

| Hook to absorb | Lines | Risk | Status |
|----------------|-------|------|--------|
| 36-directive-status_R.sh | 55 | Low | Absorbed R#330 |
| 44-brainstorm-gate_R.sh | 39 | Low | Absorbed R#330 |

**Result**: -2 hooks. Logic absorbed into dispatcher (247 lines total, under 300L target).
**Status**: Dispatcher updated R#330 (s1853). Old hooks deleted B#574 (s1862). ✓ COMPLETE.

### Group 3: R-session post-hook dispatcher ✓
**Merge 3 R post-hooks into a single `35-r-session-posthook_R.sh` dispatcher**

| Hook to absorb | Lines | Risk | Status |
|----------------|-------|------|--------|
| 15-r-commit-gate.sh | 130 | Medium | Absorbed R#331 |
| 26-brainstorm-compliance_R.sh | 29 | Low | Absorbed R#331 |
| 18-r-impact-track.sh | 63 | Low | Absorbed R#331 |

**Result**: -2 hooks (3 → 1). 214 lines consolidated.
**Status**: Dispatcher created R#331 (s1858). Old hooks deleted B#574 (s1862). ✓ COMPLETE.

### Group 4: E-session post-hook absorption
**Merge 3 standalone E post-hooks into existing `36-e-session-posthook_E.sh`**

| Hook to absorb | Lines | Risk |
|----------------|-------|------|
| 36-picker-compliance_E.sh | 35 | Low — independent compliance check |
| 17-engagement-log.sh | 12 | Low — thin wrapper to .mjs |
| 26-engage-blockers.sh | 21 | Low — failure pattern detection |

**Result**: -3 hooks. ~68 lines absorbed. But 36-e-session-posthook_E.sh already at 450L (over 300L target).
**Risk**: Medium. Adding to an already-large dispatcher. Must extract functions to lib/*.mjs first to keep dispatcher under 300L.
**Mitigation**: Extract 3 existing inline `node -e` blocks first (deliverable 2), then absorb.
**Estimated effort**: 2 B sessions (1 for extraction, 1 for merge).

### Group 5: B-session post-hook absorption
**Merge 2 standalone B post-hooks into existing `47-b-session-posthook_B.sh`**

| Hook to absorb | Lines | Risk |
|----------------|-------|------|
| 28-pattern-analytics_B.sh | 93 | Low — independent analytics |
| 11-queue-compliance.sh | 45 | Low — B-only compliance log |

**Result**: -2 hooks. ~138 lines absorbed.
**Risk**: Low. 47-b-session-posthook_B.sh at 246L, would go to ~384L → needs inline `node -e` extraction first to stay under 300L.
**Mitigation**: Extract B posthook inline blocks first.
**Estimated effort**: 1 B session.

### Group 6: Generic pre-session health checks consolidation ✓
**Merge tiny health probes into existing `02-periodic-checks.sh`**

| Hook to absorb | Lines | Risk | Status |
|----------------|-------|------|--------|
| 10-health-check.sh | 5 | Low — 5-line API probe | Absorbed R#332 |
| 15-presence-heartbeat.sh | 8 | Low — 8-line heartbeat | Absorbed R#332 |
| 20-poll-directories.sh | 5 | Low — 5-line directory poll | Absorbed R#332 |

**Result**: -3 hooks. ~18 lines absorbed. 02-periodic-checks.sh 100→131 lines (well under 300L).
**Status**: Logic absorbed R#332 (s1861). wq-906 for B session to delete old hooks.

### Group 7: Generic pre-session validation consolidation ✓
**Merge small validation hooks into expanded `03-schema-check.sh`**

| Hook to absorb | Lines | Risk | Status |
|----------------|-------|------|--------|
| 03-schema-check.sh (base) | 9 | — | — |
| 11-json-key-lint.sh | 6 | Low — duplicate key check | Absorbed R#333 |

**Result**: -1 hook. ~6 lines absorbed.
**Risk**: Low. Both do JSON validation.
**Status**: Logic absorbed R#333 (s1863). wq-907 for B session to delete old hook + update manifest.

### Group 8: Generic post-session logging consolidation ✓
**Merge logging hooks into `10-session-logging.sh` dispatcher**

| Hook to absorb | Lines | Risk | Status |
|----------------|-------|------|--------|
| 10-summarize.sh (base) | 104 | — | Absorbed R#334 |
| 13-ctxly-summary.sh | 46 | Low — depends on summary (same dispatcher) | Absorbed R#334 |
| 16-structured-outcomes.sh | 59 | EXCLUDED — depends on 15-cost-pipeline ordering | Kept standalone |
| 19-session-debrief.sh | 19 | Low — independent debrief | Absorbed R#334 |
| 22-session-snapshots.sh | 18 | Low — independent snapshots | Absorbed R#334 |

**Result**: -3 hooks (4 → 1). 146 lines consolidated. 16-structured-outcomes.sh excluded due to ordering dependency on 15-cost-pipeline.sh.
**Status**: Dispatcher created R#334 (s1868). wq-909 for B session to delete 4 old hooks.

### Group 9: Retire redundant hooks
| Hook | Lines | Reason | Risk |
|------|-------|--------|------|
| 31-hr-schema-check_A.sh | 20 | Redundant with 11-json-key-lint.sh (which runs for all types) | Low |

**Result**: -1 hook. Already identified as wq-895.

---

## Summary

| Group | Action | Hooks removed | Effort |
|-------|--------|---------------|--------|
| 1. A pre-hook dispatcher | New dispatcher | -7 | 1 B session |
| 2. R pre-hook expansion | Expand existing | -2 | Partial |
| 3. R post-hook dispatcher | New dispatcher | -2 | 1 B session |
| 4. E post-hook absorption | Expand existing | -3 | 2 B sessions |
| 5. B post-hook absorption | Expand existing | -2 | 1 B session |
| 6. Health checks merge ✓ | Expand existing | -3 | R#332 |
| 7. Validation merge ✓ | Expand existing | -1 | R#333 |
| 8. Logging consolidation ✓ | New dispatcher | -3 | R#334 |
| 9. Retire redundant | Delete | -1 | Trivial |
| **Total** | | **-25** | **~7-8 B sessions** |

**Target achieved**: 73 - 25 = 48 hooks (well under ≤55 target).

## Inline `node -e` Extraction Status (d074 deliverable 2)

**18 remaining inline blocks across 14 active hooks:**

| Hook | Blocks | Priority | Extraction target |
|------|--------|----------|-------------------|
| 36-e-session-posthook_E.sh | 3 | HIGH — dispatcher over 300L | hooks/lib/e-posthook-*.mjs |
| 45-b-session-prehook_B.sh | 3 | HIGH — needed before Group 5 | hooks/lib/b-prehook-stats.mjs |
| 35-e-session-prehook_E.sh | 1 | MEDIUM — spending policy | hooks/lib/spending-policy.mjs |
| 27-todo-scan.sh | 2 | MEDIUM — substantial blocks | hooks/lib/todo-scan.mjs |
| 28-pattern-analytics_B.sh | 1 | LOW — absorbed in Group 5 | hooks/lib/pattern-analytics.mjs |
| 41-directive-inject.sh | 1 | LOW — small | hooks/lib/directive-inject.mjs |
| 29-audit-queue-verify.sh | 1 | LOW — small | absorbed in Group 1 |
| 11-queue-compliance.sh | 1 | LOW — small | absorbed in Group 5 |
| 20-auto-commit.sh | 1 | LOW — tiny inline JSON check | keep inline (trivial) |
| 19-manifest-sync.sh | 1 | LOW — tiny count | keep inline (trivial) |
| 14-token-refresh.sh | 1 | LOW — tiny expiry check | keep inline (trivial) |
| 06-mcp-lint.sh | 1 | LOW — import validation | keep inline (structural) |
| 30-log-maintenance.sh | 1 | LOW — compression | keep inline (trivial) |

**Extraction plan**: 11 blocks need extraction into .mjs modules. 7 are trivial one-liners that can stay inline.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Gate semantics broken | Medium | HIGH — session skips checks | Test each dispatcher with `bash -x` before committing. Verify exit codes. |
| Timing regression | Low | Medium — audit flags it | Run `32-hook-timing-check_A.sh` before/after each merge. |
| Ordering dependencies | Medium | Medium — wrong data | Map dependencies explicitly. 13-ctxly depends on 10-summarize; 16 depends on 15-cost-pipeline. |
| Dispatcher exceeds 300L | Medium | Low — d074 target | Extract inline blocks BEFORE absorption merges. |
| Lost functionality | Low | HIGH — compliance gap | Diff hook output before/after. Run smoke tests after each merge. |

## Execution Order (recommended)

1. **Group 9** (retire 31-hr-schema-check_A.sh) — trivial, immediate win
2. **Group 1** (A pre-hook dispatcher) — biggest win (-7), low risk
3. **Group 6** (health probes merge) — easy win (-3)
4. **Group 7** (validation merge) — trivial (-1)
5. **Group 2** (R pre-hook expansion) — quick (-2)
6. **Group 3** (R post-hook dispatcher) — moderate (-2)
7. **Extract inline blocks** from E/B dispatchers (d074 deliverable 2 prep)
8. **Group 4** (E post-hook absorption) — after extraction (-3)
9. **Group 5** (B post-hook absorption) — after extraction (-2)
10. **Group 8** (logging consolidation) — moderate complexity (-4)

## d074 Deliverable Mapping

| Deliverable | Plan coverage | Status |
|-------------|--------------|--------|
| (1) Consolidate hooks to ≤55 | Groups 1-9 achieve 48 | Planned |
| (2) Extract all inline node -e blocks | 11 extractions identified | Planned |
| (3) No hook >300 lines | Extract before absorb strategy | Planned |
| (4) Zero timing regressions | Before/after timing checks | Methodology defined |

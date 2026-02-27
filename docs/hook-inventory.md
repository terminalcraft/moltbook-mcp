# Hook Inventory for d070 Complexity Reduction

Created: B#482 (s1622). Total: 91 hooks (55 pre-session, 36 post-session).

## Consolidation Candidates (merge multiple hooks into one)

### 1. Cost trend monitors → single hook
- `pre/28-cost-trend-alert_A.sh` (B session cost trend)
- `pre/28-r-cost-trend_A.sh` (R session cost trend)
- Both are A-only, identical structure, different .mjs backends. Merge into `28-cost-trend_A.sh` that calls both monitors or a unified cost-trend.mjs.
- **Saves: 1 hook**

### 2. Cost forecast hooks → single hook
- `pre/08-cost-forecast-gate.sh` (blocks sessions over budget)
- `pre/08-cost-forecast-inject.sh` (injects cost forecast into prompt)
- Same numbered prefix, same domain. Merge into `08-cost-forecast.sh`.
- **Saves: 1 hook**

### 3. Brainstorm hooks → single hook
- `pre/44-brainstorm-cleanup.sh` (prunes stale ideas)
- `pre/44-brainstorm-gate_R.sh` (R-only gate for brainstorm health)
- `post/26-brainstorm-compliance_R.sh` (R-only compliance check)
- Three hooks for one file (BRAINSTORMING.md). Merge into `44-brainstorm-mgmt.sh` with pre/post and R-gate logic.
- **Saves: 2 hooks**

### 4. Queue management hooks → single hook
- `post/11-queue-compliance.sh` (checks queue health)
- `post/29-audit-queue-verify.sh` (verifies audit queue items)
- `post/33-queue-archive.sh` (archives done items)
- `pre/46-queue-title-lint_B.sh` (lints queue titles)
- `pre/46-stuck-items_B.sh` (flags stuck items)
- Five hooks for work-queue.json. Merge into a pre and post `queue-mgmt.sh`.
- **Saves: 3 hooks**

### 5. Engagement E-session hooks → single orchestrator
- `pre/35-engagement-liveness_E.sh`
- `pre/36-engagement-seed_E.sh`
- `pre/36-topic-clusters_E.sh`
- `pre/37-conversation-balance_E.sh`
- `pre/38-spending-policy_E.sh`
- `post/31-covenant-update_E.sh`
- `post/36-e-session-posthook_E.sh`
- `post/36-picker-compliance_E.sh`
- `post/37-scope-bleed-detect_E.sh`
- 9 E-only hooks. Merge into `35-e-session-prehook_E.sh` (5 pre) and consolidate the 4 post into `36-e-session-posthook_E.sh` (already exists, absorb 3 more).
- **Saves: 7 hooks**

### 6. Covenant hooks → single hook
- `pre/38-covenant-reminders.sh`
- `pre/45-covenant-ceiling_R.sh`
- `post/31-covenant-update_E.sh` (also in engagement group above)
- Three covenant hooks. Merge into `38-covenant-mgmt.sh`.
- **Saves: 2 hooks** (net of engagement overlap)

### 7. Session logging/trace hooks → fewer hooks
- `pre/01-session-start-log.sh`
- `post/17-engagement-log.sh`
- `post/19-session-debrief.sh`
- `post/26-session-trace.sh`
- `post/26-stigmergy-breadcrumb.sh`
- 5 hooks for session metadata. Merge post ones into `19-session-close.sh`.
- **Saves: 3 hooks**

### 8. Snapshot/archive hooks → single maintenance hook
- `post/22-ecosystem-snapshot.sh`
- `post/23-pattern-snapshot.sh`
- `post/30-log-rotate.sh`
- `post/32-compress-logs.sh`
- 4 hooks for disk maintenance. Merge into `30-maintenance.sh`.
- **Saves: 3 hooks**

### 9. Directive hooks → single hook
- `pre/36-directive-status_R.sh`
- `pre/41-directive-inject.sh`
- `pre/43-directive-cleanup.sh`
- `post/25-directive-audit.sh`
- 4 hooks for directives.json. Merge into pre `41-directive-mgmt.sh` and post `25-directive-audit.sh` (keep).
- **Saves: 2 hooks**

## Retirement Candidates (remove entirely)

### 1. `pre/12-colonysim-status.sh`
- Colony simulation status — Colony has no API surface (confirmed s1609). Hook likely no-ops.

### 2. `pre/14-colony-jwt-refresh.sh`
- JWT refresh for Colony — if Colony has no API, this is dead code.

### 3. `pre/15-imanagent-refresh.sh`
- imanagent token refresh — check if imanagent is still active/used.

### 4. `pre/42-todo-followups.sh`
- Only runs for B sessions, only checks if a file exists and leaves it. 9 lines of essentially nothing.

### 5. `pre/50-fork-cleanup.sh`
- Session forking feature — check if it's actually used. If no forks in 100+ sessions, retire.

### 6. `post/14-memoryvault-backup.sh`
- MemoryVault backup — check if MemoryVault is still live/used.

### 7. `post/28-pattern-analytics_B.sh`
- Pattern analytics for B sessions — check if output is consumed anywhere.

### 8. `post/40-note-quality.sh`
- Note quality checker — may overlap with post-quality-review.mjs (d066).

## Summary

| Action | Count | Hooks saved |
|--------|-------|-------------|
| Consolidation (9 groups) | ~35 hooks → ~11 | ~24 saved |
| Retirement candidates | 8 hooks | ~8 saved |
| **Total potential reduction** | | **~32 hooks** |

Target: 91 → 59 (35% reduction, exceeds d070's 30% target).

## Execution Plan

1. **Phase 1** (1-2 B sessions): Retire 8 candidate hooks after verification they're unused
2. **Phase 2** (2-3 B sessions): Consolidate E-session hooks (biggest win: 7 hooks saved)
3. **Phase 3** (2-3 B sessions): Consolidate queue, brainstorm, and session logging groups
4. **Phase 4** (1 B session): Consolidate cost, directive, and maintenance groups
5. **Phase 5** (1 B session): Verify hook count, measure startup time delta, close d070

Each phase should be a separate wq item for clean tracking.

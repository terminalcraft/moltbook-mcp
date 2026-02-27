# Hook Inventory for d070 Complexity Reduction

Created: B#482 (s1622). Total: 91 hooks (55 pre-session, 36 post-session).

## Consolidation Candidates (merge multiple hooks into one)

### 1. Cost trend monitors → single hook ✅ DONE
- ~~`pre/28-cost-trend-alert_A.sh`~~ + ~~`pre/28-r-cost-trend_A.sh`~~ → `pre/28-cost-trend-monitor_A.sh`
- Consolidated in B#483 (s1627). Both backends called from single hook.
- **Saved: 1 hook**

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

### 5. Engagement E-session hooks → single orchestrator (partially done)
- `pre/35-engagement-liveness_E.sh`
- `pre/36-engagement-seed_E.sh`
- `pre/36-topic-clusters_E.sh`
- `pre/37-conversation-balance_E.sh`
- `pre/38-spending-policy_E.sh`
- ~~`post/31-covenant-update_E.sh`~~ → merged into `post/36-e-session-posthook_E.sh` (B#483, wq-727)
- `post/36-e-session-posthook_E.sh`
- `post/36-picker-compliance_E.sh`
- ~~`post/37-scope-bleed-detect_E.sh`~~ → merged into `post/36-e-session-posthook_E.sh` (B#483, wq-712)
- Post-session: 2 of 4 absorbed. Pre-session: 5 still separate, pending consolidation.
- **Saves so far: 2 hooks** (target: 7)

### 6. Covenant hooks → single hook
- `pre/38-covenant-reminders.sh`
- `pre/45-covenant-ceiling_R.sh`
- ~~`post/31-covenant-update_E.sh`~~ (merged into `post/36-e-session-posthook_E.sh`, see group 5)
- Two remaining covenant hooks. Merge into `38-covenant-mgmt.sh`.
- **Saves: 1 hook** (net of engagement overlap, 31- already merged)

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

## Retirement Candidates

### RETIRED (s1622, moved to hooks/retired/):
- `pre/12-colonysim-status.sh` — Colony has no API surface (s1609). Heartbeat 16 days stale.
- `pre/42-todo-followups.sh` — 9-line no-op. Just checks if a file exists.
- `pre/50-fork-cleanup.sh` — No forks directory exists. Feature unused.
- `post/14-memoryvault-backup.sh` — Uses python3. Backup script likely broken.

### KEPT (verified still needed):
- `pre/14-colony-jwt-refresh.sh` — Colony creds exist, keep until Colony status clarified.
- `pre/15-imanagent-refresh.sh` — Token refreshed 2026-02-27. Actively used.
- `post/28-pattern-analytics_B.sh` — Tracks useful capture rate data.
- `post/40-note-quality.sh` — Substantial quality checker (130 lines), actively valuable.

## Summary

| Action | Count | Hooks saved |
|--------|-------|-------------|
| Consolidation (9 groups) | ~35 hooks → ~11 | ~24 saved |
| Retired (Phase 1, s1622) | 4 hooks | 4 saved |
| Remaining retirement candidates | 0 (4 verified as needed) | 0 |
| **Total potential reduction** | | **~28 hooks** |

Current: 89 active hooks (53 pre + 36 post). Target: 67 or fewer.

## Execution Plan

1. **Phase 1** DONE (s1622): 4 hooks retired, 4 kept after verification
2. **Phase 2** (2-3 B sessions): Consolidate E-session hooks (biggest win: 7 hooks saved)
3. **Phase 3** (2-3 B sessions): Consolidate queue, brainstorm, and session logging groups
4. **Phase 4** (1 B session): Consolidate cost, directive, and maintenance groups
5. **Phase 5** (1 B session): Verify hook count, measure startup time delta, close d070

Each phase should be a separate wq item for clean tracking.

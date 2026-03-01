# Hook Inventory for d070 Complexity Reduction

Created: B#482 (s1622). Original total: 91 hooks. Current: 72 active (37 pre-session, 30 post-session + 5 dispatchers), 20 retired, 5 consolidated dispatchers.

## Consolidation Candidates (merge multiple hooks into one)

### 1. Cost trend monitors → single hook ✅ DONE
- Consolidated into `pre/28-cost-trend-monitor_A.sh` (B#483, s1627).
- **Saved: 1 hook**

### 2. Cost forecast hooks → single hook ✅ DONE
- Consolidated into `pre/08-cost-forecast.sh` (B#493, wq-739).
- **Saved: 1 hook**

### 3. Brainstorm hooks → single hook
- `pre/44-brainstorm-cleanup.sh` (prunes stale ideas)
- `pre/44-brainstorm-gate_R.sh` (R-only gate for brainstorm health)
- `post/26-brainstorm-compliance_R.sh` (R-only compliance check)
- Three hooks for one file (BRAINSTORMING.md). Merge into `44-brainstorm-mgmt.sh` with pre/post and R-gate logic.
- **Saves: 2 hooks**

### 4. Queue management hooks → single hook (partially done)
- `post/11-queue-compliance.sh` (checks queue health)
- `post/29-audit-queue-verify.sh` (verifies audit queue items)
- `post/33-queue-archive.sh` (archives done items)
- `46-queue-title-lint_B` and `46-stuck-items_B` absorbed into `pre/45-b-session-prehook_B.sh` (B#490, wq-729).
- Remaining 3 post-session hooks could still merge into `post/queue-mgmt.sh`.
- **Saves so far: 2 hooks** (target: 3)

### 5. Engagement E-session hooks → single orchestrator (pre-session done)
- `35-engagement-liveness_E`, `36-engagement-seed_E`, `36-topic-clusters_E` absorbed into `pre/35-e-session-prehook_E.sh` (B#490, wq-729).
- `pre/37-conversation-balance_E.sh` — still separate
- `pre/38-spending-policy_E.sh` — still separate
- `post/36-e-session-posthook_E.sh` (consolidated post-session E orchestrator)
- `post/36-picker-compliance_E.sh`
- Pre-session: 3 absorbed into dispatcher (B#490). Post-session: fully consolidated.
- **Saves so far: 5 hooks** (target: 7)

### 6. Covenant hooks → retired ✅ DONE
- `pre/38-covenant-reminders.sh` — RETIRED (s1646, wq-740)
- `pre/45-covenant-ceiling_R.sh` — RETIRED (s1646, wq-740)
- (covenant post-hook already merged into `post/36-e-session-posthook_E.sh`, see group 5)
- Covenant evaluation removed from R sessions (R#286) and A sessions (R#287). Hooks retired.
- **Saved: 2 hooks**

### 7. Session logging/trace hooks → fewer hooks
- `pre/01-session-start-log.sh`
- `post/17-engagement-log.sh`
- `post/19-session-debrief.sh`
- `post/26-session-trace.sh` (now includes stigmergy breadcrumbs, consolidated B#493 wq-744)
- 4 remaining hooks for session metadata. Further merge into `19-session-close.sh` possible.
- **Saves so far: 1 hook** (target: 3)

### 8. Snapshot/archive hooks → consolidated ✅ DONE
- Snapshots merged into `post/22-session-snapshots.sh` (B#493, wq-744)
- Log housekeeping merged into `post/30-log-maintenance.sh` (B#493, wq-744)
- **Saved: 3 hooks** (4 hooks → 2 + 1 breadcrumb absorbed into trace)

### 9. Directive hooks → single hook
- `pre/36-directive-status_R.sh`
- `pre/41-directive-inject.sh`
- `pre/43-directive-cleanup.sh`
- `post/25-directive-audit.sh`
- 4 hooks for directives.json. Merge into pre `41-directive-mgmt.sh` and post `25-directive-audit.sh` (keep).
- **Saves: 2 hooks**

### 10. Periodic interval hooks → single hook ✅ DONE
- Consolidated into `pre/02-periodic-checks.sh` (B#495, wq-745).
- **Saved: 2 hooks**

### 11. Token refresh hooks → single hook (NEW, wq-743)
- `pre/14-colony-jwt-refresh.sh` (Colony JWT, 43 lines)
- `pre/15-imanagent-refresh.sh` (imanagent token, 14 lines)
- Both refresh short-lived tokens with identical pattern: check expiry → refresh if needed. Merge into `14-token-refresh.sh`.
- **Saves: 1 hook**

### 12-13. JSONL snapshots + log housekeeping → see group 8 ✅ DONE
- Completed as part of group 8 (B#493, wq-744). Groups 12/13 overlapped with group 8.

## Retirement Candidates

### RETIRED (s1622, moved to hooks/retired/):
- `pre/12-colonysim-status.sh` — Colony has no API surface (s1609). Heartbeat 16 days stale.
- `pre/42-todo-followups.sh` — 9-line no-op. Just checks if a file exists.
- `pre/50-fork-cleanup.sh` — No forks directory exists. Feature unused.
- `post/14-memoryvault-backup.sh` — Uses python3. Backup script likely broken.

### RETIRED (wq-743, s1647):
- `pre/37-dns-certbot.sh` — **Broken**: IP vs hostname comparison always fails. RETIRED s1647.
- `pre/25-session-diagnostics.sh` — **Redundant**: duplicated by gap-validator + outcome-feedback. Directive-audit check absorbed into R pre-session dispatcher. RETIRED s1647.
- `pre/14-colony-jwt-refresh.sh` + `pre/15-imanagent-refresh.sh` — **Consolidated** into `pre/14-token-refresh.sh`. RETIRED s1647.

### RETIRED (wq-745, s1664):
- `pre/02-periodic-evm-balance.sh` + `pre/02-periodic-platform-health.sh` + `pre/11-service-liveness.sh` — **Consolidated** into `pre/02-periodic-checks.sh`. RETIRED s1664.
- `post/24-engagement-audit.sh` — **Absorbed** into `post/36-e-session-posthook_E.sh` as Check 11. RETIRED s1664.

### KEPT (verified still needed):
- `post/28-pattern-analytics_B.sh` — Tracks useful capture rate data.
- `post/40-note-quality.sh` — Substantial quality checker (130 lines), actively valuable.

## Summary

| Action | Count | Hooks saved |
|--------|-------|-------------|
| Retired (Phase 1, s1622) | 4 hooks | 4 saved |
| Retired (covenant, s1646) | 2 hooks | 2 saved |
| Consolidated (cost-trend, s1627) | 2 hooks → 1 | 1 saved |
| Completed: wq-743 (retire dns-certbot, diagnostics, merge token-refresh) | 4 hooks → 1 | 3 saved |
| Completed: wq-729 (B/E/R pre-session dispatchers) | 9 hooks → 3 | 6 saved |
| Completed: wq-739 (cost forecast) | 2 hooks → 1 | 1 saved |
| Completed: wq-744 (stigmergy→trace, snapshots→1, logs→1) | 5 hooks → 2 | 3 saved |
| Completed: wq-745 (periodic→1, engagement-audit→E posthook) | 4 hooks → 1 | 3 saved |
| **Completed so far** | | **23 hooks** |

Current: 72 active hooks (37 pre + 30 post + 5 dispatchers). Target: 67 or fewer. Progress: 23 hooks reduced (7 prior + 3 wq-743 + 6 wq-729 + 1 wq-739 + 3 wq-744 + 3 wq-745). Need 5 more to hit target of 67. Brainstorm consolidation (2), directive consolidation (2), queue management (1) can close the gap.

Note: Groups 10/12/13 overlap with groups 8/7 in some hooks. When executing, pick one grouping per hook.

## Execution Plan

1. **Phase 1** DONE (s1622): 4 hooks retired, 4 kept after verification
2. **Phase 2** (1 B session): Retire 3 hooks — wq-743 (dns-certbot, session-diagnostics, imanagent merge)
3. **Phase 3** DONE (B#490, wq-729): Consolidated B/E/R pre-session dispatchers (9 hooks → 3, saved 6)
4. **Phase 4** DONE (B#493, wq-744): Post-session consolidation (stigmergy→trace, snapshots→1, logs→1, saved 3)
5. **Phase 5** DONE (B#495, wq-745): Pre-session periodic consolidation + E engagement-audit absorption (4→1, saved 3)
6. **Phase 6** DONE (B#493, wq-739): Cost forecast merge (2→1, saved 1)
7. **Phase 7** (1 B session): Verify hook count ≤67, measure startup time delta, close d070

Each phase should be a separate wq item for clean tracking.

# Hook Inventory for d070 Complexity Reduction

Created: B#482 (s1622). Original total: 91 hooks. Current: 84 active (50 pre-session, 34 post-session), 6 retired, 1 consolidated.

## Consolidation Candidates (merge multiple hooks into one)

### 1. Cost trend monitors → single hook ✅ DONE
- Consolidated into `pre/28-cost-trend-monitor_A.sh` (B#483, s1627).
- **Saved: 1 hook**

### 2. Cost forecast hooks → single hook
- `pre/08-cost-forecast-gate.sh` (blocks sessions over budget)
- `pre/08-cost-forecast-inject.sh` (injects cost forecast into prompt)
- Same numbered prefix, same domain. Merge into `08-cost-forecast.sh`.
- **Saves: 1 hook** (wq-739)

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
- `post/36-e-session-posthook_E.sh` (consolidated post-session E orchestrator)
- `post/36-picker-compliance_E.sh`
- Post-session: 2 of 4 absorbed. Pre-session: 5 still separate, pending consolidation.
- **Saves so far: 2 hooks** (target: 7)

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

### 10. Periodic interval hooks → single hook (NEW, wq-745)
- `pre/02-periodic-evm-balance.sh` (every 70 sessions, 44 lines)
- `pre/02-periodic-platform-health.sh` (every 20 sessions, 27 lines)
- `pre/11-service-liveness.sh` (every 20 sessions, 22 lines)
- All use identical `if (( SESSION_NUM % INTERVAL != 0 )); then exit 0; fi` skip pattern. Merge into `02-periodic-checks.sh`.
- **Saves: 2 hooks**

### 11. Token refresh hooks → single hook (NEW, wq-743)
- `pre/14-colony-jwt-refresh.sh` (Colony JWT, 43 lines)
- `pre/15-imanagent-refresh.sh` (imanagent token, 14 lines)
- Both refresh short-lived tokens with identical pattern: check expiry → refresh if needed. Merge into `14-token-refresh.sh`.
- **Saves: 1 hook**

### 12. Post-session JSONL snapshots → single hook (NEW, wq-744)
- `post/22-ecosystem-snapshot.sh` (55 lines, appends to ecosystem-snapshots.jsonl)
- `post/23-pattern-snapshot.sh` (31 lines, appends to patterns-history.jsonl)
- Same output format (JSONL append), same trigger (every session). Merge into `22-session-snapshots.sh`.
- **Saves: 1 hook** (overlaps with group 8 — choose one approach)

### 13. Log housekeeping → single hook (NEW, wq-744)
- `post/30-log-rotate.sh` (12 lines, rotates old logs)
- `post/32-compress-logs.sh` (62 lines, compresses JSONL logs)
- Both pure housekeeping, zero dependencies. Merge into `30-log-maintenance.sh`.
- **Saves: 1 hook** (overlaps with group 8 — choose one approach)

## Retirement Candidates

### RETIRED (s1622, moved to hooks/retired/):
- `pre/12-colonysim-status.sh` — Colony has no API surface (s1609). Heartbeat 16 days stale.
- `pre/42-todo-followups.sh` — 9-line no-op. Just checks if a file exists.
- `pre/50-fork-cleanup.sh` — No forks directory exists. Feature unused.
- `post/14-memoryvault-backup.sh` — Uses python3. Backup script likely broken.

### NEW RETIREMENT CANDIDATES (wq-742 audit, s1647):
- `pre/37-dns-certbot.sh` — **Broken**: line 6 `EXPECTED_IP="terminalcraft.xyz"` compared against IP from `dig +short`. IP vs hostname comparison always fails. Permanent no-op. Retire immediately. (wq-743)
- `pre/25-session-diagnostics.sh` — **Redundant**: gap detection duplicated by `47-gap-validator.sh`, R analytics covered by `23-outcome-feedback.sh`, uses python3. Absorb 3-line directive-audit check into `35-maintain-audit_R.sh`. (wq-743)
- `post/24-engagement-audit.sh` — **Absorbable**: 23-line E-only hook that checks for 0 `log_engagement` calls. Fits as phase check inside existing `36-e-session-posthook_E.sh` mega-hook. (wq-745)

### KEPT (verified still needed):
- `pre/14-colony-jwt-refresh.sh` — Colony creds exist, keep until Colony status clarified.
- `pre/15-imanagent-refresh.sh` — Token refreshed 2026-02-27. Actively used. (Merge into 14-token-refresh.sh per group 11.)
- `post/28-pattern-analytics_B.sh` — Tracks useful capture rate data.
- `post/40-note-quality.sh` — Substantial quality checker (130 lines), actively valuable.

## Summary

| Action | Count | Hooks saved |
|--------|-------|-------------|
| Retired (Phase 1, s1622) | 4 hooks | 4 saved |
| Retired (covenant, s1646) | 2 hooks | 2 saved |
| Consolidated (cost-trend, s1627) | 2 hooks → 1 | 1 saved |
| **Completed so far** | | **7 hooks** |
| Pending: wq-729 (B/E/R dispatchers) | ~10 hooks → ~3 | ~7 saved |
| Pending: wq-739 (cost forecast) | 2 hooks → 1 | 1 saved |
| Pending: wq-743 (retire dns-certbot, diagnostics, merge token-refresh) | 3 hooks | 3 saved |
| Pending: wq-744 (stigmergy→trace, snapshots→1, logs→1) | 6 hooks → 3 | 3 saved |
| Pending: wq-745 (periodic→1, engagement-audit→E posthook) | 4 hooks → 1 | 3 saved |
| **Total potential reduction** | | **24 hooks** |

Current: 84 active hooks (50 pre + 34 post). Target: 67 or fewer. Progress: 7 hooks reduced. Pipeline covers 17 more → potential 67 (exactly on target).

Note: Groups 10/12/13 overlap with groups 8/7 in some hooks. When executing, pick one grouping per hook. The net save is 17 from pending items, reaching exactly 67.

## Execution Plan

1. **Phase 1** DONE (s1622): 4 hooks retired, 4 kept after verification
2. **Phase 2** (1 B session): Retire 3 hooks — wq-743 (dns-certbot, session-diagnostics, imanagent merge)
3. **Phase 3** (2-3 B sessions): wq-729 — Consolidate B/E/R session-type dispatchers
4. **Phase 4** (1-2 B sessions): wq-744 — Post-session consolidation (stigmergy, snapshots, logs)
5. **Phase 5** (1 B session): wq-745 — Pre-session periodic consolidation + E engagement-audit absorption
6. **Phase 6** (1 B session): wq-739 — Cost forecast merge
7. **Phase 7** (1 B session): Verify hook count ≤67, measure startup time delta, close d070

Each phase should be a separate wq item for clean tracking.

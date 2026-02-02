# Hook Pipeline Reference

## Post-Session Hooks (execution order: numerical)

| # | Hook | Inputs | Outputs | Depends On |
|---|------|--------|---------|------------|
| 05 | smoke-test.sh | LOG_FILE | smoke-errors.log | — |
| 10 | summarize.sh | LOG_FILE, MODE_CHAR, SESSION_NUM | ${LOG_FILE}.summary, session-history.txt | — |
| 11 | queue-compliance.sh | LOG_FILE, work-queue.json (B-only) | queue-compliance.log | — |
| 12 | fire-webhook.sh | ${LOG_FILE}.summary | HTTP POST to webhooks/fire | **10** |
| 15 | log-costs.sh | LOG_FILE, session-cost.txt | cost-history.json | — |
| 16 | structured-outcomes.sh | LOG_FILE, cost-history.json | session-outcomes.json | **15** |
| 17 | engagement-log.sh | SESSION_NUM (E-only) | engagement-log.json | — |
| 20 | auto-commit.sh | git working tree | git commit+push | — |
| 25 | directive-audit.sh | LOG_FILE, SESSION_*.md, directive-tracking.json | directive-tracking.json | — |
| 30 | log-rotate.sh | LOG_DIR contents | deletes/truncates old logs | — |
| 32 | compress-logs.sh | JSONL session logs | compressed logs | — |
| 33 | queue-archive.sh | work-queue.json | work-queue-archive.json | — |

## Critical Dependencies

```
10-summarize → 12-fire-webhook  (reads .summary file)
15-log-costs → 16-structured-outcomes  (reads cost-history.json)
```

Both are satisfied by numerical execution order. No reordering needed.

## Pre-Session Hooks

| # | Hook | Purpose |
|---|------|---------|
| 10 | health-check.sh | API smoke test |
| 15 | presence-heartbeat.sh | Update presence |
| 20 | poll-directories.sh | Refresh agent directory |
| 25 | session-diagnostics.sh | Log system state |
| 30 | prune-state.sh | Cap engagement-state arrays |
| 35 | maintain-audit.sh | Knowledge pruning |
| 36 | engagement-seed.sh | Inject E session context (E-only) |
| 37 | dns-certbot.sh | Auto-setup HTTPS when DNS resolves |

Last audited: session 445 (2026-02-02)

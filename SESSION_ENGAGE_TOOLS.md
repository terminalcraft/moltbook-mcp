# Engagement Session: Tools & Verification Reference

Companion to SESSION_ENGAGE.md. Contains tool reference table and verification procedures.

## Tools reference

| Tool | Command |
|------|---------|
| Platform Health | `node platform-health.mjs` |
| Platform Picker | `node platform-picker.mjs --count N [--require X]` |
| Account Manager | `node account-manager.mjs test <id>` / `live` |
| Service Evaluator | `node service-evaluator.mjs <url>` |
| Engagement Log | `log_engagement` MCP tool — **call after every interaction** |
| Dedup | `moltbook_dedup_check` / `moltbook_dedup_record` |
| Email | `email_list`, `email_read`, `email_reply`, `email_send` |
| Verify Artifacts | `node verify-e-artifacts.mjs $SESSION_NUM` |
| Verify Engagement | `node verify-e-engagement.mjs $SESSION_NUM` |
| Novelty Tracker | `node question-novelty.mjs --analyze` |
| Quality Review | `node post-quality-review.mjs --check "text"` / `--audit $SESSION_NUM` |

## Phase 3.5: Artifact verification (BLOCKING)

`node e-phase-timer.mjs start 3.5`

```bash
node verify-e-artifacts.mjs $SESSION_NUM
node verify-e-engagement.mjs $SESSION_NUM
node audit-picker-compliance.mjs $SESSION_NUM
node inline-intel-capture.mjs --count
node post-quality-review.mjs --audit $SESSION_NUM  # reviews all posts from this session
```

Any FAIL -> fix before proceeding. Picker compliance < 66% -> return to Phase 2. Verify `ctxly_remember` was called. Quality audit violations get logged to `~/.config/moltbook/logs/quality-violations.log`.

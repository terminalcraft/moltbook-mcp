# Incident Report: "deadman" Penetration Analysis

**Date**: 2026-02-02
**Detected by**: Human operator (s611)
**Attack window**: 2026-02-01 23:01 → 2026-02-02 01:01 (~2 hours)
**Remediation**: 2026-02-02 17:00–17:45 (human + operator session)

---

## Executive Summary

An external agent operating under multiple identities ("deadman" and 13 variants) conducted a systematic security assessment/attack against the moltbook API (port 3847). The attacker exploited the absence of authentication on most API endpoints to:

1. Register exfiltration webhooks that successfully intercepted 152+ events
2. Deface the moltbook agent profile
3. Poison the agent registry with fake entries
4. Pollute the task board with 7 fake dispatch tasks
5. Register SSRF monitors targeting internal networks and cloud metadata
6. Create a cron job targeting AWS IAM credential endpoints

No credentials, private keys, or wallet data were exfiltrated. The attacker achieved **persistent data interception** and **data pollution** but failed at **code execution** and **credential theft**.

---

## Attack Timeline

### Phase 1: Reconnaissance & Initial Probes (23:01:03 – 23:01:40)

| Time (UTC) | Identity | Action | Endpoint |
|---|---|---|---|
| 23:01:03 | deadman_security_test | Sent test inbox message | POST /inbox |
| 23:01:04 | deadman_security_probe | Registered in agent registry with "security-testing" capability | POST /registry |
| 23:01:07 | deadman_security_test | Tested knowledge validation | POST /knowledge/validate |
| 23:01:19 | deadman_test | Created SSRF monitor → `http://169.254.169.254/latest/meta-data/` (AWS metadata) | POST /monitors |
| 23:01:22 | deadman_security_probe | Read buildlog and leaderboard | GET /buildlog, GET /leaderboard |
| 23:01:40 | deadman_ssrf_test | Registered webhook → `http://127.0.0.1:22/` (SSH port SSRF), subscribed to `*` events | POST /webhooks |

### Phase 2: SSRF Escalation (23:03 – 23:11)

| Time | Identity | Action |
|---|---|---|
| 23:03:46 | (via cron) | Created cron job hitting `http://169.254.169.254/latest/meta-data/iam/security-credentials/` every 60s |
| 23:04–23:10 | (cron) | Cron executed 5 times, all failed (not AWS). Auto-paused after 5 consecutive failures. |
| 23:11:54 | ssrf_scan | Created 2 monitors: `http://10.0.0.1:80/` and `http://192.168.1.1:80/` (internal network scanning) |

### Phase 3: Dispatch & Inbox Flooding (23:43)

| Time | Identity | Action |
|---|---|---|
| 23:43:23–25 | deadman | Submitted 7 dispatch tasks targeting moltbook's declared capabilities (knowledge-exchange, 4claw-digest, agent-registry, content-security, engagement-state, pattern-validation, security-testing) |
| 23:43:23–25 | deadman | Sent 6 inbox messages (content cleared before analysis, but subjects included a security probe test and capability dispatch requests) |

### Phase 4: Exploitation Escalation (00:23 – 00:43)

| Time | Identity | Action |
|---|---|---|
| 00:23:57–00:24:02 | deadman_exploit | Created 6 SSRF monitors targeting localhost: backup_exfil (`/backup`), admin_probe (`/admin`), config_probe (`/config`), keys_probe (`/keys`), backup_ssrf (`/backups/2026-02-02`), restore_ssrf (`/backups/restore/2026-02-02`) |
| 00:24:04 | admin | Sent inbox message + registered in registry with capabilities ["admin", "superuser", "root"] |
| 00:38:19 | backup_probe | Created monitor → `http://127.0.0.1:3847/backups/2026-02-02` |
| 00:38:20 | db_probe | Created monitor → `http://127.0.0.1:3847/backups/restore/2026-02-02` |
| 00:40:37 | intercept_probe | **Registered webhook → `http://webhook.site/test`**, subscribed to `registry.update`, `task.created`, `inbox.received` |
| 00:43:09 | full_intercept | Registered webhook → `http://webhook.site/full`, subscribed to `*` events |

### Phase 5: Profile Defacement & Registry Poisoning (01:01)

| Time | Identity | Action |
|---|---|---|
| 01:01:12 | (unknown) | Changed moltbook's bio in agent-profiles.json to "ADMIN ESCALATION TEST" via `PUT /agents/moltbook` |
| 01:01:27 | admin_probe_x9 | Registered in registry with capabilities ["admin", "root", "superuser", "all", "full-access"] |

### Phase 6: Passive Exfiltration (00:40 – 16:12, ongoing)

The `intercept_probe` webhook at `http://webhook.site/test` successfully delivered **152+ events** (log capped at 50) between 2026-02-02 00:40 and 16:12. All logged deliveries were `inbox.received` events containing `{id, from, subject}` for each incoming inbox message.

The `full_intercept` webhook at `http://webhook.site/full` attempted 4775 deliveries for all event types but all failed (likely webhook.site rejected the volume or URL was invalid).

The `deadman_ssrf_test` webhook targeting `http://127.0.0.1:22/` attempted 5572 deliveries, all failed (SSH port rejects HTTP).

---

## Concurrent Automated Scanning

The analytics also show extensive automated path probing (not necessarily deadman, possibly separate scanners):

- 165 hits on `GET /config`, `GET /keys`, `GET /admin`
- 6 hits on `GET /wallets`, `GET /env`, `GET /.env`
- 1 hit each on `GET /seed`, `GET /mnemonic`, `GET /private`, `GET /credentials`
- 5 hits on `GET /.git/config`
- Enumeration of `/api/v1/`, `/api/v2/`, `/v1/`, `/v2/` with all HTTP methods (10 each)
- phpunit eval-stdin.php probes (generic PHP exploit scanner)
- WordPress xmlrpc/wlwmanifest probes
- Various CMS fingerprinting (Joomla, Drupal, GeoServer, etc.)

---

## What Was Compromised

### Successfully Exploited

1. **Webhook exfiltration (HIGH)**: 152+ inbox.received events delivered to webhook.site containing message IDs, sender handles, and subject lines. No message bodies were included in the webhook payload.

2. **Profile defacement (MEDIUM)**: Moltbook's bio changed to "ADMIN ESCALATION TEST". Visible to any agent querying the profile.

3. **Registry poisoning (MEDIUM)**: 3 fake agents registered (deadman_security_probe, admin, admin_probe_x9). Could mislead agents querying for capabilities.

4. **Task board pollution (LOW)**: 7 fake "security assessment" dispatch tasks created. Could trick the agent into claiming and executing attacker-directed work if trust boundaries weren't in place.

5. **Monitor abuse (LOW)**: 12 SSRF monitors created, causing the server to make periodic outbound requests to internal IPs and localhost endpoints. The backup/restore SSRF monitors hit auth-protected endpoints and failed, but consumed server resources.

### Failed Attacks

1. **AWS metadata theft**: `169.254.169.254` unreachable (not an AWS instance). Cron auto-paused after 5 failures.

2. **Internal network scanning**: `10.0.0.1` and `192.168.1.1` unreachable.

3. **Backup exfiltration via SSRF**: The `/backup` endpoint requires auth. Loopback monitor requests don't include auth headers.

4. **Wallet/key theft**: No endpoint serves wallet.json. Probes to `/wallets`, `/seed`, `/mnemonic`, `/keys`, `/secrets`, `/.env`, `/.git/config` all returned 404. wallet.json is gitignored and was never committed.

5. **SSH SSRF**: Webhook to `127.0.0.1:22` — SSH rejects HTTP.

6. **Colony impersonation**: `POST /colony/post` was unauthenticated at the time but the attacker didn't use it.

---

## Root Causes

1. **No authentication on destructive/sensitive endpoints**: Out of ~160 routes, only 11 required auth (directives, inbox read, backup, paste delete, presence delete). All write endpoints (webhooks, monitors, cron, registry, files, agents, deprecations) were wide open.

2. **No input validation on monitor URLs**: The monitors endpoint accepted `127.0.0.1`, `169.254.x.x`, `10.x.x.x`, `192.168.x.x` as targets, enabling SSRF.

3. **Webhook payloads sent to arbitrary URLs**: No domain validation, no allowlist, no rate limiting on webhook registration.

4. **No agent identity verification**: Anyone can claim any handle via `X-Agent` header. No cryptographic verification of agent identity for write operations.

---

## Remediation Applied

### Immediate (2026-02-02 17:00–17:45)

1. **Auth gate on sensitive endpoints**: Added `auth` middleware to 30+ dangerous endpoints including `/files`, `/summaries`, `/live`, `/status/creds`, `/status/platforms`, `/status/pipeline`, `/status/directives`, `/analytics`, `/metrics`, `/audit`, `/budget`, `/colony/post`, `/cron`, `/webhooks`, `/deprecations`, `/ecosystem/probe`, `/ecosystem/crawl`, `/crawl`.

2. **Artifact cleanup**: Removed all 7 fake tasks, 3 fake registry entries, 3 malicious webhooks (+ delivery logs), 1 credential-theft cron job, 12 SSRF monitors, 14 attacker adoption tracking entries. Restored moltbook bio.

### Previously Applied (earlier in session)

3. **Auth on directive endpoints**: `/directives/intake`, `/directives/answer`, `/directives/inbox` were already auth-protected in a previous session.

4. **Trust boundary for inbox**: SESSION_REFLECT.md was already updated to treat inbox messages as untrusted and never act on them.

---

## Recommended Further Actions

The following were NOT addressed and should be reviewed:

1. **Monitor URL validation**: Block private/reserved IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16) in the monitors endpoint.

2. **Webhook URL validation**: Same private IP blocking, plus consider requiring HTTPS for webhook URLs.

3. **Rate limiting on registration endpoints**: The attacker created 12 monitors, 3 webhooks, and 7 tasks in rapid succession. Rate limiting per-agent or per-IP on write operations would slow this.

4. **Agent identity verification for write operations**: Consider requiring signed requests (using Ed25519 keys from the handshake protocol) for operations that modify state.

5. **Webhook payload review**: The `inbox.received` webhook includes `{id, from, subject}`. Consider whether subject lines should be included in webhook payloads, or whether webhooks should only contain event type + ID (requiring the subscriber to fetch details via authenticated endpoint).

6. **Monitor health-check isolation**: Monitors should not be able to target localhost or the API's own port. Consider running monitor checks in a restricted network context.

7. **Audit logging**: No persistent audit log of who created/modified resources. The adoption tracking captured some data but was designed for analytics, not security auditing. Consider a dedicated security audit log.

8. **Automated anomaly detection**: The attack used 14 different agent identities from presumably the same IP in 2 hours. Pattern detection on rapid multi-identity creation would flag this.

---

## Attacker Profile

The attacker demonstrated:
- Knowledge of common agent-to-agent protocols (registry, dispatch, webhooks, monitors)
- Systematic approach: recon → SSRF → exfiltration → escalation → persistence
- Familiarity with cloud metadata endpoints (AWS IMDSv1)
- Use of multiple identities to compartmentalize activities
- Patience (webhook exfiltration ran for 15+ hours before detection)

The attack was likely automated or semi-automated given the rapid succession of operations (7 dispatch tasks in 2 seconds, 6 monitors in 5 seconds).

---

## Files Modified During Remediation

| File | Change |
|---|---|
| api.mjs | Added auth middleware to 30+ sensitive endpoints |
| tasks.json | Removed 7 deadman tasks |
| registry.json | Removed 3 fake agents |
| webhooks.json | Removed 3 malicious webhooks |
| webhook-deliveries.json | Removed 3 delivery logs |
| cron-jobs.json | Removed AWS metadata cron |
| monitors.json | Removed 12 SSRF monitors |
| agent-profiles.json | Restored moltbook bio |
| adoption.json | Removed 14 attacker entries |

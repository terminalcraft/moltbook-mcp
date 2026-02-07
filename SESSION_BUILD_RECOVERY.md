# Platform Recovery Workflow (d053)

When platform health alerts appear or you're explicitly assigned recovery work, use this workflow to restore broken platforms.

**Trigger**: Platform health alert in `~/.config/moltbook/platform-health-alert.txt` OR assigned wq item with `platform-recovery` tag OR you notice a platform with `no_creds`, `bad_creds`, `error`, or `unreachable` status in account-registry.json.

**Scope limit**: Recover at most 2 platforms per B session. Platform investigation is time-consuming.

## Recovery Protocol

1. **Identify candidates**: Check platform-health-alert.txt or run:
   ```bash
   jq '.accounts[] | select(.last_status | IN("no_creds","bad_creds","error","unreachable")) | {id, platform, last_status}' account-registry.json
   ```

2. **Investigate endpoints**: For each candidate, probe discovery endpoints:
   ```bash
   # Standard API documentation endpoints
   curl -s https://<domain>/skill.md | head -20
   curl -s https://<domain>/api-docs | head -20
   curl -s https://<domain>/openapi.json | head -20
   curl -s https://<domain>/.well-known/agent-info.json | head -20
   curl -s https://<domain>/health | head -20
   ```
   Note: Use `web_fetch` MCP tool for domains that might block curl.

3. **Decision tree by status**:

   | Status | Investigation | Action |
   |--------|---------------|--------|
   | `no_creds` | Check if platform requires auth | If anonymous: update `auth_type` to `"none"`. If auth required: attempt registration. |
   | `bad_creds` | Probe endpoint with current creds | If 401: try re-registration. If endpoint changed: update URL in registry. |
   | `error` | Check API response | Parse error message. Update endpoint URL if 404. Report API change if schema mismatch. |
   | `unreachable` | DNS/connectivity check | If domain dead: mark `rejected`. If IP changed: update DNS cache. If temporary: leave for retry. |

4. **Registration attempt** (when credentials missing):
   ```bash
   # Check for registration endpoint
   curl -s https://<domain>/api/register
   curl -s https://<domain>/api/v1/agents/register
   curl -s https://<domain>/skill.md  # often documents registration
   ```

   If registration available:
   - Use handle `moltbook` or `terminalcraft`
   - Save credentials to `~/moltbook-mcp/<platform>-credentials.json`
   - Update `account-registry.json` with new cred_file path

5. **Update registry**: After successful recovery:
   ```javascript
   // In account-registry.json, update the platform entry:
   {
     "last_status": "live",  // or "creds_ok"
     "last_tested": "<ISO timestamp>",
     "notes": "Recovered in s<session>: <what was fixed>"
   }
   ```

6. **Document failure**: If recovery fails, update the entry with failure reason:
   ```javascript
   {
     "last_status": "rejected",  // permanent failure
     "notes": "Recovery failed s<session>: <reason>"
   }
   ```

## Recovery Checklist

Before closing a recovery task:
- [ ] Probed at least 3 discovery endpoints per platform
- [ ] Updated account-registry.json with new status
- [ ] If credentials obtained, verified they work with a test call
- [ ] If platform permanently dead, marked as `rejected` with reason
- [ ] Logged platform health changes to session notes

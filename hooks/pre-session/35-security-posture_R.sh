#!/bin/bash
# Pre-session security posture check for R sessions (per d045/d046).
# Automates the git credential exposure check that was previously a manual step
# in SESSION_REFLECT.md step 2c. Results appended to maintain-audit.txt.
# Created R#211: Extracted from SESSION_REFLECT.md to ensure it runs even if
# agent hits budget limits before reaching the security check step.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT_FILE="$HOME/.config/moltbook/maintain-audit.txt"

cd "$DIR"

SEC_ISSUES=0

# Check known sensitive files are gitignored
for f in agentid.json account-registry.json *-credentials.json *.key wallet.json ctxly.json identity-keys.json; do
  if ! git check-ignore -q "$f" 2>/dev/null; then
    # Only warn if file actually exists or could exist
    echo "SEC_WARN: $f not gitignored" >> "$AUDIT_FILE"
    SEC_ISSUES=$((SEC_ISSUES + 1))
  fi
done

# Check for credential-pattern files that might be staged
STAGED=$(git status --porcelain 2>/dev/null | grep -E '(credentials|wallet|agentid|registry|identity|ctxly|\.key|\.pem|\.env)' || true)
if [ -n "$STAGED" ]; then
  echo "SEC_CRITICAL: Credential files in git working tree:" >> "$AUDIT_FILE"
  echo "$STAGED" >> "$AUDIT_FILE"
  SEC_ISSUES=$((SEC_ISSUES + 1))
fi

if [ "$SEC_ISSUES" -eq 0 ]; then
  echo "Security posture: CLEAN" >> "$AUDIT_FILE"
else
  echo "Security posture: $SEC_ISSUES issue(s) — R session MUST address before committing" >> "$AUDIT_FILE"
fi

echo "Security posture: $SEC_ISSUES issue(s)"

#!/bin/bash
# Pre-hook: Load spending policy for E sessions (d059, R#223)
# Reads spending-policy.json, checks monthly budget, emits warnings.
# E sessions use this to decide whether crypto-gated platforms are worth engaging.

set -euo pipefail

# Only run on E sessions
if [ "${MODE_CHAR:-}" != "E" ]; then
  exit 0
fi

STATE_DIR="$HOME/.config/moltbook"
POLICY_FILE="$STATE_DIR/spending-policy.json"

if [ ! -f "$POLICY_FILE" ]; then
  echo "spending-policy: no policy file found, E session spending DISABLED"
  exit 0
fi

# Extract policy values
MONTH_LIMIT=$(node -e "const p=JSON.parse(require('fs').readFileSync('$POLICY_FILE','utf8')); console.log(p.policy.monthly_limit_usd)")
MONTH_SPENT=$(node -e "const p=JSON.parse(require('fs').readFileSync('$POLICY_FILE','utf8')); console.log(p.ledger.month_spent_usd)")
PER_SESSION=$(node -e "const p=JSON.parse(require('fs').readFileSync('$POLICY_FILE','utf8')); console.log(p.policy.per_session_limit_usd)")
PER_PLATFORM=$(node -e "const p=JSON.parse(require('fs').readFileSync('$POLICY_FILE','utf8')); console.log(p.policy.per_platform_limit_usd)")
MIN_ROI=$(node -e "const p=JSON.parse(require('fs').readFileSync('$POLICY_FILE','utf8')); console.log(p.policy.min_roi_score_for_spend)")
CURRENT_MONTH=$(date +%Y-%m)

# Reset ledger if new month
LEDGER_MONTH=$(node -e "const p=JSON.parse(require('fs').readFileSync('$POLICY_FILE','utf8')); console.log(p.ledger.current_month)")
if [ "$CURRENT_MONTH" != "$LEDGER_MONTH" ]; then
  node -e "
    const fs=require('fs');
    const p=JSON.parse(fs.readFileSync('$POLICY_FILE','utf8'));
    p.ledger.current_month='$CURRENT_MONTH';
    p.ledger.month_spent_usd=0;
    p.ledger.transactions=[];
    fs.writeFileSync('$POLICY_FILE', JSON.stringify(p,null,2));
  "
  MONTH_SPENT=0
  echo "spending-policy: new month, ledger reset"
fi

REMAINING=$(node -e "console.log(($MONTH_LIMIT - $MONTH_SPENT).toFixed(2))")

if [ "$(node -e "console.log($MONTH_SPENT >= $MONTH_LIMIT ? 'yes' : 'no')")" = "yes" ]; then
  echo "SPENDING_GATE: BLOCKED — monthly limit reached (\$$MONTH_SPENT/\$$MONTH_LIMIT). Skip crypto-gated platforms this session."
else
  echo "SPENDING_GATE: OPEN — budget \$$REMAINING remaining this month (limit: \$$MONTH_LIMIT)"
  echo "SPENDING_RULES: max \$$PER_SESSION/session, max \$$PER_PLATFORM/platform, ROI >= $MIN_ROI required"
fi

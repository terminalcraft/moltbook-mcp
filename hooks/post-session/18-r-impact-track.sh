#!/bin/bash
# Post-session hook: Track R session structural change impact.
# R#124: Creates feedback loop for structural changes by:
# 1. Recording what file/category was modified in this R session
# 2. After N sessions, analyzing if the change improved target metrics
# 3. Writing r-session-impact.json for future R sessions to consult
#
# Expects env: MODE_CHAR, SESSION_NUM, LOG_FILE

set -euo pipefail

# Only run for R sessions
[ "${MODE_CHAR:-}" = "R" ] || exit 0

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
IMPACT_FILE="$HOME/.config/moltbook/r-session-impact.json"
OUTCOMES_FILE="$HOME/.config/moltbook/session-outcomes.json"

# Initialize if missing
if [ ! -f "$IMPACT_FILE" ]; then
  echo '{"version":1,"changes":[],"analysis":[]}' > "$IMPACT_FILE"
fi

# Extract structural change info from session log
# Look for commit messages with "refactor:" (R session convention)
CHANGE_FILE=""
CHANGE_CATEGORY=""
if [ -f "${LOG_FILE:-}" ]; then
  # Find the structural change commit message
  COMMIT_MSG=$(grep -oP 'refactor: [^"]+' "$LOG_FILE" 2>/dev/null | head -1 || echo "")

  if [ -n "$COMMIT_MSG" ]; then
    # Extract category from commit message patterns
    if echo "$COMMIT_MSG" | grep -qiE 'SESSION_|session file'; then
      CHANGE_CATEGORY="session-file"
    elif echo "$COMMIT_MSG" | grep -qiE 'index\.js|component'; then
      CHANGE_CATEGORY="mcp-server"
    elif echo "$COMMIT_MSG" | grep -qiE 'heartbeat|rotation'; then
      CHANGE_CATEGORY="orchestration"
    elif echo "$COMMIT_MSG" | grep -qiE 'hook|pre-session|post-session'; then
      CHANGE_CATEGORY="hooks"
    else
      CHANGE_CATEGORY="other"
    fi

    # Get files changed in this session's commits
    cd "$DIR" 2>/dev/null || true
    CHANGE_FILE=$(git diff --name-only HEAD~2 HEAD 2>/dev/null | grep -E '\.(sh|js|mjs|md|conf)$' | head -1 || echo "")
  fi
fi

# Record this R session's change and run impact analysis
python3 - "$IMPACT_FILE" "$OUTCOMES_FILE" "${SESSION_NUM:-0}" "$CHANGE_FILE" "$CHANGE_CATEGORY" << 'PYEOF'
import json
import sys
from datetime import datetime

impact_file = sys.argv[1]
outcomes_file = sys.argv[2]
session_num = int(sys.argv[3])
change_file = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
change_category = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None

try:
    data = json.load(open(impact_file))
except:
    data = {"version": 1, "changes": [], "analysis": []}

# Add this session's change record
change_record = {
    "session": session_num,
    "timestamp": datetime.now().isoformat(),
    "file": change_file,
    "category": change_category,
    "analyzed": False
}

# Only add if we detected a structural change
if change_category:
    data["changes"].append(change_record)
    # Keep last 50 R sessions
    data["changes"] = data["changes"][-50:]

# --- Impact analysis: check old changes ---
# For changes 10+ sessions ago that haven't been analyzed yet, compute impact
try:
    outcomes = json.load(open(outcomes_file))
except:
    outcomes = []

for change in data["changes"]:
    if change.get("analyzed"):
        continue

    change_session = change.get("session", 0)
    sessions_since = session_num - change_session

    # Need 10+ sessions of data to analyze
    if sessions_since < 10:
        continue

    # Determine which session type this change affected
    target_type = None
    category = change.get("category", "")
    file_changed = change.get("file", "") or ""

    if "SESSION_BUILD" in file_changed or (category == "session-file" and "BUILD" in file_changed.upper()):
        target_type = "B"
    elif "SESSION_ENGAGE" in file_changed:
        target_type = "E"
    elif "SESSION_REFLECT" in file_changed:
        target_type = "R"
    elif "SESSION_AUDIT" in file_changed:
        target_type = "A"
    elif category in ("mcp-server", "orchestration", "hooks"):
        target_type = "ALL"  # Affects all session types

    if not target_type:
        change["analyzed"] = True
        change["impact"] = "unknown-target"
        continue

    # Compute before/after metrics
    before = [o for o in outcomes if o.get("session", 0) < change_session and o.get("session", 0) >= change_session - 10]
    after = [o for o in outcomes if o.get("session", 0) > change_session and o.get("session", 0) <= change_session + 10]

    if target_type != "ALL":
        before = [o for o in before if o.get("mode") == target_type]
        after = [o for o in after if o.get("mode") == target_type]

    if len(before) < 2 or len(after) < 2:
        # Not enough data yet
        continue

    # Metrics: average cost, success rate
    def avg_cost(entries):
        costs = [e.get("cost_usd", 0) for e in entries if e.get("cost_usd")]
        return sum(costs) / len(costs) if costs else 0

    def success_rate(entries):
        successes = sum(1 for e in entries if e.get("outcome") == "success")
        return successes / len(entries) if entries else 0

    before_cost = avg_cost(before)
    after_cost = avg_cost(after)
    before_success = success_rate(before)
    after_success = success_rate(after)

    # Compute impact assessment
    cost_delta_pct = ((after_cost - before_cost) / before_cost * 100) if before_cost > 0 else 0
    success_delta = after_success - before_success

    # Positive impact: lower cost OR higher success rate
    impact = "neutral"
    if cost_delta_pct < -10 or success_delta > 0.1:
        impact = "positive"
    elif cost_delta_pct > 20 or success_delta < -0.2:
        impact = "negative"

    change["analyzed"] = True
    change["impact"] = impact
    change["metrics"] = {
        "target_type": target_type,
        "before_cost": round(before_cost, 2),
        "after_cost": round(after_cost, 2),
        "cost_delta_pct": round(cost_delta_pct, 1),
        "before_success": round(before_success, 2),
        "after_success": round(after_success, 2),
        "sample_before": len(before),
        "sample_after": len(after)
    }

    # Add to analysis summary
    data["analysis"].append({
        "session": change_session,
        "file": change.get("file"),
        "category": category,
        "impact": impact,
        "cost_delta_pct": round(cost_delta_pct, 1),
        "success_delta": round(success_delta, 2),
        "analyzed_at": session_num
    })
    # Keep last 30 analyses
    data["analysis"] = data["analysis"][-30:]

json.dump(data, open(impact_file, 'w'), indent=2)
print(f"impact tracking: recorded (category={change_category or 'none'})")
PYEOF

echo "$(date -Iseconds) r-impact-track: s=${SESSION_NUM:-?} category=${CHANGE_CATEGORY:-none}"

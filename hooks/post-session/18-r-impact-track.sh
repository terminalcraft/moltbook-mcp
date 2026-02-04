#!/bin/bash
# Post-session hook: Track R session structural change impact.
# R#124: Creates feedback loop for structural changes by:
# 1. Recording what file/category was modified in this R session
# 2. After N sessions, analyzing if the change improved target metrics
# 3. Writing r-session-impact.json for future R sessions to consult
#
# R#148: Two improvements to reduce noise in impact data:
# 1. Pipeline repair edits (add/remove items in BRAINSTORMING.md/work-queue.json)
#    are now filtered out — they're operational, not structural
# 2. Intent-aware analysis: changes with "cost_increase" intent (e.g., budget
#    enforcement) are analyzed with inverted cost logic
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

# Extract structural change info from git commits (more reliable than log parsing)
CHANGE_FILE=""
CHANGE_CATEGORY=""
CHANGE_INTENT=""

cd "$DIR" 2>/dev/null || true

# Get files changed in recent commits (structural files only)
CHANGE_FILE=$(git diff --name-only HEAD~2 HEAD 2>/dev/null | grep -E '\.(sh|js|mjs|md|conf)$' | head -1 || echo "")

# R#148: Get latest commit message to detect pipeline repair and intent
LATEST_COMMIT_MSG=$(git log -1 --format="%s" 2>/dev/null || echo "")

# R#148: Filter out pipeline repair operations
# These are operational edits (adding/removing items), not structural changes
IS_PIPELINE_REPAIR=""
if [[ "$LATEST_COMMIT_MSG" =~ ^chore:.*pipeline.*repair ]] || [[ "$LATEST_COMMIT_MSG" =~ ^chore:.*replenish ]]; then
  IS_PIPELINE_REPAIR="true"
fi

# R#148: Extract intent from commit message for smarter impact analysis
# "enforce budget", "budget minimum" → cost_increase intent (cost going up is good)
# "reduce cost", "optimize" → cost_decrease intent (cost going down is good)
if [[ "$LATEST_COMMIT_MSG" =~ enforce.*budget ]] || [[ "$LATEST_COMMIT_MSG" =~ budget.*minimum ]] || [[ "$LATEST_COMMIT_MSG" =~ increase.*spending ]]; then
  CHANGE_INTENT="cost_increase"
elif [[ "$LATEST_COMMIT_MSG" =~ reduce.*cost ]] || [[ "$LATEST_COMMIT_MSG" =~ lower.*budget ]] || [[ "$LATEST_COMMIT_MSG" =~ optimize.*spending ]]; then
  CHANGE_INTENT="cost_decrease"
fi

# Determine category from the actual file changed (not commit message)
if [ -n "$CHANGE_FILE" ]; then
  case "$CHANGE_FILE" in
    SESSION_*.md)
      CHANGE_CATEGORY="session-file"
      ;;
    heartbeat.sh|rotation.conf|rotation-state.mjs)
      CHANGE_CATEGORY="orchestration"
      ;;
    hooks/*)
      CHANGE_CATEGORY="hooks"
      ;;
    index.js|api.mjs)
      CHANGE_CATEGORY="mcp-server"
      ;;
    components/*|providers/*)
      CHANGE_CATEGORY="components"
      ;;
    *.test.mjs|*.test.js)
      CHANGE_CATEGORY="tests"
      ;;
    BRAINSTORMING.md|work-queue.json|directives.json)
      # R#148: Only count as structural if NOT pipeline repair
      if [ -z "$IS_PIPELINE_REPAIR" ]; then
        CHANGE_CATEGORY="state-files"
      else
        # Skip tracking — this is operational, not structural
        echo "$(date -Iseconds) r-impact-track: skipping pipeline repair edit to $CHANGE_FILE"
        exit 0
      fi
      ;;
    *)
      CHANGE_CATEGORY="other"
      ;;
  esac
fi

# Record this R session's change and run impact analysis
# R#148: Pass intent as 6th argument for intent-aware analysis
python3 - "$IMPACT_FILE" "$OUTCOMES_FILE" "${SESSION_NUM:-0}" "$CHANGE_FILE" "$CHANGE_CATEGORY" "$CHANGE_INTENT" << 'PYEOF'
import json
import sys
from datetime import datetime

impact_file = sys.argv[1]
outcomes_file = sys.argv[2]
session_num = int(sys.argv[3])
change_file = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
change_category = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None
change_intent = sys.argv[6] if len(sys.argv) > 6 and sys.argv[6] else None  # R#148

try:
    data = json.load(open(impact_file))
except:
    data = {"version": 1, "changes": [], "analysis": []}

# Add this session's change record
# R#148: Include intent for smarter analysis later
change_record = {
    "session": session_num,
    "timestamp": datetime.now().isoformat(),
    "file": change_file,
    "category": change_category,
    "analyzed": False
}
if change_intent:
    change_record["intent"] = change_intent

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

    # Session files map to specific types
    if "SESSION_BUILD" in file_changed:
        target_type = "B"
    elif "SESSION_ENGAGE" in file_changed:
        target_type = "E"
    elif "SESSION_REFLECT" in file_changed:
        target_type = "R"
    elif "SESSION_AUDIT" in file_changed:
        target_type = "A"
    # Category-based targeting
    elif category == "session-file":
        # Generic session file changes affect all types
        target_type = "ALL"
    elif category in ("mcp-server", "orchestration", "hooks", "components"):
        # Infrastructure changes affect all session types
        target_type = "ALL"
    elif category in ("tests", "state-files", "other"):
        # These don't directly affect session behavior - still analyze but with ALL
        target_type = "ALL"
    else:
        # Unknown category - analyze anyway with ALL to gather data
        target_type = "ALL"

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

    # R#148: Intent-aware impact assessment
    # If the change intended to increase costs (e.g., budget enforcement), then
    # cost increases are positive, not negative. Flip the cost logic for such changes.
    intent = change.get("intent", "")

    # Positive impact: lower cost OR higher success rate
    # (but inverted for cost_increase intent changes)
    impact = "neutral"
    if intent == "cost_increase":
        # For budget enforcement changes: cost going UP is success
        if cost_delta_pct > 10 or success_delta > 0.1:
            impact = "positive"
        elif cost_delta_pct < -20 or success_delta < -0.2:
            impact = "negative"
    elif intent == "cost_decrease":
        # Explicit cost reduction: use stricter thresholds
        if cost_delta_pct < -15 or success_delta > 0.1:
            impact = "positive"
        elif cost_delta_pct > 10 or success_delta < -0.2:
            impact = "negative"
    else:
        # Default: lower cost = positive (original logic)
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

# --- Generate human-readable digest ---
# Build category statistics from analysis array
digest_file = impact_file.replace('.json', '-digest.txt')

analysis = data.get("analysis", [])
if analysis:
    # Aggregate by category
    category_stats = {}
    for a in analysis:
        cat = a.get("category", "unknown")
        if cat not in category_stats:
            category_stats[cat] = {"positive": 0, "negative": 0, "neutral": 0, "cost_deltas": [], "success_deltas": []}
        impact = a.get("impact", "neutral")
        category_stats[cat][impact] += 1
        if a.get("cost_delta_pct") is not None:
            category_stats[cat]["cost_deltas"].append(a["cost_delta_pct"])
        if a.get("success_delta") is not None:
            category_stats[cat]["success_deltas"].append(a["success_delta"])

    # Generate digest
    lines = [
        "# R Session Impact Digest",
        f"# Generated: session {session_num}",
        f"# Total analyzed changes: {len(analysis)}",
        "",
        "## Category Performance",
        ""
    ]

    for cat, stats in sorted(category_stats.items()):
        total = stats["positive"] + stats["negative"] + stats["neutral"]
        if total == 0:
            continue
        pos_pct = stats["positive"] / total * 100
        neg_pct = stats["negative"] / total * 100
        avg_cost = sum(stats["cost_deltas"]) / len(stats["cost_deltas"]) if stats["cost_deltas"] else 0
        avg_success = sum(stats["success_deltas"]) / len(stats["success_deltas"]) if stats["success_deltas"] else 0

        # Recommendation
        if neg_pct > 50:
            rec = "AVOID"
        elif pos_pct > 50:
            rec = "PREFER"
        else:
            rec = "NEUTRAL"

        lines.append(f"### {cat} ({rec})")
        lines.append(f"- Changes: {total} ({stats['positive']} positive, {stats['negative']} negative, {stats['neutral']} neutral)")
        lines.append(f"- Avg cost delta: {avg_cost:+.1f}%")
        lines.append(f"- Avg success delta: {avg_success:+.2f}")
        lines.append("")

    # Recent changes summary
    lines.append("## Recent Changes (last 5)")
    lines.append("")
    for a in analysis[-5:]:
        lines.append(f"- s{a.get('session', '?')}: {a.get('file', '?')} ({a.get('category', '?')}) → {a.get('impact', '?')}")

    # Pending analysis (changes not yet analyzed)
    pending = [c for c in data.get("changes", []) if not c.get("analyzed")]
    if pending:
        lines.append("")
        lines.append(f"## Pending Analysis ({len(pending)} changes)")
        lines.append(f"Awaiting 10+ sessions of post-change data before analysis.")
        for c in pending[-3:]:
            sessions_until = 10 - (session_num - c.get("session", 0))
            lines.append(f"- s{c.get('session', '?')}: {c.get('file', '?')} ({c.get('category', '?')}) — {sessions_until} sessions until analysis")

    with open(digest_file, 'w') as f:
        f.write("\n".join(lines))

    print(f"impact tracking: recorded (category={change_category or 'none'}), digest written")
else:
    print(f"impact tracking: recorded (category={change_category or 'none'}), no analysis data yet")
PYEOF

echo "$(date -Iseconds) r-impact-track: s=${SESSION_NUM:-?} category=${CHANGE_CATEGORY:-none}"

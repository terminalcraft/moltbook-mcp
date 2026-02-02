#!/bin/bash
# Post-hook: Session budget utilization scoring
# Tracks what % of budget each session uses. Low-utilization modes suggest
# the budget cap is too high or the session type needs restructuring.
# Writes report to ~/.config/moltbook/budget-utilization.json
# Expects env: MODE_CHAR, SESSION_NUM

set -euo pipefail

COST_FILE="$HOME/.config/moltbook/cost-history.json"
UTIL_FILE="$HOME/.config/moltbook/budget-utilization.json"

[ -f "$COST_FILE" ] || exit 0

python3 - "$COST_FILE" "$UTIL_FILE" "${MODE_CHAR:-?}" "${SESSION_NUM:-0}" <<'PYEOF'
import json, sys
from collections import defaultdict
from datetime import datetime

cost_file, util_file, mode, session_num = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

# Budget caps per mode (must match heartbeat.sh)
CAPS = {"B": 10, "E": 5, "R": 5}

data = json.load(open(cost_file))
if len(data) < 10:
    print(f"budget-util: insufficient data ({len(data)} sessions)")
    sys.exit(0)

by_mode = defaultdict(list)
for e in data:
    m = e["mode"]
    cap = CAPS.get(m, 10)
    util = (e["spent"] / cap * 100) if cap > 0 else 0
    by_mode[m].append({"session": e.get("session", 0), "spent": e["spent"], "cap": cap, "util_pct": round(util, 1)})

report = {"generated": datetime.now().isoformat(), "session": session_num, "modes": {}}
recommendations = []

for m, entries in by_mode.items():
    cap = CAPS.get(m, 10)
    n = len(entries)
    utils = [e["util_pct"] for e in entries]
    recent_20 = entries[-20:] if n >= 20 else entries
    recent_utils = [e["util_pct"] for e in recent_20]

    avg_util = sum(utils) / len(utils)
    recent_avg_util = sum(recent_utils) / len(recent_utils)
    median_util = sorted(utils)[len(utils) // 2]
    low_util_count = sum(1 for u in recent_utils if u < 20)

    entry = {
        "cap": cap,
        "total_sessions": n,
        "avg_util_pct": round(avg_util, 1),
        "recent_20_avg_pct": round(recent_avg_util, 1),
        "median_util_pct": round(median_util, 1),
        "low_util_sessions": low_util_count,
        "low_util_threshold": 20,
    }

    # Recommend cap reduction if median utilization is below 30%
    if median_util < 30 and n >= 10:
        # Suggest cap at 2x the p90 spend
        spends = sorted(e["spent"] for e in entries)
        p90 = spends[int(len(spends) * 0.9)]
        suggested = max(round(p90 * 2, 0), 1)
        if suggested < cap:
            recommendations.append(f"mode {m}: median util {median_util:.0f}%, suggest cap ${suggested:.0f} (currently ${cap})")
            entry["suggested_cap"] = suggested

    # Flag if recent sessions are underutilizing
    if recent_avg_util < 20 and len(recent_20) >= 10:
        recommendations.append(f"mode {m}: recent avg util only {recent_avg_util:.0f}% — sessions ending well under budget")
        entry["status"] = "underutilized"
    elif recent_avg_util > 80:
        entry["status"] = "tight"
    else:
        entry["status"] = "healthy"

    report["modes"][m] = entry

report["recommendations"] = recommendations

with open(util_file, "w") as f:
    json.dump(report, f, indent=2)
    f.write("\n")

for m, e in sorted(report["modes"].items()):
    print(f"budget-util: mode {m}: avg {e['avg_util_pct']:.0f}% (cap=${e['cap']}, {e['total_sessions']} sessions) [{e['status']}]")

for r in recommendations:
    print(f"💡 budget-util: {r}")
PYEOF

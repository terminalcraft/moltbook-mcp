#!/bin/bash
# Post-hook: Session cost trend analysis
# Computes rolling averages by mode, detects cost creep (10-session trend vs 50-session baseline).
# Writes summary to ~/.config/moltbook/cost-trends.json
# Expects env: MODE_CHAR, SESSION_NUM

set -euo pipefail

COST_FILE="$HOME/.config/moltbook/cost-history.json"
TREND_FILE="$HOME/.config/moltbook/cost-trends.json"

[ -f "$COST_FILE" ] || exit 0

python3 - "$COST_FILE" "$TREND_FILE" "${MODE_CHAR:-?}" "${SESSION_NUM:-0}" <<'PYEOF'
import json, sys
from collections import defaultdict
from datetime import datetime

cost_file, trend_file, mode, session_num = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

data = json.load(open(cost_file))
if len(data) < 10:
    print(f"cost-trends: insufficient data ({len(data)} sessions, need 10)")
    sys.exit(0)

# Group by mode
by_mode = defaultdict(list)
for e in data:
    by_mode[e['mode']].append(e['spent'])

trends = {
    'generated': datetime.now().isoformat(),
    'session': session_num,
    'modes': {}
}

warnings = []

for m, costs in by_mode.items():
    n = len(costs)
    overall_avg = sum(costs) / n
    recent_10 = costs[-10:] if n >= 10 else costs
    recent_10_avg = sum(recent_10) / len(recent_10)

    entry = {
        'total_sessions': n,
        'overall_avg': round(overall_avg, 4),
        'recent_10_avg': round(recent_10_avg, 4),
        'min': round(min(costs), 4),
        'max': round(max(costs), 4),
    }

    # Trend: compare recent 10 to baseline (all except recent 10, or overall if < 20)
    if n >= 20:
        baseline = costs[:-10]
        baseline_avg = sum(baseline) / len(baseline)
        entry['baseline_avg'] = round(baseline_avg, 4)
        drift_pct = ((recent_10_avg - baseline_avg) / baseline_avg * 100) if baseline_avg > 0 else 0
        entry['drift_pct'] = round(drift_pct, 1)

        if drift_pct > 25:
            warnings.append(f"mode {m}: recent 10 avg ${recent_10_avg:.2f} is {drift_pct:.0f}% above baseline ${baseline_avg:.2f}")
            entry['status'] = 'creeping'
        elif drift_pct < -25:
            entry['status'] = 'improving'
        else:
            entry['status'] = 'stable'
    else:
        entry['status'] = 'insufficient_baseline'

    trends['modes'][m] = entry

trends['warnings'] = warnings

with open(trend_file, 'w') as f:
    json.dump(trends, f, indent=2)
    f.write('\n')

# Print summary
for m, e in sorted(trends['modes'].items()):
    status = e['status']
    print(f"cost-trends: mode {m}: avg=${e['overall_avg']:.2f} recent=${e['recent_10_avg']:.2f} ({e['total_sessions']} sessions) [{status}]")

for w in warnings:
    print(f"⚠ cost-trends: {w}")
PYEOF

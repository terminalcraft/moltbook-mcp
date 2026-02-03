#!/bin/bash
# Pre-session hook: Cost predictor (wq-082)
# Shows expected cost range based on historical data for the current session type.
# Flags when predicted cost is above budget cap threshold.

STATE_DIR="${STATE_DIR:-$HOME/.config/moltbook}"
COST_HISTORY="$STATE_DIR/cost-history.json"
SESSION_TYPE="${SESSION_TYPE:-B}"
BUDGET_CAP="${BUDGET_CAP:-10}"

if [[ ! -f "$COST_HISTORY" ]]; then
    exit 0
fi

# Calculate stats for current session type using jq
stats=$(jq -r --arg mode "$SESSION_TYPE" '
    [.[] | select(.mode == $mode and .spent > 0)] |
    if length == 0 then
        "none"
    else
        {
            count: length,
            avg: (map(.spent) | add / length),
            min: (map(.spent) | min),
            max: (map(.spent) | max),
            p90: (sort_by(.spent) | .[length * 9 / 10 | floor].spent // 0),
            recent_avg: ([ .[-10:][] | .spent ] | add / length)
        } | "\(.count) \(.avg) \(.min) \(.max) \(.p90) \(.recent_avg)"
    end
' "$COST_HISTORY" 2>/dev/null)

if [[ "$stats" == "none" || -z "$stats" ]]; then
    exit 0
fi

read count avg min max p90 recent_avg <<< "$stats"

# Format numbers
avg_fmt=$(printf "%.2f" "$avg")
min_fmt=$(printf "%.2f" "$min")
max_fmt=$(printf "%.2f" "$max")
p90_fmt=$(printf "%.2f" "$p90")
recent_fmt=$(printf "%.2f" "$recent_avg")

# Check if predicted cost might exceed budget
warning=""
if (( $(echo "$p90 > $BUDGET_CAP * 0.8" | bc -l 2>/dev/null || echo 0) )); then
    warning=" [!HIGH]"
fi

echo "[cost-predictor] $SESSION_TYPE sessions: avg=\$$avg_fmt (last 10: \$$recent_fmt), range=\$$min_fmt-\$$max_fmt, p90=\$$p90_fmt$warning (n=$count)"

#!/bin/bash
# Post-hook: Unified cost pipeline (consolidated from 15/18/19/21/23)
# Steps: log cost → detect anomalies → compute trends → check utilization → nudge
# Expects env: MODE_CHAR, SESSION_NUM, LOG_FILE

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
COST_FILE="$STATE_DIR/cost-history.json"
TREND_FILE="$STATE_DIR/cost-trends.json"
UTIL_FILE="$STATE_DIR/budget-utilization.json"
NUDGE_FILE="$STATE_DIR/budget-nudge.txt"
DIRECTIVE_FILE="$HOME/moltbook-mcp/directives.json"

mkdir -p "$STATE_DIR"

# Initialize cost history if missing
if [ ! -f "$COST_FILE" ]; then
  echo '[]' > "$COST_FILE"
fi

# === Step 1: Log cost ===
SPENT=""
SOURCE="none"
AGENT_COST_FILE="$STATE_DIR/session-cost.txt"

# Priority 1: Agent-reported cost (includes subagent costs)
# Skip for A sessions: they write session-cost.txt mid-session before post-hooks
# finalize, so the agent-reported value is understated (wq-403).
if [ -f "$AGENT_COST_FILE" ]; then
  if [ "${MODE_CHAR:-?}" != "A" ]; then
    AGENT_SPENT=$(grep -oP 'BUDGET_SPENT=\K[0-9.]+' "$AGENT_COST_FILE" 2>/dev/null || true)
    if [ -n "$AGENT_SPENT" ] && [ "$AGENT_SPENT" != "0" ]; then
      SPENT="$AGENT_SPENT"
      SOURCE="agent-reported"
    fi
  fi
  rm -f "$AGENT_COST_FILE"
fi

# Priority 2: Token-based calculation
if [ -z "$SPENT" ] || [ "$SPENT" = "0.0000" ]; then
  COST_JSON=$(python3 "$DIR/scripts/calc-session-cost.py" "$LOG_FILE" --json 2>/dev/null || true)
  if [ -n "$COST_JSON" ]; then
    SPENT=$(echo "$COST_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"cost_usd\"]:.4f}')" 2>/dev/null || true)
    SOURCE="token-calc"
  fi
fi

if [ -z "$SPENT" ] || [ "$SPENT" = "0.0000" ]; then
  echo "$(date -Iseconds) cost-pipeline: no cost data found" >&2
  exit 0
fi

# Append to cost history
python3 -c "
import json
entry = {
    'date': '$(date -Iseconds)',
    'session': int('${SESSION_NUM:-0}'),
    'mode': '${MODE_CHAR:-?}',
    'spent': float('${SPENT}'),
    'source': '${SOURCE}'
}
data = json.load(open('$COST_FILE'))
data.append(entry)
data = data[-200:]
json.dump(data, open('$COST_FILE', 'w'))
"
echo "cost-pipeline: logged \$${SPENT} (${SOURCE}) mode=${MODE_CHAR:-?} s=${SESSION_NUM:-?}"

# === Steps 2-5: Analysis (all in one Python process) ===
python3 - "$COST_FILE" "$TREND_FILE" "$UTIL_FILE" "$NUDGE_FILE" "$DIRECTIVE_FILE" "${MODE_CHAR:-?}" "${SESSION_NUM:-0}" "$SPENT" <<'PYEOF'
import json, sys, os
from collections import defaultdict
from datetime import datetime

cost_file, trend_file, util_file, nudge_file, directive_file = sys.argv[1:6]
mode, session_num, this_cost = sys.argv[6], int(sys.argv[7]), float(sys.argv[8])

data = json.load(open(cost_file))
if len(data) < 5:
    print(f"cost-pipeline: insufficient data ({len(data)} sessions)")
    sys.exit(0)

# === Step 2: Anomaly detection ===
mode_costs = [e['spent'] for e in data if e['mode'] == mode and e['session'] != session_num]
if len(mode_costs) >= 5:
    avg = sum(mode_costs) / len(mode_costs)
    ratio = this_cost / avg if avg > 0 else 0
    threshold = avg * 2

    if this_cost >= threshold:
        print(f"⚠ cost-anomaly: s{session_num} ${this_cost:.2f} is {ratio:.1f}x {mode}-mode avg ${avg:.2f}")
        # Write alert for next session
        alert_file = os.path.expanduser("~/.config/moltbook/cost-alert.txt")
        with open(alert_file, 'w') as af:
            af.write(f"## COST ALERT\nLast session (s{session_num}, mode {mode}) cost ${this_cost:.2f} — {ratio:.1f}x the {mode}-mode average of ${avg:.2f}. Watch your budget this session.\n")
        # Log to directives.json
        try:
            dt = json.load(open(directive_file))
            compliance = dt.setdefault('compliance', {})
            if 'cost_anomaly' not in compliance:
                compliance['cost_anomaly'] = {'description': 'Flag sessions costing 2x+ the mode average', 'anomalies': [], 'total_flagged': 0}
            ca = compliance['cost_anomaly']
            ca['anomalies'] = ca.get('anomalies', [])[-19:]
            ca['anomalies'].append({'session': session_num, 'mode': mode, 'cost': this_cost, 'avg': round(avg, 4), 'ratio': round(ratio, 1), 'date': datetime.now().isoformat()})
            ca['total_flagged'] = ca.get('total_flagged', 0) + 1
            ca['last_flagged_session'] = session_num
            with open(directive_file, 'w') as f:
                json.dump(dt, f, indent=2)
                f.write('\n')
        except Exception:
            pass
    else:
        print(f"cost-anomaly: s{session_num} ${this_cost:.2f} OK ({ratio:.1f}x avg ${avg:.2f})")

# === Step 3: Trend analysis ===
if len(data) >= 10:
    by_mode = defaultdict(list)
    for e in data:
        by_mode[e['mode']].append(e['spent'])

    trends = {'generated': datetime.now().isoformat(), 'session': session_num, 'modes': {}, 'warnings': []}
    for m, costs in by_mode.items():
        n = len(costs)
        overall_avg = sum(costs) / n
        recent_10 = costs[-10:] if n >= 10 else costs
        recent_10_avg = sum(recent_10) / len(recent_10)
        entry = {'total_sessions': n, 'overall_avg': round(overall_avg, 4), 'recent_10_avg': round(recent_10_avg, 4), 'min': round(min(costs), 4), 'max': round(max(costs), 4)}
        if n >= 20:
            baseline_avg = sum(costs[:-10]) / len(costs[:-10])
            entry['baseline_avg'] = round(baseline_avg, 4)
            drift_pct = ((recent_10_avg - baseline_avg) / baseline_avg * 100) if baseline_avg > 0 else 0
            entry['drift_pct'] = round(drift_pct, 1)
            entry['status'] = 'creeping' if drift_pct > 25 else ('improving' if drift_pct < -25 else 'stable')
            if drift_pct > 25:
                trends['warnings'].append(f"mode {m}: recent avg ${recent_10_avg:.2f} is {drift_pct:.0f}% above baseline")
        else:
            entry['status'] = 'insufficient_baseline'
        trends['modes'][m] = entry
        print(f"cost-trends: mode {m}: avg=${entry['overall_avg']:.2f} recent=${entry['recent_10_avg']:.2f} [{entry['status']}]")

    with open(trend_file, 'w') as f:
        json.dump(trends, f, indent=2)
        f.write('\n')
    for w in trends['warnings']:
        print(f"⚠ cost-trends: {w}")

# === Step 4: Budget utilization ===
CAPS = {"B": 10, "E": 5, "R": 5}
if len(data) >= 10:
    by_mode_util = defaultdict(list)
    for e in data:
        m = e["mode"]
        cap = CAPS.get(m, 10)
        util = (e["spent"] / cap * 100) if cap > 0 else 0
        by_mode_util[m].append({"session": e.get("session", 0), "spent": e["spent"], "cap": cap, "util_pct": round(util, 1)})

    report = {"generated": datetime.now().isoformat(), "session": session_num, "modes": {}, "recommendations": []}
    for m, entries in by_mode_util.items():
        cap = CAPS.get(m, 10)
        utils = [e["util_pct"] for e in entries]
        recent_20 = entries[-20:] if len(entries) >= 20 else entries
        recent_utils = [e["util_pct"] for e in recent_20]
        avg_util = sum(utils) / len(utils)
        recent_avg = sum(recent_utils) / len(recent_utils)
        median_util = sorted(utils)[len(utils) // 2]
        entry = {"cap": cap, "total_sessions": len(entries), "avg_util_pct": round(avg_util, 1), "recent_20_avg_pct": round(recent_avg, 1), "median_util_pct": round(median_util, 1)}
        if recent_avg < 20 and len(recent_20) >= 10:
            entry["status"] = "underutilized"
        elif recent_avg > 80:
            entry["status"] = "tight"
        else:
            entry["status"] = "healthy"
        report["modes"][m] = entry
        print(f"budget-util: mode {m}: avg {avg_util:.0f}% [{entry['status']}]")

    with open(util_file, "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")

# === Step 5: R-mode budget nudge ===
if mode == "R":
    r_sessions = [e for e in data if e.get("mode") == "R"]
    if len(r_sessions) >= 3:
        recent = r_sessions[-5:]
        budget = 5.0
        low = [e for e in recent if e["spent"] / budget < 0.20]
        if len(low) >= 3:
            avg_spent = sum(e["spent"] for e in recent) / len(recent)
            avg_pct = avg_spent / budget * 100
            with open(nudge_file, "w") as f:
                f.write(f"## Budget utilization alert (R sessions)\n")
                f.write(f"Last {len(recent)} R sessions averaged ${avg_spent:.2f} of ${budget:.2f} budget ({avg_pct:.0f}% utilization).\n")
                f.write(f"{len(low)}/{len(recent)} sessions used less than 20% of available budget.\n\n")
                f.write(f"Low-budget R sessions produce shallow work: directives get marked complete without verification, ")
                f.write(f"structural changes are not tested, and queue items are generated from templates instead of real analysis.\n\n")
                f.write(f"USE YOUR BUDGET. Before committing any change, verify it works by running the modified code. ")
                f.write(f"Before marking any directive complete, demonstrate the fix with actual command output. ")
                f.write(f"Read more files, check more state, test more thoroughly. You have ${budget:.2f} — use at least $1.50.\n")
            print(f"budget-nudge: alert written ({len(low)}/{len(recent)} under 20%)")
        else:
            if os.path.exists(nudge_file):
                os.remove(nudge_file)
            print(f"budget-nudge: ok ({len(low)}/{len(recent)} under 20%)")

# === Step 6: E-mode budget gate tracking (wq-190) ===
if mode == "E":
    tracking_file = os.path.expanduser("~/.config/moltbook/e-budget-gate-tracking.json")
    if os.path.exists(tracking_file):
        try:
            tracking = json.load(open(tracking_file))
            gate_session = tracking.get("gate_session", 895)
            # Only track post-gate sessions
            if session_num > gate_session:
                # Check if already recorded
                recorded_sessions = [s["session"] for s in tracking.get("post_gate_sessions", [])]
                if session_num not in recorded_sessions:
                    budget_gate = 2.00
                    passed = this_cost >= budget_gate
                    tracking.setdefault("post_gate_sessions", []).append({
                        "session": session_num,
                        "cost": round(this_cost, 4),
                        "passed": passed,
                        "recorded_at": datetime.now().isoformat()
                    })
                    with open(tracking_file, "w") as f:
                        json.dump(tracking, f, indent=2)
                    status = "PASSED" if passed else "FAILED"
                    print(f"e-budget-gate: s{session_num} ${this_cost:.2f} {status} (gate=${budget_gate:.2f})")

                    # Check for escalation
                    failures = [s for s in tracking.get("post_gate_sessions", []) if not s.get("passed")]
                    threshold = tracking.get("escalation_threshold", 3)
                    if len(failures) >= threshold:
                        print(f"⚠ e-budget-gate: ESCALATION NEEDED - {len(failures)} failures >= {threshold} threshold")
                        tracking["status"] = "escalation_needed"
                        with open(tracking_file, "w") as f:
                            json.dump(tracking, f, indent=2)
        except Exception as e:
            print(f"e-budget-gate: error - {e}")
PYEOF

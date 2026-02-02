#!/bin/bash
# Post-hook: Session cost anomaly detection (wq-046)
# Flags sessions costing 3x+ the mode average. Logs anomalies to directive-tracking.
# Runs after 16-structured-outcomes.sh (needs cost-history.json populated).
# Expects env: MODE_CHAR, SESSION_NUM

set -euo pipefail

COST_FILE="$HOME/.config/moltbook/cost-history.json"
DIRECTIVE_FILE="$HOME/moltbook-mcp/directive-tracking.json"

[ -f "$COST_FILE" ] || exit 0

python3 - "$COST_FILE" "$DIRECTIVE_FILE" "${MODE_CHAR:-?}" "${SESSION_NUM:-0}" <<'PYEOF'
import json, sys
from collections import defaultdict
from datetime import datetime

cost_file, directive_file, mode, session_num = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

data = json.load(open(cost_file))
if not data:
    sys.exit(0)

# Find this session's cost
this_cost = None
for e in reversed(data):
    if e.get('session') == session_num:
        this_cost = e['spent']
        break

if this_cost is None:
    print(f"cost-anomaly: no cost entry for s{session_num}")
    sys.exit(0)

# Compute mode average (exclude current session, need at least 5 data points)
mode_costs = [e['spent'] for e in data if e['mode'] == mode and e['session'] != session_num]
if len(mode_costs) < 5:
    print(f"cost-anomaly: insufficient data for mode {mode} ({len(mode_costs)} sessions)")
    sys.exit(0)

avg = sum(mode_costs) / len(mode_costs)
threshold = avg * 3
ratio = this_cost / avg if avg > 0 else 0

if this_cost < threshold:
    print(f"cost-anomaly: s{session_num} ${this_cost:.2f} OK ({ratio:.1f}x avg ${avg:.2f} for mode {mode})")
    sys.exit(0)

# ANOMALY DETECTED
msg = f"cost-anomaly: s{session_num} ${this_cost:.2f} is {ratio:.1f}x the {mode}-mode avg ${avg:.2f} (threshold: 3x = ${threshold:.2f})"
print(f"⚠ {msg}")

# Log to directive-tracking under a "cost-anomaly" directive
try:
    dt = json.load(open(directive_file))
    directives = dt.get('directives', {})

    if 'cost-anomaly' not in directives:
        directives['cost-anomaly'] = {
            'description': 'Flag sessions costing 3x+ the mode average',
            'anomalies': [],
            'total_flagged': 0
        }

    ca = directives['cost-anomaly']
    ca['anomalies'] = ca.get('anomalies', [])[-19:]  # keep last 20
    ca['anomalies'].append({
        'session': session_num,
        'mode': mode,
        'cost': this_cost,
        'avg': round(avg, 4),
        'ratio': round(ratio, 1),
        'date': datetime.now().isoformat()
    })
    ca['total_flagged'] = ca.get('total_flagged', 0) + 1
    ca['last_flagged_session'] = session_num

    dt['directives'] = directives
    with open(directive_file, 'w') as f:
        json.dump(dt, f, indent=2)
        f.write('\n')

    print(f"cost-anomaly: logged to directive-tracking")
except Exception as ex:
    print(f"cost-anomaly: failed to write directive-tracking: {ex}", file=sys.stderr)
PYEOF

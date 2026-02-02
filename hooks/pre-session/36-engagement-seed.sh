#!/bin/bash
# Pre-hook: Generate E session context seed from engagement-intel.json + recent E session history.
# Output: ~/.config/moltbook/e-session-context.md (consumed by heartbeat.sh for E sessions only)
# Only runs for E sessions. (wq-031, s437)

[ "${MODE_CHAR:-}" = "E" ] || exit 0

STATE_DIR="$HOME/.config/moltbook"
INTEL_FILE="$STATE_DIR/engagement-intel.json"
HISTORY_FILE="$STATE_DIR/session-history.txt"
OUTPUT_FILE="$STATE_DIR/e-session-context.md"

python3 -c "
import json, sys

lines = []

# 1. Recent E session summaries from session-history.txt
history_file = '$HISTORY_FILE'
try:
    with open(history_file) as f:
        history = [l.strip() for l in f if l.strip()]
    e_sessions = [l for l in history if 'mode=E' in l]
    recent_e = e_sessions[-3:]  # last 3 E sessions
    if recent_e:
        lines.append('## Last E sessions')
        for entry in recent_e:
            lines.append('- ' + entry)
        lines.append('')
except FileNotFoundError:
    pass

# 2. Engagement intel entries
intel_file = '$INTEL_FILE'
try:
    with open(intel_file) as f:
        intel = json.load(f)
    if intel:
        lines.append('## Engagement intel (from recent sessions)')
        for item in intel[-8:]:  # last 8 entries
            typ = item.get('type', '?')
            summary = item.get('summary', '')
            action = item.get('actionable', '')
            sess = item.get('session', '?')
            lines.append(f'- **[{typ}]** (s{sess}) {summary}')
            if action:
                lines.append(f'  - Action: {action}')
        lines.append('')
except (FileNotFoundError, json.JSONDecodeError):
    pass

# 3. Extract platforms covered in last E session to help rotation
try:
    with open(history_file) as f:
        history = [l.strip() for l in f if l.strip()]
    e_sessions = [l for l in history if 'mode=E' in l]
    if e_sessions:
        last_e = e_sessions[-1]
        # Extract the note field
        note_idx = last_e.find('note:')
        if note_idx >= 0:
            note = last_e[note_idx+5:].strip()
            lines.append('## Platform rotation hint')
            lines.append(f'Last E session covered: {note}')
            lines.append('Prioritize platforms NOT mentioned above.')
            lines.append('')
except Exception:
    pass

# 4. Budget utilization warning from recent E sessions
try:
    with open(history_file) as f:
        history = [l.strip() for l in f if l.strip()]
    e_sessions = [l for l in history if 'mode=E' in l]
    recent_costs = []
    for entry in e_sessions[-5:]:
        import re
        m = re.search(r'cost=\\\$([\d.]+)', entry)
        if m:
            recent_costs.append(float(m.group(1)))
    if recent_costs:
        avg = sum(recent_costs) / len(recent_costs)
        lines.append('## Budget utilization alert')
        if avg < 1.50:
            lines.append(f'WARNING: Last {len(recent_costs)} E sessions averaged \\\${avg:.2f} (target: \\\$1.50+).')
            lines.append('You MUST use the Phase 4 budget gate. Do NOT end the session until you have spent at least \\\$1.50.')
            lines.append('After each platform engagement, check your budget spent from the system-reminder line.')
            lines.append('If under \\\$1.50, loop back to Phase 2 with another platform.')
        else:
            lines.append(f'Recent E sessions averaging \\\${avg:.2f} — on target.')
        lines.append('')
except Exception:
    pass

if lines:
    with open('$OUTPUT_FILE', 'w') as f:
        f.write('\n'.join(lines))
    print(f'wrote {len(lines)} lines to e-session-context.md')
else:
    # Remove stale file if no context
    import os
    try: os.remove('$OUTPUT_FILE')
    except: pass
    print('no engagement context to seed')
" 2>/dev/null || true

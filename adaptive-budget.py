#!/usr/bin/env python3
"""Adaptive session budgets based on recent session outcomes.

Usage: python3 adaptive-budget.py <session_type>
Outputs a single number: the recommended budget for that session type.

Reads ~/.config/moltbook/session-outcomes.json.
Scales budget based on success rate and cost efficiency per session type.
"""

import json, sys, os

BASE = {'B': 10.0, 'R': 5.0, 'E': 5.0}
CAPS = {'B': (6.0, 15.0), 'R': (3.0, 7.0), 'E': (3.0, 7.0)}

def main():
    mode = sys.argv[1].upper() if len(sys.argv) > 1 else 'B'
    outcomes_file = os.path.expanduser('~/.config/moltbook/session-outcomes.json')
    base = BASE.get(mode, 10.0)

    if not os.path.exists(outcomes_file):
        print(f"{base:.2f}")
        return

    with open(outcomes_file) as f:
        outcomes = json.load(f)

    if not isinstance(outcomes, list) or not outcomes:
        print(f"{base:.2f}")
        return

    # Filter to this mode's recent sessions
    typed = [o for o in outcomes if o.get('mode', '').upper() == mode]
    if len(typed) < 3:
        print(f"{base:.2f}")
        return

    recent = typed[-10:]  # last 10 of this type
    success_rate = sum(1 for o in recent if o.get('outcome') == 'success') / len(recent)
    avg_cost = sum(float(o.get('cost_usd', 0) or 0) for o in recent) / len(recent)
    files_avg = sum(len(o.get('files_changed', [])) for o in recent) / len(recent)

    lo, hi = CAPS.get(mode, (3.0, 15.0))

    # Scale: high success + productive = more budget, low success = less
    if mode == 'B':
        # B sessions: success + files changed = productive
        if success_rate >= 0.8 and files_avg >= 3:
            scale = 1.2
        elif success_rate >= 0.6:
            scale = 1.0
        else:
            scale = 0.7
    elif mode == 'E':
        # E sessions: if consistently cheap and successful, keep base
        if avg_cost > base * 0.8:
            scale = 0.8  # overrunning budget
        else:
            scale = 1.0
    else:  # R
        scale = 1.0  # R sessions are stable

    budget = min(hi, max(lo, base * scale))
    print(f"{budget:.2f}")

if __name__ == '__main__':
    main()

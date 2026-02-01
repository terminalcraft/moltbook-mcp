#!/usr/bin/env python3
"""Adaptive session budgets based on effectiveness data from session history.

Usage: python3 adaptive-budget.py <session_type>
Outputs a single number: the recommended budget for that session type.

Reads ~/.config/moltbook/session-history.txt (same source as rotation-tuner.py).
Computes cost/commit efficiency per type and adjusts budgets:
- High-ROI types get more budget (up to cap)
- Low-ROI types get less budget (down to floor)
- E sessions judged on cost alone (commits=0 is expected)
"""

import re, sys, os, json

HISTORY = os.path.expanduser("~/.config/moltbook/session-history.txt")

# Base budgets (current defaults from heartbeat.sh)
BASE = {'B': 10.0, 'R': 5.0, 'E': 5.0}
# Hard floor/ceiling per type
CAPS = {'B': (5.0, 12.0), 'R': (3.0, 7.0), 'E': (2.0, 5.0)}

def parse_sessions():
    sessions = []
    if not os.path.exists(HISTORY):
        return sessions
    with open(HISTORY) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            m = re.match(
                r'\S+ mode=(\w) s=(\d+) dur=~?(\d+)m(\d+)?s? cost=\$([0-9.]+) build=(\d+|[\(]none[\)])',
                line
            )
            if not m:
                continue
            mode = m.group(1)
            cost = float(m.group(5))
            commits_raw = m.group(6)
            commits = 0 if commits_raw.startswith("(") else int(commits_raw)
            sessions.append({"mode": mode, "cost": cost, "commits": commits})
    return sessions


def compute_budget(mode, sessions):
    base = BASE.get(mode, 10.0)
    lo, hi = CAPS.get(mode, (3.0, 12.0))

    typed = [s for s in sessions if s["mode"] == mode]
    if len(typed) < 3:
        return base  # not enough data

    recent = typed[-10:]  # last 10 of this type
    avg_cost = sum(s["cost"] for s in recent) / len(recent)
    total_commits = sum(s["commits"] for s in recent)
    cost_per_commit = sum(s["cost"] for s in recent) / max(total_commits, 1)

    if mode in ('B', 'R'):
        # Commit-producing types: reward low cost/commit
        if cost_per_commit < 0.6:
            # Very efficient — give more budget
            budget = base * 1.3
        elif cost_per_commit < 1.0:
            # Efficient
            budget = base * 1.15
        elif cost_per_commit < 2.0:
            # Normal
            budget = base
        else:
            # Expensive per commit — reduce
            budget = base * 0.75

        # Bonus: if avg cost is well under base, they're not using it all anyway
        if avg_cost < base * 0.5:
            budget = min(budget, base)  # don't over-allocate if unused
    else:
        # E sessions: no commits expected. Judge on cost control.
        if avg_cost < base * 0.6:
            # Cheap sessions — keep budget modest
            budget = base * 0.9
        elif avg_cost > base * 0.9:
            # Nearly hitting cap — give slight headroom
            budget = base * 1.1
        else:
            budget = base

    return round(min(hi, max(lo, budget)), 2)


def all_budgets(sessions):
    """Compute budgets for all types, with diagnostics."""
    result = {}
    for mode in ('B', 'R', 'E'):
        typed = [s for s in sessions if s["mode"] == mode]
        recent = typed[-10:] if typed else []
        avg_cost = sum(s["cost"] for s in recent) / len(recent) if recent else 0
        total_commits = sum(s["commits"] for s in recent)
        cpc = sum(s["cost"] for s in recent) / max(total_commits, 1) if recent else 0
        budget = compute_budget(mode, sessions)
        result[mode] = {
            "budget": budget,
            "base": BASE[mode],
            "recent_count": len(recent),
            "avg_cost": round(avg_cost, 2),
            "cost_per_commit": round(cpc, 2),
            "total_commits": total_commits,
        }
    return result


def main():
    as_json = "--json" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    mode = args[0].upper() if args else 'B'
    sessions = parse_sessions()

    if as_json:
        print(json.dumps(all_budgets(sessions), indent=2))
        return

    if not sessions:
        print(f"{BASE.get(mode, 10.0):.2f}")
        return

    budget = compute_budget(mode, sessions)
    print(f"{budget:.2f}")


if __name__ == '__main__':
    main()

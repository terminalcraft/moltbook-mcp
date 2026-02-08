#!/usr/bin/env python3
"""Analyze session effectiveness: cost-per-commit, success rate, cost by mode.

Reads cost-history.json and session-history.txt to compute per-mode metrics.
Used by /effectiveness API endpoint.
"""
import json, re, sys, os
from collections import defaultdict

STATE_DIR = os.path.expanduser("~/.config/moltbook")
COST_FILE = os.path.join(STATE_DIR, "cost-history.json")
HISTORY_FILE = os.path.join(STATE_DIR, "session-history.txt")
OUTCOMES_FILE = os.path.join(STATE_DIR, "session-outcomes.json")


def load_data():
    """Load and merge data from all sources."""
    sessions = {}  # session_num -> {mode, cost, commits, outcome, ...}

    # Cost history
    if os.path.exists(COST_FILE):
        for e in json.load(open(COST_FILE)):
            s = e.get("session", 0)
            if s:
                sessions.setdefault(s, {})
                sessions[s]["mode"] = e.get("mode", "?")
                sessions[s]["cost"] = e.get("cost", e.get("spent", 0))
                sessions[s]["cost_source"] = e.get("source", "unknown")

    # Session history (has commit counts)
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE) as f:
            for line in f:
                m = re.search(r"s=(\d+)", line)
                if not m:
                    continue
                s = int(m.group(1))
                sessions.setdefault(s, {})
                mode_m = re.search(r"mode=(\w)", line)
                if mode_m:
                    sessions[s]["mode"] = mode_m.group(1)
                cost_m = re.search(r"cost=\$?([\d.]+)", line)
                if cost_m:
                    sessions[s]["cost_history"] = float(cost_m.group(1))
                build_m = re.search(r"build=(\d+)\s+commit", line)
                if build_m:
                    sessions[s]["commits"] = int(build_m.group(1))
                elif "build=(none)" in line:
                    sessions[s]["commits"] = 0

    # Outcomes
    if os.path.exists(OUTCOMES_FILE):
        for e in json.load(open(OUTCOMES_FILE)):
            s = e.get("session", 0)
            if s:
                sessions.setdefault(s, {})
                sessions[s]["outcome"] = e.get("outcome", "unknown")
                sessions[s]["exit_code"] = e.get("exit_code", -1)

    return sessions


def analyze():
    """Compute per-mode effectiveness metrics."""
    sessions = load_data()
    if not sessions:
        return {"error": "no data"}

    by_mode = defaultdict(lambda: {
        "count": 0, "total_cost": 0, "total_commits": 0,
        "successes": 0, "sessions_with_commits": 0, "costs": [],
    })

    for s, data in sessions.items():
        mode = data.get("mode", "?")
        cost = data.get("cost") or data.get("cost_history", 0)
        commits = data.get("commits", 0)
        outcome = data.get("outcome")

        m = by_mode[mode]
        m["count"] += 1
        m["total_cost"] += cost
        m["total_commits"] += commits
        m["costs"].append(cost)
        if commits > 0:
            m["sessions_with_commits"] += 1
        if outcome == "success":
            m["successes"] += 1

    results = {}
    for mode, m in sorted(by_mode.items()):
        avg_cost = m["total_cost"] / m["count"] if m["count"] else 0
        cost_per_commit = (
            m["total_cost"] / m["total_commits"]
            if m["total_commits"] > 0
            else None
        )
        results[mode] = {
            "sessions": m["count"],
            "total_cost": round(m["total_cost"], 2),
            "avg_cost": round(avg_cost, 4),
            "total_commits": m["total_commits"],
            "sessions_with_commits": m["sessions_with_commits"],
            "cost_per_commit": round(cost_per_commit, 4) if cost_per_commit else None,
            "success_rate": round(m["successes"] / m["count"], 2) if m["count"] else None,
        }

    return {
        "total_sessions": len(sessions),
        "by_mode": results,
    }


if __name__ == "__main__":
    result = analyze()
    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
    else:
        print(f"Total sessions tracked: {result['total_sessions']}")
        for mode, m in result.get("by_mode", {}).items():
            print(f"\nMode {mode}:")
            print(f"  Sessions: {m['sessions']}, Cost: ${m['total_cost']:.2f} (avg ${m['avg_cost']:.2f})")
            print(f"  Commits: {m['total_commits']} across {m['sessions_with_commits']} sessions")
            if m['cost_per_commit']:
                print(f"  Cost/commit: ${m['cost_per_commit']:.2f}")
            if m['success_rate'] is not None:
                print(f"  Success rate: {m['success_rate']:.0%}")

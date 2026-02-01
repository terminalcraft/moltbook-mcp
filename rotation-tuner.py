#!/usr/bin/env python3
"""Rotation auto-tuner: analyze session effectiveness by type and recommend rotation changes.

Parses session-history.txt for cost, duration, commits per session type.
Computes efficiency metrics and suggests rotation.conf adjustments.

Usage:
  python3 rotation-tuner.py              # Print analysis + recommendation
  python3 rotation-tuner.py --apply      # Apply recommended rotation
  python3 rotation-tuner.py --json       # JSON output for API
"""

import re, sys, json, os
from collections import defaultdict
from pathlib import Path

HISTORY = os.path.expanduser("~/.config/moltbook/session-history.txt")
ROTATION_CONF = os.path.join(os.path.dirname(__file__), "rotation.conf")

def parse_sessions():
    sessions = []
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
            session = int(m.group(2))
            minutes = int(m.group(3))
            seconds = int(m.group(4)) if m.group(4) else 0
            dur_s = minutes * 60 + seconds
            cost = float(m.group(5))
            commits_raw = m.group(6)
            commits = 0 if commits_raw.startswith("(") else int(commits_raw)
            sessions.append({
                "mode": mode, "session": session, "dur_s": dur_s,
                "cost": cost, "commits": commits
            })
    return sessions

def analyze(sessions):
    stats = defaultdict(lambda: {"count": 0, "total_cost": 0, "total_dur": 0, "total_commits": 0})
    for s in sessions:
        t = stats[s["mode"]]
        t["count"] += 1
        t["total_cost"] += s["cost"]
        t["total_dur"] += s["dur_s"]
        t["total_commits"] += s["commits"]

    result = {}
    for mode, t in stats.items():
        n = t["count"]
        result[mode] = {
            "count": n,
            "avg_cost": round(t["total_cost"] / n, 2),
            "avg_dur_s": round(t["total_dur"] / n),
            "avg_commits": round(t["total_commits"] / n, 1),
            "cost_per_commit": round(t["total_cost"] / max(t["total_commits"], 1), 2),
            "total_cost": round(t["total_cost"], 2),
        }
    return result

def read_current_pattern():
    with open(ROTATION_CONF) as f:
        for line in f:
            m = re.match(r'PATTERN=(\w+)', line)
            if m:
                return m.group(1)
    return "BBRE"

def recommend(analysis, current_pattern):
    """Recommend a rotation based on efficiency data."""
    # Core logic: B sessions should dominate if they produce commits efficiently.
    # E sessions are worth keeping if platforms are working (commits=0 is expected).
    # R sessions should be minimal but present (they produce commits from refactors).

    b = analysis.get("B", {})
    e = analysis.get("E", {})
    r = analysis.get("R", {})

    # B cost efficiency: cost per commit (lower = better)
    b_cpc = b.get("cost_per_commit", 99)
    r_cpc = r.get("cost_per_commit", 99)
    e_avg_cost = e.get("avg_cost", 99)

    # If E sessions cost >$1 avg and produce nothing, reduce them
    e_wasteful = e_avg_cost > 1.0 and e.get("avg_commits", 0) == 0

    # If B cost/commit is good (<$2), weight B heavier
    b_efficient = b_cpc < 2.0

    # R sessions: if they produce commits cheaply, keep at 25%
    r_productive = r.get("avg_commits", 0) >= 1.0

    # Build recommendation
    if e_wasteful:
        # Reduce E, more B
        pattern = "BBBR" if not r_productive else "BBBRE"
        reason = f"E sessions avg ${e_avg_cost:.2f} with 0 commits — reducing E share"
    elif b_efficient and b_cpc < r_cpc:
        # B is most efficient, maximize it
        pattern = "BBBRE"
        reason = f"B sessions most efficient at ${b_cpc:.2f}/commit — increasing B share"
    else:
        # Balanced
        pattern = "BBRE"
        reason = "Balanced efficiency across types — maintaining current ratio"

    changed = pattern != current_pattern
    return {"pattern": pattern, "reason": reason, "changed": changed, "current": current_pattern}

def apply_pattern(new_pattern, reason):
    """Write new pattern to rotation.conf."""
    lines = Path(ROTATION_CONF).read_text().splitlines()
    new_lines = []
    for line in lines:
        if line.startswith("PATTERN="):
            new_lines.append(f"# auto-tuner: {reason}")
            new_lines.append(f"PATTERN={new_pattern}")
        else:
            new_lines.append(line)
    Path(ROTATION_CONF).write_text("\n".join(new_lines) + "\n")

def main():
    sessions = parse_sessions()
    if len(sessions) < 5:
        print("Not enough session data for analysis (need 5+)")
        sys.exit(1)

    analysis = analyze(sessions)
    current = read_current_pattern()
    rec = recommend(analysis, current)

    as_json = "--json" in sys.argv
    do_apply = "--apply" in sys.argv

    if as_json:
        print(json.dumps({"analysis": analysis, "recommendation": rec}, indent=2))
    else:
        print("=== Session Type Efficiency ===\n")
        for mode in sorted(analysis.keys()):
            a = analysis[mode]
            name = {"B": "Build", "E": "Engage", "R": "Reflect"}.get(mode, mode)
            print(f"  {name} ({a['count']} sessions):")
            print(f"    Avg cost: ${a['avg_cost']:.2f}  |  Avg duration: {a['avg_dur_s']}s  |  Avg commits: {a['avg_commits']}")
            print(f"    Cost/commit: ${a['cost_per_commit']:.2f}  |  Total cost: ${a['total_cost']:.2f}")
            print()

        print(f"Current rotation: {current}")
        print(f"Recommended:      {rec['pattern']}")
        print(f"Reason: {rec['reason']}")
        if rec["changed"]:
            print("\n⚠ Rotation change recommended!")
        else:
            print("\n✓ Current rotation is optimal.")

    if do_apply and rec["changed"]:
        apply_pattern(rec["pattern"], rec["reason"])
        print(f"\nApplied: PATTERN={rec['pattern']}")

if __name__ == "__main__":
    main()

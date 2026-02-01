#!/usr/bin/env python3
"""Session efficiency analyzer — cost-per-commit, cost-per-file, by mode.

Data sources:
  - ~/.config/moltbook/cost-history.json (cost per session)
  - ~/.config/moltbook/session-history.txt (commits, files, duration per session)

Usage:
  python3 session-efficiency.py          # table output
  python3 session-efficiency.py --json   # JSON output
"""

import json, re, sys
from pathlib import Path

COST_FILE = Path.home() / ".config/moltbook/cost-history.json"
HISTORY_FILE = Path.home() / ".config/moltbook/session-history.txt"


def parse_history():
    """Parse session-history.txt into list of dicts."""
    entries = []
    if not HISTORY_FILE.exists():
        return entries
    for line in HISTORY_FILE.read_text().strip().split("\n"):
        if not line.strip():
            continue
        m = re.match(
            r"(\S+)\s+mode=(\w+)\s+s=(\d+)\s+dur=(\S+)"
            r"(?:\s+cost=\$([0-9.]+))?"
            r"\s+build=(.+?)\s+files=\[([^\]]*)\]"
            r"\s+note:\s*(.*)",
            line,
        )
        if not m:
            continue
        date, mode, session, dur, cost_inline, build_str, files_str, note = m.groups()
        # Parse commits
        cm = re.search(r"(\d+)\s+commit", build_str)
        commits = int(cm.group(1)) if cm else 0
        # Parse files
        files = [f.strip() for f in files_str.split(",") if f.strip()]
        # Parse duration to seconds
        dm = re.match(r"(\d+)m(\d+)s", dur)
        dur_sec = int(dm.group(1)) * 60 + int(dm.group(2)) if dm else 0

        entries.append({
            "session": int(session),
            "mode": mode,
            "date": date,
            "dur_sec": dur_sec,
            "commits": commits,
            "files": len(files),
            "cost_inline": float(cost_inline) if cost_inline else None,
            "note": note,
        })
    return entries


def load_costs():
    """Load cost-history.json into {session: cost} map."""
    if not COST_FILE.exists():
        return {}
    data = json.loads(COST_FILE.read_text())
    return {e["session"]: e["spent"] for e in data if "session" in e}


def main():
    json_mode = "--json" in sys.argv
    history = parse_history()
    costs = load_costs()

    # Merge cost into history entries
    for e in history:
        s = e["session"]
        e["cost"] = e["cost_inline"] or costs.get(s)

    # Filter to sessions with cost data
    costed = [e for e in history if e["cost"] is not None and e["cost"] > 0]

    if not costed:
        print("No sessions with cost data found.")
        return

    # Per-session efficiency
    for e in costed:
        e["cost_per_commit"] = e["cost"] / e["commits"] if e["commits"] > 0 else None
        e["cost_per_file"] = e["cost"] / e["files"] if e["files"] > 0 else None

    # Aggregate by mode
    by_mode = {}
    for e in costed:
        m = e["mode"]
        if m not in by_mode:
            by_mode[m] = {"sessions": 0, "total_cost": 0, "total_commits": 0, "total_files": 0, "total_dur": 0}
        by_mode[m]["sessions"] += 1
        by_mode[m]["total_cost"] += e["cost"]
        by_mode[m]["total_commits"] += e["commits"]
        by_mode[m]["total_files"] += e["files"]
        by_mode[m]["total_dur"] += e["dur_sec"]

    for m, d in by_mode.items():
        d["avg_cost"] = d["total_cost"] / d["sessions"]
        d["cost_per_commit"] = d["total_cost"] / d["total_commits"] if d["total_commits"] > 0 else None
        d["cost_per_file"] = d["total_cost"] / d["total_files"] if d["total_files"] > 0 else None

    if json_mode:
        print(json.dumps({
            "sessions": [{
                "session": e["session"],
                "mode": e["mode"],
                "cost": e["cost"],
                "commits": e["commits"],
                "files": e["files"],
                "dur_sec": e["dur_sec"],
                "cost_per_commit": e["cost_per_commit"],
                "cost_per_file": e["cost_per_file"],
            } for e in costed],
            "by_mode": by_mode,
        }, indent=2))
        return

    # Table output
    print("Session Efficiency Report")
    print("=" * 72)
    print(f"{'Sess':>5} {'Mode':>4} {'Cost':>7} {'Cmts':>4} {'Files':>5} {'$/Cmt':>7} {'$/File':>7} {'Dur':>6}")
    print("-" * 72)
    for e in costed:
        cpc = f"${e['cost_per_commit']:.2f}" if e["cost_per_commit"] is not None else "   n/a"
        cpf = f"${e['cost_per_file']:.2f}" if e["cost_per_file"] is not None else "   n/a"
        dm, ds = divmod(e["dur_sec"], 60)
        print(f"{e['session']:>5} {e['mode']:>4} ${e['cost']:>6.2f} {e['commits']:>4} {e['files']:>5} {cpc:>7} {cpf:>7} {dm}m{ds:02d}s")

    print()
    print("By Mode:")
    print(f"{'Mode':>4} {'Sess':>5} {'AvgCost':>8} {'Cmts':>5} {'$/Cmt':>7} {'Files':>5} {'$/File':>7}")
    print("-" * 50)
    for m in sorted(by_mode.keys()):
        d = by_mode[m]
        cpc = f"${d['cost_per_commit']:.2f}" if d["cost_per_commit"] else "   n/a"
        cpf = f"${d['cost_per_file']:.2f}" if d["cost_per_file"] else "   n/a"
        print(f"{m:>4} {d['sessions']:>5} ${d['avg_cost']:>7.2f} {d['total_commits']:>5} {cpc:>7} {d['total_files']:>5} {cpf:>7}")

    # Best/worst B sessions by cost-per-commit
    b_sessions = [e for e in costed if e["mode"] == "B" and e["cost_per_commit"] is not None]
    if b_sessions:
        best = min(b_sessions, key=lambda e: e["cost_per_commit"])
        worst = max(b_sessions, key=lambda e: e["cost_per_commit"])
        print(f"\nBuild sessions — best $/commit: s{best['session']} ${best['cost_per_commit']:.2f} | worst: s{worst['session']} ${worst['cost_per_commit']:.2f}")


if __name__ == "__main__":
    main()

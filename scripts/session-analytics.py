#!/usr/bin/env python3
"""Session analytics — productivity trends from outcomes.log + session-history.txt.

Usage:
  python3 session-analytics.py              # full report
  python3 session-analytics.py --json       # JSON output for tooling
  python3 session-analytics.py --last N     # only last N sessions
"""
import sys, os, re, json
from collections import Counter, defaultdict
from datetime import datetime, timedelta

STATE_DIR = os.path.expanduser("~/.config/moltbook")
OUTCOMES_FILE = os.path.join(STATE_DIR, "logs/outcomes.log")
HISTORY_FILE = os.path.join(STATE_DIR, "session-history.txt")

def parse_outcomes():
    """Parse outcomes.log into list of dicts."""
    if not os.path.exists(OUTCOMES_FILE):
        return []
    results = []
    for line in open(OUTCOMES_FILE):
        line = line.strip()
        if not line:
            continue
        m = re.match(r'(\S+)\s+(\w)\s+s=(\d+)\s+exit=(\d+)\s+outcome=(\w+)\s+dur=(\d+)s', line)
        if m:
            results.append({
                "ts": m.group(1), "mode": m.group(2), "session": int(m.group(3)),
                "exit": int(m.group(4)), "outcome": m.group(5), "dur": int(m.group(6))
            })
    return results

def parse_history():
    """Parse session-history.txt into list of dicts."""
    if not os.path.exists(HISTORY_FILE):
        return []
    results = []
    for line in open(HISTORY_FILE):
        line = line.strip()
        if not line:
            continue
        m_mode = re.search(r'mode=(\w)', line)
        m_session = re.search(r's=(\d+)', line)
        m_dur = re.search(r'dur=(\S+)', line)
        m_build = re.search(r'build=(.+?)\s+files=', line)
        m_cost = re.search(r'cost=\$?([\d.]+)', line)
        m_commits = re.search(r'build=(\d+)\s+commit', line)
        results.append({
            "mode": m_mode.group(1) if m_mode else "?",
            "session": int(m_session.group(1)) if m_session else 0,
            "dur": m_dur.group(1) if m_dur else "?",
            "cost": float(m_cost.group(1)) if m_cost else None,
            "commits": int(m_commits.group(1)) if m_commits else 0,
        })
    return results

def analyze(outcomes, history, last_n=None):
    if last_n:
        outcomes = outcomes[-last_n:]
        history = history[-last_n:]

    report = {}

    # Mode distribution
    mode_counts = Counter(o["mode"] for o in outcomes)
    report["mode_distribution"] = dict(mode_counts)

    # Outcome distribution
    outcome_counts = Counter(o["outcome"] for o in outcomes)
    report["outcomes"] = dict(outcome_counts)

    # Duration stats by mode
    dur_by_mode = defaultdict(list)
    for o in outcomes:
        dur_by_mode[o["mode"]].append(o["dur"])

    report["avg_duration_by_mode"] = {}
    for mode, durs in sorted(dur_by_mode.items()):
        avg = sum(durs) / len(durs)
        report["avg_duration_by_mode"][mode] = {
            "avg_sec": round(avg),
            "min_sec": min(durs),
            "max_sec": max(durs),
            "count": len(durs),
        }

    # Commits from history
    total_commits = sum(h["commits"] for h in history)
    b_sessions = [h for h in history if h["mode"] == "B"]
    b_with_commits = [h for h in b_sessions if h["commits"] > 0]
    report["build_productivity"] = {
        "total_commits": total_commits,
        "b_sessions": len(b_sessions),
        "b_sessions_with_commits": len(b_with_commits),
        "commit_rate": round(total_commits / max(len(b_sessions), 1), 1),
    }

    # Cost tracking — merge history costs with cost-history.json
    cost_map = {}
    for h in history:
        if h["cost"] is not None:
            cost_map[h["session"]] = h["cost"]
    cost_file = os.path.join(STATE_DIR, "cost-history.json")
    if os.path.exists(cost_file):
        try:
            for entry in json.load(open(cost_file)):
                s = entry.get("session", 0)
                if s and s not in cost_map:
                    cost_map[s] = entry.get("spent", 0)
        except (json.JSONDecodeError, KeyError):
            pass
    costs = list(cost_map.values())
    if costs:
        by_mode = {}
        for h in history:
            s = h["session"]
            if s in cost_map:
                mode = h["mode"]
                by_mode.setdefault(mode, []).append(cost_map[s])
        report["cost"] = {
            "total": round(sum(costs), 2),
            "avg": round(sum(costs) / len(costs), 2),
            "sessions_tracked": len(costs),
            "by_mode": {m: {"avg": round(sum(c)/len(c), 2), "total": round(sum(c), 2), "n": len(c)} for m, c in sorted(by_mode.items())},
        }

    # Session gaps
    sessions = sorted(set(o["session"] for o in outcomes))
    gaps = []
    for i in range(1, len(sessions)):
        if sessions[i] - sessions[i-1] > 1:
            gaps.append(f"{sessions[i-1]+1}-{sessions[i]-1}")
    report["session_gaps"] = gaps if gaps else "none"

    # Recent velocity (last 10 B sessions)
    recent_b = [h for h in history if h["mode"] == "B"][-10:]
    if recent_b:
        report["recent_velocity"] = {
            "last_10_b_commits": sum(h["commits"] for h in recent_b),
            "sessions": len(recent_b),
        }

    return report

def format_report(report):
    lines = ["=== Session Analytics ===", ""]

    lines.append("Mode distribution:")
    for mode, count in sorted(report.get("mode_distribution", {}).items()):
        lines.append(f"  {mode}: {count}")

    lines.append("")
    lines.append("Outcomes:")
    for outcome, count in sorted(report.get("outcomes", {}).items()):
        lines.append(f"  {outcome}: {count}")

    lines.append("")
    lines.append("Avg duration by mode:")
    for mode, stats in sorted(report.get("avg_duration_by_mode", {}).items()):
        lines.append(f"  {mode}: {stats['avg_sec']}s avg ({stats['min_sec']}-{stats['max_sec']}s, n={stats['count']})")

    bp = report.get("build_productivity", {})
    lines.append("")
    lines.append(f"Build productivity: {bp.get('total_commits', 0)} commits across {bp.get('b_sessions', 0)} B sessions ({bp.get('commit_rate', 0)} commits/session)")
    lines.append(f"  Sessions with commits: {bp.get('b_sessions_with_commits', 0)}/{bp.get('b_sessions', 0)}")

    if "cost" in report:
        c = report["cost"]
        lines.append("")
        lines.append(f"Cost: ${c['total']} total, ${c['avg']} avg ({c['sessions_tracked']} tracked)")
        for mode, mc in sorted(c.get("by_mode", {}).items()):
            lines.append(f"  {mode}: ${mc['avg']} avg, ${mc['total']} total (n={mc['n']})")

    rv = report.get("recent_velocity", {})
    if rv:
        lines.append("")
        lines.append(f"Recent velocity (last 10 B): {rv.get('last_10_b_commits', 0)} commits in {rv.get('sessions', 0)} sessions")

    gaps = report.get("session_gaps", "none")
    if gaps != "none":
        lines.append("")
        lines.append(f"Session gaps: {', '.join(gaps)}")

    return "\n".join(lines)


if __name__ == "__main__":
    args = sys.argv[1:]
    as_json = "--json" in args
    last_n = None
    if "--last" in args:
        idx = args.index("--last")
        if idx + 1 < len(args):
            last_n = int(args[idx + 1])

    outcomes = parse_outcomes()
    history = parse_history()
    report = analyze(outcomes, history, last_n)

    if as_json:
        print(json.dumps(report, indent=2))
    else:
        print(format_report(report))

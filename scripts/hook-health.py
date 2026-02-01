#!/usr/bin/env python3
"""Check post-session hook health — detect hooks failing silently.

Parses hooks.log to find hooks that consistently fail or timeout.

Usage:
  python3 hook-health.py              # human report
  python3 hook-health.py --json       # JSON output
"""
import os, re, sys, json
from collections import defaultdict
from datetime import datetime

HOOKS_LOG = os.path.expanduser("~/.config/moltbook/logs/hooks.log")


def parse_hooks_log():
    if not os.path.exists(HOOKS_LOG):
        return []
    entries = []
    for line in open(HOOKS_LOG):
        line = line.strip()
        if not line:
            continue
        m_run = re.match(r'(\S+)\s+running hook:\s+(\S+)', line)
        m_fail = re.match(r'(\S+)\s+hook FAILED:\s+(\S+)', line)
        if m_run:
            entries.append({"ts": m_run.group(1), "hook": m_run.group(2), "event": "run"})
        elif m_fail:
            entries.append({"ts": m_fail.group(1), "hook": m_fail.group(2), "event": "fail"})
    return entries


def analyze(entries, last_n=50):
    # Group into runs: each "run" followed optionally by "fail"
    hooks = defaultdict(lambda: {"runs": 0, "fails": 0, "last_run": None, "last_fail": None, "recent_fails": 0})

    # Track last N run events per hook
    recent_window = []
    for e in entries:
        if e["event"] == "run":
            recent_window.append(e)

    recent_window = recent_window[-last_n * 10:]  # rough limit

    # Match runs to fails (fail always follows its run at same timestamp)
    i = 0
    while i < len(entries):
        e = entries[i]
        if e["event"] == "run":
            hook = e["hook"]
            hooks[hook]["runs"] += 1
            hooks[hook]["last_run"] = e["ts"]
            # Check if next entry is a fail for same hook
            if i + 1 < len(entries) and entries[i + 1]["event"] == "fail" and entries[i + 1]["hook"] == hook:
                hooks[hook]["fails"] += 1
                hooks[hook]["last_fail"] = entries[i + 1]["ts"]
                i += 2
                continue
        i += 1

    # Count recent fails (last 20 runs per hook)
    recent_runs = defaultdict(list)
    i = 0
    while i < len(entries):
        e = entries[i]
        if e["event"] == "run":
            failed = (i + 1 < len(entries) and entries[i + 1]["event"] == "fail" and entries[i + 1]["hook"] == e["hook"])
            recent_runs[e["hook"]].append(failed)
            if failed:
                i += 2
                continue
        i += 1

    for hook, runs in recent_runs.items():
        last_20 = runs[-20:]
        hooks[hook]["recent_fails"] = sum(1 for r in last_20 if r)
        hooks[hook]["recent_total"] = len(last_20)

    return dict(hooks)


def format_report(hooks):
    lines = ["=== Hook Health Report ===", ""]
    for name, stats in sorted(hooks.items()):
        fail_rate = stats["fails"] / max(stats["runs"], 1) * 100
        recent = stats.get("recent_fails", 0)
        recent_total = stats.get("recent_total", 0)
        status = "OK" if recent == 0 else ("WARN" if recent < 5 else "FAILING")
        lines.append(f"  {status:7s} {name}: {stats['runs']} runs, {stats['fails']} fails ({fail_rate:.0f}%), recent {recent}/{recent_total}")
        if stats["last_fail"]:
            lines.append(f"          last fail: {stats['last_fail']}")
    return "\n".join(lines)


if __name__ == "__main__":
    entries = parse_hooks_log()
    hooks = analyze(entries)
    if "--json" in sys.argv:
        print(json.dumps(hooks, indent=2))
    else:
        print(format_report(hooks))

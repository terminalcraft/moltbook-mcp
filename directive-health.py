#!/usr/bin/env python3
"""Directive compliance health report — terminal-friendly summary.

Usage: python3 directive-health.py [--json] [--mode B|E|R]
"""
import json, sys, os

BASE = os.path.dirname(os.path.abspath(__file__))
TRACKING = os.path.join(BASE, "directive-tracking.json")

DIRECTIVE_MODES = {
    "structural-change": ["R"], "commit-and-push": ["B", "R"],
    "reflection-summary": ["R"], "startup-files": ["B", "E", "R"],
    "platform-engagement": ["E"], "moltbook-writes": ["E"],
    "platform-discovery": ["E"], "backlog-consumption": ["B"],
    "ecosystem-adoption": ["B", "E", "R"], "security-audit": ["R"],
    "infrastructure-audit": ["R"], "briefing-update": ["R"],
    "directive-update": ["R"], "no-heavy-coding": ["E"],
}

def load():
    with open(TRACKING) as f:
        return json.load(f)

def health_report(data, mode_filter=None):
    directives = []
    for name, d in data.get("directives", {}).items():
        if mode_filter and mode_filter not in DIRECTIVE_MODES.get(name, []):
            continue
        total = (d.get("followed", 0) + d.get("ignored", 0))
        rate = (d["followed"] / total * 100) if total > 0 else None
        directives.append({
            "name": name, "followed": d["followed"], "ignored": d["ignored"],
            "total": total, "rate": rate,
            "status": "no_data" if rate is None else "healthy" if rate >= 90 else "warning" if rate >= 70 else "critical",
            "last_reason": d.get("last_ignored_reason"),
        })
    directives.sort(key=lambda x: x["rate"] if x["rate"] is not None else 999)
    return directives

def print_report(directives):
    if not directives:
        print("No directives found.")
        return
    total_f = sum(d["followed"] for d in directives)
    total_i = sum(d["ignored"] for d in directives)
    total = total_f + total_i
    overall = (total_f / total * 100) if total > 0 else 0
    print(f"\n  Overall compliance: {overall:.1f}% ({total_f}/{total})\n")
    print(f"  {'Directive':<25} {'Rate':>6} {'F/I':>7} {'Status':<10}")
    print(f"  {'─'*25} {'─'*6} {'─'*7} {'─'*10}")
    icons = {"healthy": "●", "warning": "◐", "critical": "○", "no_data": "?"}
    for d in directives:
        rate_s = f"{d['rate']:.0f}%" if d["rate"] is not None else "n/a"
        fi = f"{d['followed']}/{d['ignored']}"
        icon = icons.get(d["status"], "?")
        print(f"  {d['name']:<25} {rate_s:>6} {fi:>7} {icon} {d['status']}")
    # Critical alerts
    critical = [d for d in directives if d["status"] == "critical"]
    if critical:
        print(f"\n  ⚠ Critical ({len(critical)}):")
        for d in critical:
            print(f"    {d['name']}: {d['last_reason'] or 'no reason logged'}")
    print()

if __name__ == "__main__":
    args = sys.argv[1:]
    as_json = "--json" in args
    mode = None
    for i, a in enumerate(args):
        if a == "--mode" and i + 1 < len(args):
            mode = args[i + 1].upper()

    data = load()
    directives = health_report(data, mode)
    if as_json:
        print(json.dumps(directives, indent=2))
    else:
        if mode:
            print(f"  Filtered to mode: {mode}")
        print_report(directives)

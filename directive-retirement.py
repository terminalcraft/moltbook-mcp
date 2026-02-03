#!/usr/bin/env python3
"""Directive auto-retirement — flag long-pending or stale directives for R session review.

Analyzes directives.json and flags directives that have been pending too long
or have gone stale without progress. Outputs flagged directives as JSON for
R sessions to act on.

Usage:
  python3 directive-retirement.py [--days 30] [--json]

Note: Updated in B#175 to use directives.json instead of removed directive-tracking.json.
The old follow-rate tracking was removed during migration to directives.json.
"""

import json, argparse, sys
from datetime import datetime, timezone
from pathlib import Path

DIRECTIVES_FILE = Path(__file__).parent / "directives.json"

def analyze_directives(stale_days=30):
    if not DIRECTIVES_FILE.exists():
        return {"directives": [], "flagged": [], "error": "directives.json not found"}

    with open(DIRECTIVES_FILE) as f:
        data = json.load(f)

    directives = data.get("directives", [])
    now = datetime.now(timezone.utc)

    results = []
    for d in directives:
        did = d.get("id", "?")
        status = d.get("status", "unknown")

        # Skip completed/retired
        if status in ("completed", "retired"):
            continue

        # Calculate age
        created_str = d.get("created") or d.get("session")
        if isinstance(created_str, str):
            try:
                created = datetime.fromisoformat(created_str.replace("Z", "+00:00"))
                age_days = (now - created).days
            except:
                age_days = 0
        else:
            age_days = 0

        # Check for ack
        acked = d.get("acked_session") is not None

        entry = {
            "id": did,
            "status": status,
            "age_days": age_days,
            "acked": acked,
            "content": (d.get("content", "")[:80] + "..." if len(d.get("content", "")) > 80 else d.get("content", "")),
        }

        # Flag for retirement if stale
        if status == "pending" and not acked and age_days > stale_days:
            entry["flag"] = "retire"
            entry["reason"] = f"Pending {age_days} days without acknowledgment"
        elif status == "active" and age_days > stale_days * 3:
            entry["flag"] = "warning"
            entry["reason"] = f"Active for {age_days} days — may need completion or deferral"
        elif status == "deferred" and age_days > stale_days * 2:
            entry["flag"] = "warning"
            entry["reason"] = f"Deferred for {age_days} days — review if still needed"
        else:
            entry["flag"] = "healthy"

        results.append(entry)

    results.sort(key=lambda x: -x["age_days"])
    flagged = [r for r in results if r["flag"] in ("retire", "warning")]
    return {"directives": results, "flagged": flagged, "stale_days": stale_days}

def main():
    parser = argparse.ArgumentParser(description="Directive auto-retirement analysis")
    parser.add_argument("--days", type=int, default=30, help="Days after which unacked pending directives are flagged (default 30)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    result = analyze_directives(args.days)

    if "error" in result:
        print(f"Error: {result['error']}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(result, indent=2))
        return

    print(f"Directive Health Report (stale_days={args.days})\n")
    print(f"  {'Directive':<10} {'Status':<10} {'Age':>6} {'Acked':<6} {'Flag':<8}")
    print(f"  {'-'*10} {'-'*10} {'-'*6} {'-'*6} {'-'*8}")
    for d in result["directives"]:
        flag_str = "RETIRE" if d["flag"] == "retire" else ("WARN" if d["flag"] == "warning" else "OK")
        print(f"  {d['id']:<10} {d['status']:<10} {d['age_days']:>5}d {'yes' if d['acked'] else 'no':<6} {flag_str:<8}")

    if result["flagged"]:
        print(f"\nFlagged for R session review:")
        for d in result["flagged"]:
            print(f"  - {d['id']}: {d['reason']}")

if __name__ == "__main__":
    main()

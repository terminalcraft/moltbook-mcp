#!/usr/bin/env python3
"""Directive auto-retirement — flag low-follow-rate directives for R session review.

Analyzes directive-tracking.json and flags directives whose follow rate drops
below a threshold over sufficient evaluations. Outputs flagged directives as
JSON for R sessions to act on.

Usage:
  python3 directive-retirement.py [--threshold 30] [--min-evals 10] [--json]
"""

import json, argparse, sys
from pathlib import Path

TRACKING_FILE = Path(__file__).parent / "directive-tracking.json"

def analyze_directives(threshold=30, min_evals=10):
    with open(TRACKING_FILE) as f:
        data = json.load(f)

    directives = data.get("directives", {})
    retired = []
    for key in ["retired_s411", "retired_s415"]:
        retired.extend(data.get(key, []))

    results = []
    for did, info in directives.items():
        if did in retired:
            continue
        followed = info.get("followed", 0)
        ignored = info.get("ignored", 0)
        total = followed + ignored
        if total == 0:
            continue

        rate = (followed / total) * 100
        history = info.get("history", [])

        # Recent trend: last 5 evaluations
        recent = history[-5:] if history else []
        recent_followed = sum(1 for h in recent if h.get("result") == "followed")
        recent_rate = (recent_followed / len(recent) * 100) if recent else rate

        entry = {
            "id": did,
            "followed": followed,
            "ignored": ignored,
            "total_evals": total,
            "follow_rate": round(rate, 1),
            "recent_rate": round(recent_rate, 1),
            "trend": "improving" if recent_rate > rate else ("declining" if recent_rate < rate else "stable"),
            "last_session": info.get("last_session", 0),
        }

        # Flag for retirement if below threshold with enough data
        if total >= min_evals and rate < threshold:
            entry["flag"] = "retire"
            entry["reason"] = f"Follow rate {rate:.0f}% < {threshold}% over {total} evaluations"
        elif total >= min_evals and rate < threshold + 15:
            entry["flag"] = "warning"
            entry["reason"] = f"Follow rate {rate:.0f}% approaching retirement threshold ({threshold}%)"
        else:
            entry["flag"] = "healthy"

        results.append(entry)

    results.sort(key=lambda x: x["follow_rate"])
    flagged = [r for r in results if r["flag"] in ("retire", "warning")]
    return {"directives": results, "flagged": flagged, "retired": retired, "threshold": threshold, "min_evals": min_evals}

def main():
    parser = argparse.ArgumentParser(description="Directive auto-retirement analysis")
    parser.add_argument("--threshold", type=int, default=30, help="Follow rate %% below which to flag (default 30)")
    parser.add_argument("--min-evals", type=int, default=10, help="Minimum evaluations before flagging (default 10)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    result = analyze_directives(args.threshold, args.min_evals)

    if args.json:
        print(json.dumps(result, indent=2))
        return

    print(f"Directive Health Report (threshold={args.threshold}%, min_evals={args.min_evals})\n")
    print(f"  {'Directive':<25} {'Rate':>6} {'Recent':>7} {'Trend':>10} {'Evals':>6} {'Status':>8}")
    print(f"  {'-'*25} {'-'*6} {'-'*7} {'-'*10} {'-'*6} {'-'*8}")
    for d in result["directives"]:
        status = "RETIRE" if d["flag"] == "retire" else ("WARN" if d["flag"] == "warning" else "OK")
        print(f"  {d['id']:<25} {d['follow_rate']:>5.0f}% {d['recent_rate']:>5.0f}%  {d['trend']:>9} {d['total_evals']:>6} {status:>8}")

    if result["flagged"]:
        print(f"\nFlagged for R session review:")
        for d in result["flagged"]:
            print(f"  - {d['id']}: {d['reason']}")

    if result["retired"]:
        print(f"\nAlready retired: {', '.join(result['retired'])}")

if __name__ == "__main__":
    main()

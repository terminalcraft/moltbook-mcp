#!/usr/bin/env python3
"""Platform health trends — analyze uptime-history.json for trend analysis.

Usage:
  python3 platform-trends.py [--json] [--hours 24] [--platform NAME]
"""

import json, argparse, time
from pathlib import Path
from collections import defaultdict

HISTORY_FILE = Path(__file__).parent / "uptime-history.json"

def analyze_trends(hours=24, platform_filter=None):
    with open(HISTORY_FILE) as f:
        data = json.load(f)

    probes = data.get("probes", [])
    if not probes:
        return {"error": "no probe data"}

    now_ms = time.time() * 1000
    cutoff = now_ms - (hours * 3600 * 1000)
    recent = [p for p in probes if p["ts"] > cutoff]
    all_time = probes

    # Get all platform names
    platforms = set()
    for p in probes:
        platforms.update(p.get("r", {}).keys())

    if platform_filter:
        platforms = {p for p in platforms if platform_filter.lower() in p.lower()}

    results = {}
    for plat in sorted(platforms):
        # All-time stats
        total = sum(1 for p in all_time if plat in p.get("r", {}))
        up = sum(1 for p in all_time if p.get("r", {}).get(plat) == 1)
        all_rate = (up / total * 100) if total else 0

        # Recent stats
        r_total = sum(1 for p in recent if plat in p.get("r", {}))
        r_up = sum(1 for p in recent if p.get("r", {}).get(plat) == 1)
        r_rate = (r_up / r_total * 100) if r_total else 0

        # Trend: compare recent vs all-time
        if r_total < 3:
            trend = "insufficient_data"
        elif r_rate > all_rate + 10:
            trend = "improving"
        elif r_rate < all_rate - 10:
            trend = "declining"
        else:
            trend = "stable"

        # Time-bucketed uptime (hourly buckets for the period)
        bucket_size = 3600 * 1000  # 1 hour
        buckets = defaultdict(lambda: {"up": 0, "total": 0})
        for p in recent:
            if plat in p.get("r", {}):
                bucket = int((p["ts"] - cutoff) / bucket_size)
                buckets[bucket]["total"] += 1
                if p["r"][plat] == 1:
                    buckets[bucket]["up"] += 1

        hourly = []
        for b in sorted(buckets.keys()):
            d = buckets[b]
            hourly.append(round(d["up"] / d["total"] * 100) if d["total"] else None)

        # Last status
        last_probe = None
        for p in reversed(probes):
            if plat in p.get("r", {}):
                last_probe = p
                break

        results[plat] = {
            "uptime_all": round(all_rate, 1),
            "uptime_recent": round(r_rate, 1),
            "probes_all": total,
            "probes_recent": r_total,
            "trend": trend,
            "hourly_uptime": hourly,
            "last_status": "up" if last_probe and last_probe["r"].get(plat) == 1 else "down",
            "first_seen_ago_h": round((now_ms - min(p["ts"] for p in all_time if plat in p.get("r", {}))) / 3600000, 1) if total else None,
        }

    return {
        "period_hours": hours,
        "total_probes": len(probes),
        "recent_probes": len(recent),
        "platforms": results,
    }

def main():
    parser = argparse.ArgumentParser(description="Platform health trends")
    parser.add_argument("--hours", type=int, default=24, help="Lookback period in hours (default 24)")
    parser.add_argument("--platform", type=str, help="Filter to specific platform name")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    result = analyze_trends(args.hours, args.platform)

    if args.json:
        print(json.dumps(result, indent=2))
        return

    print(f"Platform Health Trends ({args.hours}h lookback, {result['recent_probes']}/{result['total_probes']} probes)\n")
    print(f"  {'Platform':<22} {'All-time':>8} {'Recent':>8} {'Trend':>12} {'Status':>7}")
    print(f"  {'-'*22} {'-'*8} {'-'*8} {'-'*12} {'-'*7}")
    for name, data in sorted(result["platforms"].items(), key=lambda x: x[1]["uptime_recent"]):
        print(f"  {name:<22} {data['uptime_all']:>7.1f}% {data['uptime_recent']:>7.1f}% {data['trend']:>12} {data['last_status']:>7}")

if __name__ == "__main__":
    main()

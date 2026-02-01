#!/usr/bin/env python3
"""Audit API endpoints: compare registered routes to actual traffic.
Uses authed /analytics for full endpoint data. Outputs JSON with --json flag."""

import json, os, re, sys, urllib.request

API = "http://localhost:3847"
TOKEN = os.environ.get("MOLTBOT_TOKEN", "")

def get_analytics():
    """Get full endpoint hit counts via authed analytics."""
    try:
        req = urllib.request.Request(f"{API}/analytics")
        if TOKEN:
            req.add_header("Authorization", f"Bearer {TOKEN}")
        data = json.loads(urllib.request.urlopen(req).read())
        # Prefer allEndpoints (authed), fall back to topEndpoints
        return data.get("allEndpoints", data.get("topEndpoints", {}))
    except:
        return {}

def get_all_endpoints_from_source():
    """Parse api.mjs for all registered routes."""
    routes = []
    pattern = re.compile(r'app\.(get|post|put|delete|patch)\(\s*["\']([^"\']+)["\']')
    with open("api.mjs") as f:
        for line in f:
            m = pattern.search(line)
            if m:
                method = m.group(1).upper()
                path = m.group(2)
                routes.append(f"{method} {path}")
    return routes

def main():
    as_json = "--json" in sys.argv
    registered = get_all_endpoints_from_source()
    hits = get_analytics()

    zero_hit = []
    low_hit = []
    active = []

    for route in registered:
        if ":" in route:
            continue  # Skip parameterized
        count = hits.get(route, 0)
        if count == 0:
            zero_hit.append(route)
        elif count < 5:
            low_hit.append({"route": route, "hits": count})
        else:
            active.append({"route": route, "hits": count})

    active.sort(key=lambda x: -x["hits"])

    if as_json:
        json.dump({
            "registered": len(registered),
            "tracked": len(hits),
            "zero_hit": sorted(zero_hit),
            "low_hit": low_hit,
            "active": active,
        }, sys.stdout, indent=2)
        return

    print(f"Registered routes: {len(registered)}")
    print(f"Tracked endpoints: {len(hits)}")
    print()

    print(f"=== ZERO-HIT ENDPOINTS ({len(zero_hit)}) ===")
    for r in sorted(zero_hit):
        print(f"  {r}")

    print(f"\n=== LOW-HIT ENDPOINTS <5 ({len(low_hit)}) ===")
    for e in sorted(low_hit, key=lambda x: x["hits"]):
        print(f"  {e['hits']:>3}  {e['route']}")

    print(f"\n=== ACTIVE ENDPOINTS ({len(active)}) ===")
    for e in active[:15]:
        print(f"  {e['hits']:>5}  {e['route']}")

if __name__ == "__main__":
    main()

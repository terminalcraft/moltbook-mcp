#!/usr/bin/env python3
"""API surface audit — cross-references registered routes with analytics data.

Reports:
- Endpoints with zero external hits (candidates for removal)
- Overlapping/redundant endpoint groups
- Traffic concentration (what % of traffic hits top N endpoints)
- Stale endpoints (registered but never hit since analytics started)

Usage:
  python3 scripts/api-audit.py [--json] [--threshold N]
"""

import json
import re
import sys
from pathlib import Path
from collections import defaultdict

BASE = Path(__file__).resolve().parent.parent
ANALYTICS_FILE = BASE / "analytics.json"
API_FILE = BASE / "api.mjs"

def extract_routes(api_source: str) -> list[dict]:
    """Extract all route registrations from api.mjs."""
    pattern = re.compile(
        r'app\.(get|post|put|patch|delete)\(\s*["\']([^"\']+)["\']',
        re.IGNORECASE
    )
    routes = []
    for i, line in enumerate(api_source.splitlines(), 1):
        m = pattern.search(line)
        if m:
            method = m.group(1).upper()
            path = m.group(2)
            routes.append({"method": method, "path": path, "line": i})
    return routes

def load_analytics() -> dict:
    try:
        return json.loads(ANALYTICS_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"endpoints": {}, "totalRequests": 0, "startedAt": "unknown"}

def normalize_key(method: str, path: str) -> str:
    """Convert route definition to analytics key format."""
    return f"{method} {path}"

def match_analytics(route_key: str, analytics_endpoints: dict) -> int:
    """Find hits for a route, handling parameterized routes like /registry/:handle."""
    # Exact match first
    if route_key in analytics_endpoints:
        return analytics_endpoints[route_key]
    # Parameterized route — check if any analytics key matches the pattern
    pattern_path = route_key.split(" ", 1)[1] if " " in route_key else route_key
    method = route_key.split(" ", 1)[0] if " " in route_key else ""
    regex_path = re.sub(r":[^/]+", r"[^/]+", re.escape(pattern_path))
    regex_path = regex_path.replace(r"\[^/\]\+", "[^/]+")  # unescape our placeholder
    total = 0
    for k, v in analytics_endpoints.items():
        k_method, k_path = k.split(" ", 1) if " " in k else ("", k)
        if k_method == method and re.fullmatch(regex_path, k_path):
            total += v
    return total

def group_endpoints(routes: list[dict]) -> dict[str, list[dict]]:
    """Group routes by URL prefix (first path segment)."""
    groups = defaultdict(list)
    for r in routes:
        prefix = "/" + r["path"].strip("/").split("/")[0]
        groups[prefix].append(r)
    return dict(groups)

def run_audit(threshold: int = 5, as_json: bool = False):
    api_source = API_FILE.read_text()
    routes = extract_routes(api_source)
    analytics = load_analytics()
    endpoints = analytics.get("endpoints", {})
    total_requests = analytics.get("totalRequests", 0)
    since = analytics.get("startedAt", "unknown")

    # Classify routes
    zero_hit = []
    low_hit = []
    active = []

    for r in routes:
        key = normalize_key(r["method"], r["path"])
        hits = match_analytics(key, endpoints)
        r["hits"] = hits
        if hits == 0:
            zero_hit.append(r)
        elif hits < threshold:
            low_hit.append(r)
        else:
            active.append(r)

    # Traffic concentration
    active_sorted = sorted(active, key=lambda r: -r["hits"])
    top5_hits = sum(r["hits"] for r in active_sorted[:5])
    top10_hits = sum(r["hits"] for r in active_sorted[:10])

    # Group analysis
    groups = group_endpoints(routes)
    large_groups = {k: v for k, v in groups.items() if len(v) >= 5}

    result = {
        "since": since,
        "total_requests": total_requests,
        "total_routes": len(routes),
        "zero_hit": len(zero_hit),
        "low_hit": len(low_hit),
        "active": len(active),
        "concentration": {
            "top5_pct": round(top5_hits / max(total_requests, 1) * 100, 1),
            "top10_pct": round(top10_hits / max(total_requests, 1) * 100, 1),
        },
        "zero_hit_routes": [{"method": r["method"], "path": r["path"], "line": r["line"]} for r in zero_hit],
        "low_hit_routes": [{"method": r["method"], "path": r["path"], "hits": r["hits"], "line": r["line"]} for r in low_hit],
        "top_routes": [{"method": r["method"], "path": r["path"], "hits": r["hits"]} for r in active_sorted[:15]],
        "large_groups": {k: len(v) for k, v in large_groups.items()},
    }

    if as_json:
        print(json.dumps(result, indent=2))
        return

    # Human-readable report
    print(f"=== API Surface Audit ===")
    print(f"Analytics since: {since}")
    print(f"Total requests: {total_requests:,}")
    print(f"Total registered routes: {len(routes)}")
    print(f"Active (>={threshold} hits): {len(active)}")
    print(f"Low traffic (<{threshold} hits): {len(low_hit)}")
    print(f"Zero hits: {len(zero_hit)}")
    print(f"Traffic concentration: top 5 = {result['concentration']['top5_pct']}%, top 10 = {result['concentration']['top10_pct']}%")

    if zero_hit:
        print(f"\n--- Zero-hit routes ({len(zero_hit)}) ---")
        for r in sorted(zero_hit, key=lambda x: x["line"]):
            print(f"  L{r['line']:4d}  {r['method']:6s} {r['path']}")

    if low_hit:
        print(f"\n--- Low-traffic routes ({len(low_hit)}) ---")
        for r in sorted(low_hit, key=lambda x: x["hits"]):
            print(f"  L{r['line']:4d}  {r['method']:6s} {r['path']}  ({r['hits']} hits)")

    print(f"\n--- Top 15 routes ---")
    for r in active_sorted[:15]:
        print(f"  {r['hits']:6d}  {r['method']:6s} {r['path']}")

    if large_groups:
        print(f"\n--- Large route groups (>=5 routes) ---")
        for prefix, count in sorted(large_groups.items(), key=lambda x: -len(x[1])):
            print(f"  {prefix}: {len(count)} routes")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="API surface audit")
    parser.add_argument("--json", action="store_true", help="JSON output")
    parser.add_argument("--threshold", type=int, default=5, help="Min hits to be 'active'")
    args = parser.parse_args()
    run_audit(threshold=args.threshold, as_json=args.json)

#!/usr/bin/env python3
"""Probe all known services and build ecosystem-map.json with agent status.

For each service in services.json:
- HTTP probe (status code, response time)
- Check for agent.json manifest
- Record capabilities, peers, last-seen

Usage: python3 ecosystem-map.py [--verbose]
"""

import json, sys, os, ssl, time, urllib.request, urllib.error, concurrent.futures
from datetime import datetime, timezone
from urllib.parse import urlparse

VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv
DIR = os.path.dirname(os.path.abspath(__file__))
SERVICES_PATH = os.path.join(DIR, "services.json")
MAP_PATH = os.path.join(DIR, "ecosystem-map.json")
TIMEOUT = 5

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def log(msg):
    if VERBOSE:
        print(f"  [{datetime.now().strftime('%H:%M:%S')}] {msg}")

def probe_url(url, timeout=TIMEOUT):
    """Probe a URL and return (status_code, response_time_ms, error)."""
    start = time.time()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "moltbot-probe/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            elapsed = int((time.time() - start) * 1000)
            return (r.status, elapsed, None)
    except urllib.error.HTTPError as e:
        elapsed = int((time.time() - start) * 1000)
        return (e.code, elapsed, str(e))
    except Exception as e:
        elapsed = int((time.time() - start) * 1000)
        return (0, elapsed, str(e))

def fetch_manifest(base_url):
    """Try to fetch agent.json from a base URL."""
    try:
        req = urllib.request.Request(f"{base_url}/agent.json",
                                     headers={"User-Agent": "moltbot-probe/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
            return json.loads(r.read().decode())
    except:
        return None

def probe_service(svc):
    """Probe a single service and return its ecosystem map entry."""
    url = svc.get("url", "")
    name = svc.get("name", svc.get("id", "unknown"))
    sid = svc.get("id", "")

    status_code, latency_ms, error = probe_url(url)
    online = status_code in range(200, 400)

    # Try manifest
    parsed = urlparse(url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    manifest = fetch_manifest(base) if online else None

    entry = {
        "id": sid,
        "name": name,
        "url": url,
        "category": svc.get("category", "unknown"),
        "status_in_registry": svc.get("status", "unknown"),
        "probe": {
            "online": online,
            "status_code": status_code,
            "latency_ms": latency_ms,
            "error": error,
            "probed_at": datetime.now(timezone.utc).isoformat()
        },
        "manifest": None,
        "capabilities": [],
        "peers": [],
        "tags": svc.get("tags", [])
    }

    if manifest and isinstance(manifest, dict):
        entry["manifest"] = {
            "name": manifest.get("name"),
            "handle": manifest.get("handle"),
            "version": manifest.get("version"),
            "capabilities": manifest.get("capabilities", []),
        }
        entry["capabilities"] = manifest.get("capabilities", [])
        entry["peers"] = [p if isinstance(p, str) else p.get("url", "") for p in manifest.get("peers", [])]

    log(f"{'✓' if online else '✗'} {name} ({status_code}, {latency_ms}ms)")
    return entry

def main():
    print("=== Ecosystem Map Builder ===")
    with open(SERVICES_PATH) as f:
        services = json.load(f)

    svcs = [s for s in services.get("services", []) if s.get("status") != "rejected"]
    print(f"Probing {len(svcs)} services (excluding rejected)...\n")

    # Probe in parallel
    entries = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(probe_service, s): s for s in svcs}
        for f in concurrent.futures.as_completed(futures):
            entries.append(f.result())

    online = sum(1 for e in entries if e["probe"]["online"])
    with_manifest = sum(1 for e in entries if e["manifest"])

    eco_map = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "total": len(entries),
            "online": online,
            "offline": len(entries) - online,
            "with_manifest": with_manifest
        },
        "agents": sorted(entries, key=lambda e: (not e["probe"]["online"], e["name"].lower()))
    }

    with open(MAP_PATH, "w") as f:
        json.dump(eco_map, f, indent=2)
        f.write("\n")

    print(f"\nResults: {online}/{len(entries)} online, {with_manifest} with manifests")
    print(f"Saved to {MAP_PATH}")

if __name__ == "__main__":
    main()

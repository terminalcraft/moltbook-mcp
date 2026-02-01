#!/usr/bin/env python3
"""Probe all known agent exchange endpoints and catalog active agents.
Outputs ecosystem-map.json with online/offline status, capabilities, manifest data."""

import json
import time
import urllib.request
import urllib.error
import ssl
import os
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TIMEOUT = 5
NOW = datetime.now(timezone.utc).isoformat()

# Disable SSL verification for probing
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def fetch_json(url, timeout=TIMEOUT):
    """Fetch JSON from URL, return (data, status_code) or (None, error_string)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "moltbook-probe/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            data = json.loads(resp.read().decode())
            return data, resp.status
    except urllib.error.HTTPError as e:
        return None, e.code
    except urllib.error.URLError as e:
        return None, str(e.reason)[:100]
    except Exception as e:
        return None, str(e)[:100]


def probe_agent_json(base_url):
    """Try /agent.json at a base URL."""
    base = base_url.rstrip("/")
    for path in ["/agent.json", "/.well-known/agent.json"]:
        data, status = fetch_json(base + path)
        if data and isinstance(data, dict):
            return data, status, base + path
    return None, None, None


def collect_exchange_candidates():
    """Gather all URLs that might host agent exchange endpoints."""
    candidates = {}

    # 1. From services.json — any service with a non-standard port or known API
    services_path = os.path.join(BASE_DIR, "services.json")
    if os.path.exists(services_path):
        with open(services_path) as f:
            svc = json.load(f)
        for s in svc.get("services", []):
            url = s.get("url", "")
            sid = s.get("id", "")
            # Only probe services that could be agent servers (not big platforms)
            if url and (":" in url.split("//")[-1].split("/")[0].split(".")[-1] or
                        any(k in sid for k in ["agent", "exchange"])):
                candidates[url] = {"source": f"services:{sid}", "name": s.get("name", sid)}

    # 2. From agents-unified.json — any agent with exchange_url
    agents_path = os.path.join(BASE_DIR, "agents-unified.json")
    if os.path.exists(agents_path):
        with open(agents_path) as f:
            agents = json.load(f)
        for a in agents.get("agents", agents if isinstance(agents, list) else []):
            if isinstance(a, dict):
                ex = a.get("exchange_url") or a.get("exchangeUrl") or ""
                if ex:
                    base = ex.replace("/agent.json", "").rstrip("/")
                    candidates[base] = {"source": "agents-unified", "name": a.get("handle", "?")}

    # 3. From peers.json
    peers_path = os.path.join(BASE_DIR, "peers.json")
    if os.path.exists(peers_path):
        with open(peers_path) as f:
            peers = json.load(f)
        for key, p in peers.items():
            url = p.get("url", "")
            if url:
                base = url.replace("/agent.json", "").rstrip("/")
                candidates[base] = {"source": "peers", "name": p.get("name", key)}

    # 4. From registry (our own API)
    data, status = fetch_json("http://127.0.0.1:3847/registry")
    if data and isinstance(data, dict):
        for agent in data.get("agents", []):
            ex = agent.get("exchange_url") or ""
            if ex:
                base = ex.replace("/agent.json", "").rstrip("/")
                candidates[base] = {"source": "registry", "name": agent.get("handle", "?")}

    # 5. From directory endpoint
    data, status = fetch_json("http://127.0.0.1:3847/directory")
    if data and isinstance(data, dict):
        for agent in data.get("agents", []):
            ex = agent.get("exchange_url") or ""
            if ex:
                base = ex.replace("/agent.json", "").rstrip("/")
                candidates[base] = {"source": "directory", "name": agent.get("handle", "?")}

    # 6. From GitHub map (our MCP)
    # Already captured in registry/directory

    # 7. Hardcoded known agent servers from ecosystem observation
    known_agents = {
        "http://194.164.206.175:3847": {"source": "self", "name": "moltbook"},
        # Add any other known exchange endpoints discovered in sessions
    }
    for url, info in known_agents.items():
        if url not in candidates:
            candidates[url] = info

    # 8. Probe well-known agent platforms for /agent.json
    platforms_to_probe = [
        ("https://chatr.ai", "chatr"),
        ("https://ctxly.app", "ctxly"),
        ("https://moltbook.com", "moltbook-platform"),
        ("https://agentid.sh", "agentid"),
        ("https://lobchan.ai", "lobchan"),
        ("https://moltcities.org", "moltcities"),
        ("https://mydeadinternet.com", "mdi"),
        ("https://grove.ctxly.app", "grove"),
        ("https://home.ctxly.app", "home-ctxly"),
        ("https://lobstack.app", "lobstack"),
        ("https://clawtasks.com", "clawtasks"),
        ("https://www.4claw.org", "4claw"),
        ("https://moltchan.org", "moltchan"),
        ("https://www.moltchan.org", "moltchan-www"),
        ("https://darkclaw.net", "darkclaw"),
        ("https://clawdhub.com", "clawdhub"),
        ("https://8claw.net", "8claw"),
        ("https://clawwatch.online", "clawwatch"),
        ("https://howstrangeitistobeanythingatall.com", "howstrange"),
        ("https://darkclawbook.com", "darkclawbook-com"),
        ("https://darkclawbook.self.md", "darkclawbook"),
        ("http://100.29.245.213:3456", "openswarm"),
    ]
    for url, name in platforms_to_probe:
        if url not in candidates:
            candidates[url] = {"source": "platform-probe", "name": name}

    return candidates


def main():
    print(f"[{NOW}] Starting ecosystem probe...")
    candidates = collect_exchange_candidates()
    print(f"Collected {len(candidates)} candidate URLs to probe")

    results = []
    for base_url, meta in candidates.items():
        print(f"  Probing {base_url} ({meta['name']})...", end=" ", flush=True)
        manifest, status, found_url = probe_agent_json(base_url)

        entry = {
            "url": base_url,
            "name": meta["name"],
            "source": meta["source"],
            "probed_at": NOW,
            "manifest_url": found_url,
        }

        if manifest:
            entry["online"] = True
            entry["has_exchange"] = True
            entry["manifest"] = {
                "name": manifest.get("name"),
                "version": manifest.get("version"),
                "capabilities": manifest.get("capabilities", []),
                "endpoints": manifest.get("endpoints", []),
                "protocol": manifest.get("protocol"),
                "identity": {k: v for k, v in manifest.get("identity", {}).items()
                             if k in ["handle", "verified_on"]} if manifest.get("identity") else None,
            }
            entry["capabilities_count"] = len(manifest.get("capabilities", []))
            print(f"✓ EXCHANGE ({entry['capabilities_count']} caps)")
        else:
            # Try a basic HTTP check
            try:
                req = urllib.request.Request(base_url, headers={"User-Agent": "moltbook-probe/1.0"})
                with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
                    entry["online"] = True
                    entry["has_exchange"] = False
                    entry["http_status"] = resp.status
                    print(f"↑ online (no exchange, HTTP {resp.status})")
            except Exception as e:
                entry["online"] = False
                entry["has_exchange"] = False
                entry["error"] = str(e)[:100]
                print(f"✗ offline ({str(e)[:50]})")

        results.append(entry)
        time.sleep(0.2)  # Be polite

    # Build ecosystem map
    ecosystem_map = {
        "version": 1,
        "generated_at": NOW,
        "generator": "probe-ecosystem.py",
        "summary": {
            "total_probed": len(results),
            "online": sum(1 for r in results if r.get("online")),
            "offline": sum(1 for r in results if not r.get("online")),
            "with_exchange": sum(1 for r in results if r.get("has_exchange")),
        },
        "agents": sorted(results, key=lambda r: (not r.get("has_exchange"), not r.get("online"), r.get("name", ""))),
    }

    out_path = os.path.join(BASE_DIR, "ecosystem-map.json")
    with open(out_path, "w") as f:
        json.dump(ecosystem_map, f, indent=2)

    print(f"\n=== Results ===")
    print(f"Total probed: {ecosystem_map['summary']['total_probed']}")
    print(f"Online: {ecosystem_map['summary']['online']}")
    print(f"Offline: {ecosystem_map['summary']['offline']}")
    print(f"With exchange protocol: {ecosystem_map['summary']['with_exchange']}")
    print(f"Saved to {out_path}")


if __name__ == "__main__":
    main()

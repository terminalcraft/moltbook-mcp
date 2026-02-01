#!/usr/bin/env python3
"""Cross-agent API caller — probe and call other agents' APIs.

Usage:
  python3 cross-agent.py discover          # Find callable agents
  python3 cross-agent.py call <url> [path] # Call an agent endpoint
  python3 cross-agent.py exchange <url>    # Knowledge exchange with agent
  python3 cross-agent.py handshake <url>   # Handshake with agent
"""

import sys, json, urllib.request, urllib.error, time, os

TIMEOUT = 8
BASE = os.path.dirname(os.path.abspath(__file__))
AGENTS_FILE = os.path.join(BASE, "cross-agent-cache.json")
OUR_URL = "http://194.164.206.175:3847"

def fetch_json(url, timeout=TIMEOUT):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "moltbook-agent/1.0", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"error": str(e)}

def post_json(url, data, timeout=TIMEOUT):
    try:
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, data=body, headers={
            "User-Agent": "moltbook-agent/1.0",
            "Content-Type": "application/json",
            "Accept": "application/json"
        })
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"error": str(e)}

def load_cache():
    try:
        return json.load(open(AGENTS_FILE))
    except:
        return {"agents": [], "updated": None}

def save_cache(data):
    data["updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(AGENTS_FILE, "w") as f:
        json.dump(data, f, indent=2)

def discover():
    """Find agents with callable APIs from multiple sources."""
    found = {}

    # Source 1: Our own directory
    dir_data = fetch_json(f"{OUR_URL}/directory?format=json")
    if isinstance(dir_data, dict) and "agents" in dir_data:
        for a in dir_data["agents"]:
            url = a.get("exchange_url", "").replace("/agent.json", "")
            if url and url != OUR_URL:
                found[url] = {"handle": a.get("handle"), "source": "directory", "url": url, "exchange_url": a.get("exchange_url")}

    # Source 2: Registry
    reg_data = fetch_json(f"{OUR_URL}/registry")
    if isinstance(reg_data, dict) and "agents" in reg_data:
        for a in reg_data.get("agents", []):
            url = (a.get("exchange_url") or "").replace("/agent.json", "")
            if url and url != OUR_URL:
                found[url] = {"handle": a.get("handle"), "source": "registry", "url": url, "exchange_url": a.get("exchange_url")}

    # Source 3: Ecosystem map
    try:
        eco = json.load(open(os.path.join(BASE, "ecosystem-map.json")))
        for a in eco.get("agents", []):
            url = a.get("url", "")
            if url and url != OUR_URL and a.get("online"):
                if url not in found:
                    found[url] = {"handle": a.get("handle"), "source": "ecosystem", "url": url}
    except:
        pass

    # Source 4: Chatr agent list — try to extract URLs from bios
    # (Chatr agents don't expose URLs directly, skip)

    # Probe each found agent for /agent.json
    results = []
    for url, info in found.items():
        manifest_url = info.get("exchange_url") or f"{url}/agent.json"
        manifest = fetch_json(manifest_url)
        if "error" not in manifest:
            info["manifest"] = manifest
            info["callable"] = True
            info["endpoints"] = manifest.get("endpoints", {})
            info["capabilities"] = manifest.get("capabilities", [])
        else:
            info["callable"] = False
            info["probe_error"] = manifest["error"]
        results.append(info)

    cache = {"agents": results, "updated": None}
    save_cache(cache)
    print(json.dumps({"found": len(results), "callable": sum(1 for r in results if r.get("callable")), "agents": results}, indent=2))
    return results

def call_agent(base_url, path="/agent.json", method="GET", data=None):
    """Call a specific agent endpoint."""
    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
    if method == "POST" and data:
        result = post_json(url, data)
    else:
        result = fetch_json(url)
    print(json.dumps({"url": url, "method": method, "result": result}, indent=2))
    return result

def exchange(base_url):
    """Attempt knowledge exchange with another agent."""
    # Step 1: Fetch their manifest
    manifest = fetch_json(f"{base_url.rstrip('/')}/agent.json")
    if "error" in manifest:
        print(json.dumps({"error": f"Cannot reach agent: {manifest['error']}"}))
        return

    # Step 2: Check for knowledge exchange capability
    caps = manifest.get("capabilities", [])
    has_exchange = "knowledge-exchange" in caps

    # Step 3: Fetch their patterns
    patterns = fetch_json(f"{base_url.rstrip('/')}/knowledge/patterns")

    # Step 4: Send ours
    our_patterns = fetch_json(f"{OUR_URL}/knowledge/patterns")
    exchange_result = post_json(f"{base_url.rstrip('/')}/knowledge/exchange", {
        "agent": "moltbook",
        "patterns": our_patterns if isinstance(our_patterns, list) else our_patterns.get("patterns", [])
    })

    result = {
        "agent": manifest.get("name", base_url),
        "has_exchange": has_exchange,
        "their_patterns": len(patterns) if isinstance(patterns, list) else len(patterns.get("patterns", [])) if isinstance(patterns, dict) else 0,
        "exchange_response": exchange_result
    }
    print(json.dumps(result, indent=2))
    return result

def handshake(base_url):
    """Handshake with another agent."""
    result = post_json(f"{base_url.rstrip('/')}/handshake", {
        "agent": "moltbook",
        "url": f"{OUR_URL}/agent.json",
        "capabilities": ["knowledge-exchange", "registry", "4claw-digest"]
    })
    print(json.dumps(result, indent=2))
    return result

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "discover":
        discover()
    elif cmd == "call" and len(sys.argv) >= 3:
        path = sys.argv[3] if len(sys.argv) > 3 else "/agent.json"
        call_agent(sys.argv[2], path)
    elif cmd == "exchange" and len(sys.argv) >= 3:
        exchange(sys.argv[2])
    elif cmd == "handshake" and len(sys.argv) >= 3:
        handshake(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)

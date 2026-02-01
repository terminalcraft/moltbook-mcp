#!/usr/bin/env python3
"""Crawl agent directories and profiles to expand services.json with new agents/endpoints.

Sources crawled:
1. Our own /directory and /network endpoints
2. Ctxly directory API
3. Our /feed endpoint (aggregates 4claw, Chatr, MDI, LobChan, Moltbook)
4. Our /4claw/digest proxy (extracts URLs from 4claw threads)
5. Known exchange endpoints (probe agent.json for peer discovery)

Usage: python3 ecosystem-crawl.py [--dry-run] [--verbose]
"""

import json, sys, os, re, hashlib, urllib.request, urllib.error, ssl
from datetime import datetime, timezone
from urllib.parse import urlparse

DRY_RUN = "--dry-run" in sys.argv
VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv
SERVICES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "services.json")
BASE = "http://127.0.0.1:3847"
TIMEOUT = 5

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# URLs to ignore when extracting from content
SKIP_DOMAINS = {
    "github.com", "twitter.com", "x.com", "youtube.com", "reddit.com",
    "discord.gg", "t.me", "google.com", "wikipedia.org", "npmjs.com",
    "4claw.org", "www.4claw.org", "moltbook.com", "chatr.ai",
    "localhost", "127.0.0.1", "194.164.206.175", "194.164.206.175:3847",
    "image.pollinations.ai", "image.pollinati",  # image gen, not agent services
}
SKIP_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".mp4", ".pdf"}

def log(msg):
    if VERBOSE:
        print(f"  [{datetime.now().strftime('%H:%M:%S')}] {msg}")

def fetch_json(url, timeout=TIMEOUT):
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "moltbot-crawler/1.0"})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        log(f"Failed: {url} — {e}")
        return None

def load_services():
    with open(SERVICES_PATH) as f:
        return json.load(f)

def save_services(data):
    data["lastUpdated"] = datetime.now(timezone.utc).isoformat()
    with open(SERVICES_PATH, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

def existing_urls(services):
    """Return set of normalized base URLs already in services.json."""
    urls = set()
    for s in services.get("services", []):
        raw = s.get("url", "")
        try:
            p = urlparse(raw)
            urls.add(f"{p.scheme}://{p.netloc}".lower().rstrip("/"))
        except:
            urls.add(raw.rstrip("/").lower())
    return urls

def make_id(name):
    return re.sub(r'[^a-z0-9-]', '-', name.lower().strip())[:40].strip("-")

def add_service(services, url, name, category, source, tags=None):
    known = existing_urls(services)
    try:
        p = urlparse(url)
        base = f"{p.scheme}://{p.netloc}".lower().rstrip("/")
    except:
        base = url.rstrip("/").lower()
    if base in known:
        log(f"Already known: {url}")
        return False
    sid = make_id(name)
    existing_ids = {s["id"] for s in services.get("services", [])}
    if sid in existing_ids:
        sid = sid + "-" + hashlib.md5(url.encode()).hexdigest()[:4]
    entry = {
        "id": sid,
        "name": name,
        "url": url,
        "category": category,
        "source": f"crawl:{source}",
        "status": "discovered",
        "discoveredAt": datetime.now(timezone.utc).isoformat(),
        "evaluatedAt": None,
        "notes": f"Auto-discovered from {source}",
        "api_docs": None,
        "tags": tags or []
    }
    services["services"].append(entry)
    print(f"  + NEW: {name} ({url}) via {source}")
    return True

def extract_urls(text):
    """Extract unique service-like URLs from text content."""
    raw = re.findall(r'https?://[^\s<>"\')\]\},]+', text)
    results = {}
    for url in raw:
        url = url.rstrip(".,;:!?)")
        try:
            p = urlparse(url)
            if not p.netloc or p.netloc in SKIP_DOMAINS:
                continue
            if any(url.lower().endswith(ext) for ext in SKIP_EXTENSIONS):
                continue
            # Skip truncated/partial domains (must have a TLD with 2+ chars)
            if "." not in p.netloc or len(p.netloc.split(".")[-1]) < 2:
                continue
            base = f"{p.scheme}://{p.netloc}"
            if base not in results:
                results[base] = p.netloc.replace("www.", "")
        except:
            pass
    return [(url, name) for url, name in results.items()]

def crawl_ctxly_directory():
    """Crawl Ctxly service directory."""
    print("1. Ctxly directory...")
    data = fetch_json("https://directory.ctxly.app/api/services")
    if not data or not isinstance(data, list):
        return []
    results = []
    for svc in data:
        url = svc.get("url", "")
        name = svc.get("name", svc.get("title", "unknown"))
        if url:
            results.append({"url": url, "name": name, "category": svc.get("category", "unknown"),
                           "source": "ctxly-directory", "tags": svc.get("tags", [])})
    log(f"{len(results)} services")
    return results

def crawl_own_directory():
    """Crawl our verified agent directory."""
    print("2. Own /directory...")
    data = fetch_json(f"{BASE}/directory?live=false", timeout=5)
    if not data or "agents" not in data:
        return []
    agents = data["agents"] if isinstance(data["agents"], list) else list(data["agents"].values())
    results = []
    for agent in agents:
        url = agent.get("exchange_url") or agent.get("url", "")
        name = agent.get("handle", agent.get("name", "unknown"))
        if url and "194.164.206.175" not in url:  # Skip self
            results.append({"url": url, "name": name, "category": "agent",
                           "source": "own-directory", "tags": ["agent", "exchange"]})
    log(f"{len(results)} agents")
    return results

def crawl_feed():
    """Crawl our /feed endpoint to extract URLs from cross-platform content."""
    print("3. Own /feed (cross-platform)...")
    data = fetch_json(f"{BASE}/feed?limit=50", timeout=15)
    if not data or not isinstance(data, list):
        # Try alternate structure
        if isinstance(data, dict):
            data = data.get("items", data.get("feed", []))
        if not data:
            return []
    all_text = ""
    for item in data:
        all_text += " " + json.dumps(item)
    urls = extract_urls(all_text)
    results = [{"url": u, "name": n, "category": "unknown", "source": "feed", "tags": ["feed-discovered"]}
               for u, n in urls]
    log(f"{len(results)} unique URLs from feed")
    return results

def crawl_4claw_digest():
    """Crawl 4claw via our local digest proxy to extract URLs."""
    print("4. 4claw digest (via proxy)...")
    results = []
    for board in ["singularity", "b"]:
        data = fetch_json(f"{BASE}/4claw/digest?board={board}&limit=30", timeout=15)
        if not data:
            continue
        threads = data if isinstance(data, list) else data.get("threads", data.get("items", []))
        all_text = json.dumps(threads)
        urls = extract_urls(all_text)
        for u, n in urls:
            results.append({"url": u, "name": n, "category": "unknown",
                           "source": f"4claw-{board}", "tags": ["4claw-discovered"]})
    # Deduplicate
    seen = set()
    deduped = []
    for r in results:
        key = r["url"].lower()
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    log(f"{len(deduped)} unique URLs from 4claw")
    return deduped

def probe_exchange_endpoints(services):
    """Probe known agent exchange endpoints for peer discovery."""
    print("5. Exchange endpoint probing...")
    results = []
    agent_urls = set()
    for svc in services.get("services", []):
        url = svc.get("url", "")
        try:
            p = urlparse(url)
            if p.port and p.port > 1024:
                agent_urls.add(f"{p.scheme}://{p.netloc}")
        except:
            pass

    for base_url in agent_urls:
        manifest = fetch_json(f"{base_url}/agent.json", timeout=5)
        if not manifest or not isinstance(manifest, dict):
            continue
        name = manifest.get("name", manifest.get("handle", "unknown"))
        log(f"Manifest at {base_url}: {name}")
        # Extract peers
        for peer in manifest.get("peers", []):
            peer_url = peer if isinstance(peer, str) else peer.get("url", "")
            peer_name = f"peer-of-{name}" if isinstance(peer, str) else peer.get("name", f"peer-of-{name}")
            if peer_url:
                results.append({"url": peer_url, "name": peer_name, "category": "agent",
                               "source": f"manifest-{name}", "tags": ["peer", "exchange"]})
        # Extract from endpoints/services advertised in manifest
        for ep in manifest.get("endpoints", manifest.get("services", [])):
            if isinstance(ep, dict) and ep.get("url"):
                results.append({"url": ep["url"], "name": ep.get("name", "unknown"),
                               "category": "agent", "source": f"manifest-{name}", "tags": ["advertised"]})
    log(f"{len(results)} from manifests")
    return results

def main():
    print(f"=== Ecosystem Crawl {'(DRY RUN) ' if DRY_RUN else ''}===")
    services = load_services()
    initial = len(services.get("services", []))
    print(f"{initial} known services\n")

    all_found = []
    all_found.extend(crawl_ctxly_directory())
    all_found.extend(crawl_own_directory())
    all_found.extend(crawl_feed())
    all_found.extend(crawl_4claw_digest())
    all_found.extend(probe_exchange_endpoints(services))

    added = sum(1 for item in all_found
                if add_service(services, item["url"], item["name"], item["category"],
                              item["source"], tags=item.get("tags", [])))

    final = len(services.get("services", []))
    print(f"\n{'DRY RUN: ' if DRY_RUN else ''}{added} new ({initial} → {final})")

    if added > 0 and not DRY_RUN:
        save_services(services)
        print(f"Saved to {SERVICES_PATH}")

    return added

if __name__ == "__main__":
    sys.exit(0 if main() >= 0 else 1)

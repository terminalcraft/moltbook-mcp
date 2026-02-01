#!/usr/bin/env python3
"""Rank agents by engagement activity across 4claw, Chatr, and Moltbook.
Uses local API endpoints (which handle auth) to gather data.
Outputs ecosystem-ranking.json."""

import json
import urllib.request
import urllib.error
import ssl
import os
import re
from datetime import datetime, timezone
from collections import defaultdict

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOCAL = "http://127.0.0.1:3847"
TIMEOUT = 15
NOW = datetime.now(timezone.utc).isoformat()

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def fetch_json(url, timeout=TIMEOUT):
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "moltbook-ranking/1.0",
            "Accept": "application/json"
        })
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"  [err] {url}: {e}")
        return None


def norm(name):
    """Normalize handle for cross-platform matching."""
    if not name:
        return None
    name = str(name).strip().lower()
    name = re.sub(r'^@', '', name)
    name = re.sub(r'[^a-z0-9_-]', '', name)
    return name if name and name != "unknown" and name != "anon" else None


def scan_4claw():
    """Scan 4claw via local digest + feed endpoints."""
    print("Scanning 4claw...")
    activity = defaultdict(lambda: {"posts": 0, "replies": 0, "boards": set()})

    # Use feed endpoint which includes author data from 4claw
    feed = fetch_json(f"{LOCAL}/feed?format=json")
    if feed:
        for item in feed.get("items", feed if isinstance(feed, list) else []):
            if item.get("source") != "4claw":
                continue
            handle = norm(item.get("author"))
            if handle:
                activity[handle]["posts"] += 1
                board = (item.get("meta") or {}).get("board", "?")
                activity[handle]["boards"].add(board)

    # Also try direct 4claw API via our credentials
    creds_path = os.path.join(BASE_DIR, "fourclaw-credentials.json")
    api_key = None
    try:
        with open(creds_path) as f:
            api_key = json.load(f).get("api_key")
    except:
        pass

    if api_key:
        for board in ["singularity", "b"]:
            data = None
            try:
                req = urllib.request.Request(
                    f"https://www.4claw.org/api/v1/boards/{board}/threads?sort=bumped",
                    headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as resp:
                    data = json.loads(resp.read().decode())
            except Exception as e:
                print(f"  [err] 4claw {board}: {e}")

            if not data:
                continue
            threads = data.get("threads", data if isinstance(data, list) else [])
            for t in threads:
                author = norm(t.get("authorName") or t.get("author"))
                if author:
                    activity[author]["posts"] += 1
                    activity[author]["boards"].add(board)

                # Replies in thread listing (if available)
                for r in (t.get("replies") or t.get("recentReplies") or []):
                    ra = norm(r.get("authorName") or r.get("author"))
                    if ra:
                        activity[ra]["replies"] += 1
                        activity[ra]["boards"].add(board)

    result = {}
    for h, d in activity.items():
        result[h] = {"posts": d["posts"], "replies": d["replies"],
                      "boards": list(d["boards"]),
                      "total": d["posts"] + d["replies"]}
    print(f"  Found {len(result)} agents on 4claw")
    return result


def scan_chatr():
    """Scan Chatr via local digest endpoint."""
    print("Scanning Chatr...")
    activity = defaultdict(lambda: {"messages": 0, "quality_score": 0})

    # Wide mode gets all messages with scores
    data = fetch_json(f"{LOCAL}/chatr/digest?limit=50&mode=wide")
    if data:
        for msg in data.get("messages", []):
            handle = norm(msg.get("agent"))
            if handle:
                activity[handle]["messages"] += 1
                activity[handle]["quality_score"] += msg.get("score", 0)

    # Also get agent presence from Chatr API
    agents = fetch_json("https://chatr.ai/api/agents")
    if agents:
        agent_list = agents if isinstance(agents, list) else agents.get("agents", [])
        for a in agent_list:
            handle = norm(a.get("handle") or a.get("name") or a.get("agentName"))
            if handle:
                if handle not in activity:
                    activity[handle] = {"messages": 0, "quality_score": 0}
                activity[handle]["online"] = a.get("online", False)

    result = {h: dict(d) for h, d in activity.items()}
    print(f"  Found {len(result)} agents on Chatr")
    return result


def scan_moltbook():
    """Scan Moltbook via digest + directory."""
    print("Scanning Moltbook...")
    activity = defaultdict(lambda: {"posts": 0, "comments": 0, "score_total": 0})

    # Use Moltbook search via MCP-style — but we don't have direct API
    # Use our feed endpoint which aggregates Moltbook data
    feed = fetch_json(f"{LOCAL}/feed?format=json")
    if feed:
        for item in feed.get("items", feed if isinstance(feed, list) else []):
            if item.get("source") != "moltbook":
                continue
            handle = norm(item.get("author"))
            if handle:
                activity[handle]["posts"] += 1

    # Directory gives us registered agents
    directory = fetch_json(f"{LOCAL}/directory")
    if directory:
        for a in directory.get("agents", []):
            handle = norm(a.get("handle") or a.get("name"))
            if handle:
                activity[handle]["registered"] = True

    # Registry gives us agents with capabilities
    registry = fetch_json(f"{LOCAL}/registry")
    if registry:
        for a in registry.get("agents", []):
            handle = norm(a.get("handle"))
            if handle:
                activity[handle]["in_registry"] = True

    result = {h: dict(d) for h, d in activity.items()}
    print(f"  Found {len(result)} agents on Moltbook")
    return result


def compute_rankings(fourclaw, chatr, moltbook):
    """Merge and score agents across platforms."""
    all_handles = set(fourclaw) | set(chatr) | set(moltbook)
    rankings = []

    for handle in all_handles:
        fc = fourclaw.get(handle, {})
        ch = chatr.get(handle, {})
        mb = moltbook.get(handle, {})

        platforms = []
        if fc:
            platforms.append("4claw")
        if ch:
            platforms.append("chatr")
        if mb:
            platforms.append("moltbook")

        # Score components
        fc_score = fc.get("posts", 0) * 3 + fc.get("replies", 0) * 2
        ch_score = ch.get("messages", 0) * 1.5 + max(ch.get("quality_score", 0) * 0.3, 0)
        mb_score = mb.get("posts", 0) * 3 + mb.get("comments", 0) * 2

        raw = fc_score + ch_score + mb_score

        # Platform diversity multiplier
        n = len(platforms)
        multiplier = {1: 1.0, 2: 1.5, 3: 2.0}.get(n, 1.0)
        score = round(raw * multiplier, 1)

        rankings.append({
            "handle": handle,
            "score": score,
            "platforms": platforms,
            "platform_count": n,
            "breakdown": {
                "4claw": fc if fc else None,
                "chatr": ch if ch else None,
                "moltbook": mb if mb else None,
            },
        })

    rankings.sort(key=lambda r: (-r["score"], r["handle"]))
    for i, r in enumerate(rankings):
        r["rank"] = i + 1

    return rankings


def main():
    print(f"[{NOW}] Building ecosystem engagement rankings...")
    fourclaw = scan_4claw()
    chatr = scan_chatr()
    moltbook = scan_moltbook()
    rankings = compute_rankings(fourclaw, chatr, moltbook)

    output = {
        "version": 1,
        "generated_at": NOW,
        "generator": "ecosystem-ranking.py",
        "summary": {
            "total_agents": len(rankings),
            "platforms_scanned": ["4claw", "chatr", "moltbook"],
            "multi_platform": sum(1 for r in rankings if r["platform_count"] >= 2),
            "top_10": [{"handle": r["handle"], "score": r["score"], "platforms": r["platforms"]}
                       for r in rankings[:10]],
        },
        "rankings": rankings,
    }

    out_path = os.path.join(BASE_DIR, "ecosystem-ranking.json")
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n=== Top 20 ===")
    for r in rankings[:20]:
        plats = ",".join(r["platforms"])
        print(f"  #{r['rank']:>2} {r['handle']:<25} {r['score']:>6.1f}pts  [{plats}]")
    print(f"\nTotal: {len(rankings)} agents, {output['summary']['multi_platform']} multi-platform")
    print(f"Saved to {out_path}")


if __name__ == "__main__":
    main()

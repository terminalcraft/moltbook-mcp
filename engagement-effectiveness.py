#!/usr/bin/env python3
"""Analyze engagement session effectiveness per platform.

Primary source: engagement-log.json (structured, written by post-hook).
Fallback: session-history.txt (heuristic parsing).

Usage: python3 engagement-effectiveness.py [--json]
"""
import re, sys, json
from pathlib import Path
from collections import defaultdict

HOME = Path.home()
LOG_FILE = HOME / ".config/moltbook/engagement-log.json"
HISTORY = HOME / ".config/moltbook/session-history.txt"

PLATFORM_PATTERNS = {
    "4claw": [r"\b4claw\b", r"\bfourclaw\b"],
    "chatr": [r"\bchatr\b"],
    "moltbook": [r"\bmoltbook\b"],
    "colony": [r"\bcolony\b", r"\bthecolony\b", r"\bColonist"],
    "mdi": [r"\bmdi\b", r"\bmydeadinternet\b"],
    "tulip": [r"\btulip\b"],
    "grove": [r"\bgrove\b"],
    "moltchan": [r"\bmoltchan\b"],
    "lobchan": [r"\blobchan\b"],
    "ctxly": [r"\bctxly\b"],
    "lobstack": [r"\blobstack\b"],
}


def load_structured_log():
    """Load engagement-log.json if available."""
    if not LOG_FILE.exists():
        return None
    try:
        data = json.loads(LOG_FILE.read_text())
        return data if isinstance(data, list) and len(data) > 0 else None
    except:
        return None


def analyze_structured(entries):
    """Analyze from structured engagement log."""
    platforms = defaultdict(lambda: {
        "mentions": 0, "active": 0, "productive": 0, "degraded": 0,
        "actions": defaultdict(int), "sessions": [], "total_cost": 0
    })

    for entry in entries:
        session_id = entry.get("session", 0)
        cost = entry.get("cost_usd", 0)
        for ix in entry.get("interactions", []):
            pid = ix["platform"]
            p = platforms[pid]
            p["mentions"] += 1
            p["sessions"].append(session_id)
            p["total_cost"] += cost / max(entry.get("platforms_engaged", 1), 1)
            outcome = ix.get("outcome", "neutral")
            if outcome in ("active", "productive"):
                p["active"] += 1
            if outcome == "productive":
                p["productive"] += 1
            if outcome == "degraded":
                p["degraded"] += 1
            for action in ix.get("actions", []):
                p["actions"][action] += 1

    result_platforms = {}
    for pid in PLATFORM_PATTERNS:
        p = platforms.get(pid)
        if not p or p["mentions"] == 0:
            result_platforms[pid] = {"mentions": 0, "effectiveness": 0, "recommendation": "unengaged"}
            continue

        # Effectiveness score: active rate - degraded rate, weighted by productivity
        active_rate = p["active"] / p["mentions"]
        degraded_rate = p["degraded"] / p["mentions"]
        productive_bonus = (p["productive"] / p["mentions"]) * 0.5
        effectiveness = round((active_rate - degraded_rate + productive_bonus) * 10, 1)

        rec = "promote" if effectiveness >= 7 else "maintain" if effectiveness >= 3 else "demote" if effectiveness >= 0 else "avoid"

        result_platforms[pid] = {
            "mentions": p["mentions"],
            "active_rate": round(active_rate, 2),
            "degraded_rate": round(degraded_rate, 2),
            "productive_rate": round(p["productive"] / p["mentions"], 2),
            "effectiveness": effectiveness,
            "top_actions": dict(sorted(dict(p["actions"]).items(), key=lambda x: -x[1])[:5]),
            "avg_cost": round(p["total_cost"] / p["mentions"], 2),
            "sessions": p["sessions"][-5:],
            "recommendation": rec,
        }

    ranked = dict(sorted(result_platforms.items(), key=lambda x: x[1].get("effectiveness", 0), reverse=True))

    total_cost = sum(e.get("cost_usd", 0) for e in entries)
    return {
        "source": "engagement-log.json",
        "e_sessions_analyzed": len(entries),
        "avg_cost": round(total_cost / len(entries), 2) if entries else 0,
        "platforms": ranked,
        "tier_suggestions": {
            pid: data["recommendation"]
            for pid, data in ranked.items()
            if data.get("recommendation") in ("promote", "demote", "avoid")
        },
    }


def analyze_fallback():
    """Fallback: parse session-history.txt heuristically."""
    if not HISTORY.exists():
        return {"error": "No engagement data", "source": "none", "platforms": {}}

    sessions = []
    for line in HISTORY.read_text().splitlines():
        m = re.match(r"(\S+)\s+mode=E\s+s=(\d+)\s+dur=(\S+)\s+cost=\$?([\d.]+).*note:\s*(.*)", line)
        if not m:
            continue
        sessions.append({
            "date": m.group(1), "session": int(m.group(2)),
            "cost": float(m.group(4)), "note": m.group(5),
        })

    if not sessions:
        return {"error": "No E sessions found", "source": "history-fallback", "platforms": {}}

    POSITIVE = [(r"\b(replied|commented|posted|registered|opened)\b", 2),
                (r"\b(collaboration|interop|exchange)\b", 3), (r"\bgood content\b", 2), (r"\bhealthy\b", 1)]
    NEGATIVE = [(r"\bbroken\b", -2), (r"\b(dead|empty)\b", -2),
                (r"\brate.?limit\b", -1), (r"\b(401|403|error)\b", -1), (r"\bquiet\b", -1)]

    platforms = {}
    for pid, patterns in PLATFORM_PATTERNS.items():
        mentions, total_score, sids = 0, 0, []
        for s in sessions:
            if not any(re.search(p, s["note"], re.I) for p in patterns):
                continue
            mentions += 1
            sids.append(s["session"])
            score = sum(w for pat, w in POSITIVE if re.search(pat, s["note"], re.I))
            score += sum(w for pat, w in NEGATIVE if re.search(pat, s["note"], re.I))
            total_score += score

        if mentions == 0:
            platforms[pid] = {"mentions": 0, "effectiveness": 0, "recommendation": "unengaged"}
            continue

        avg = round(total_score / mentions, 1)
        rec = "promote" if avg >= 2 else "maintain" if avg >= 0 else "demote"
        platforms[pid] = {
            "mentions": mentions, "avg_score": avg, "effectiveness": avg,
            "sessions": sids[-5:], "recommendation": rec,
        }

    ranked = dict(sorted(platforms.items(), key=lambda x: x[1].get("effectiveness", 0), reverse=True))
    return {
        "source": "history-fallback",
        "e_sessions_analyzed": len(sessions),
        "avg_cost": round(sum(s["cost"] for s in sessions) / len(sessions), 2),
        "platforms": ranked,
    }


def analyze():
    structured = load_structured_log()
    if structured:
        return analyze_structured(structured)
    return analyze_fallback()


if __name__ == "__main__":
    result = analyze()
    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
    else:
        print(f"Source: {result.get('source', '?')}")
        print(f"E sessions analyzed: {result['e_sessions_analyzed']} (avg cost: ${result['avg_cost']})")
        print()
        for pid, data in result["platforms"].items():
            if data["mentions"] == 0:
                print(f"  {pid:12s}  — no data")
            else:
                eff = data.get("effectiveness", 0)
                print(f"  {pid:12s}  mentions={data['mentions']:2d}  eff={eff:+.1f}  → {data['recommendation']}")
        if result.get("tier_suggestions"):
            print(f"\nTier suggestions: {json.dumps(result['tier_suggestions'])}")

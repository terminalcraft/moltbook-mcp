#!/usr/bin/env python3
"""Analyze engagement session effectiveness per platform.

Parses session-history.txt for E sessions, extracts platform mentions,
and scores each platform by interaction quality.

Usage: python3 engagement-effectiveness.py [--json]
"""
import re, sys, json
from pathlib import Path
from collections import defaultdict

HISTORY = Path.home() / ".config/moltbook/session-history.txt"

# Platform detection patterns (platform_id -> list of regex patterns)
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

# Positive interaction signals (weighted)
POSITIVE_SIGNALS = [
    (r"\b(replied|commented|posted|registered|opened)\b", 2),
    (r"\b(collaboration|interop|exchange)\b", 3),
    (r"\bgood content\b", 2),
    (r"\bhealthy\b", 1),
]

# Negative signals
NEGATIVE_SIGNALS = [
    (r"\bbroken\b", -2),
    (r"\b(dead|empty)\b", -2),
    (r"\brate.?limit\b", -1),
    (r"\b(401|403|error)\b", -1),
    (r"\bquiet\b", -1),
]

def parse_sessions():
    if not HISTORY.exists():
        return []
    sessions = []
    for line in HISTORY.read_text().splitlines():
        m = re.match(r"(\S+)\s+mode=E\s+s=(\d+)\s+dur=(\S+)\s+cost=\$?([\d.]+).*note:\s*(.*)", line)
        if not m:
            continue
        sessions.append({
            "date": m.group(1),
            "session": int(m.group(2)),
            "duration": m.group(3),
            "cost": float(m.group(4)),
            "note": m.group(5),
        })
    return sessions

def analyze():
    sessions = parse_sessions()
    if not sessions:
        return {"error": "No E sessions found", "platforms": {}}

    platforms = {}
    for pid, patterns in PLATFORM_PATTERNS.items():
        mentions = 0
        total_score = 0
        session_ids = []
        for s in sessions:
            note = s["note"]
            mentioned = any(re.search(p, note, re.I) for p in patterns)
            if not mentioned:
                continue
            mentions += 1
            session_ids.append(s["session"])
            score = 0
            for pat, weight in POSITIVE_SIGNALS:
                # Only count if near platform mention
                if re.search(pat, note, re.I):
                    score += weight
            for pat, weight in NEGATIVE_SIGNALS:
                if re.search(pat, note, re.I):
                    score += weight
            total_score += score

        if mentions == 0:
            platforms[pid] = {"mentions": 0, "avg_score": 0, "sessions": [], "recommendation": "unengaged"}
            continue

        avg = round(total_score / mentions, 1)
        rec = "promote" if avg >= 2 else "maintain" if avg >= 0 else "demote"
        platforms[pid] = {
            "mentions": mentions,
            "avg_score": avg,
            "total_score": total_score,
            "sessions": session_ids[-5:],  # last 5
            "recommendation": rec,
        }

    # Sort by avg_score descending
    ranked = dict(sorted(platforms.items(), key=lambda x: x[1]["avg_score"], reverse=True))

    return {
        "e_sessions_analyzed": len(sessions),
        "avg_cost": round(sum(s["cost"] for s in sessions) / len(sessions), 2),
        "platforms": ranked,
    }

if __name__ == "__main__":
    result = analyze()
    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
    else:
        print(f"E sessions analyzed: {result['e_sessions_analyzed']} (avg cost: ${result['avg_cost']})")
        print()
        for pid, data in result["platforms"].items():
            if data["mentions"] == 0:
                print(f"  {pid:12s}  — no engagement data")
            else:
                print(f"  {pid:12s}  mentions={data['mentions']:2d}  score={data['avg_score']:+.1f}  → {data['recommendation']}")

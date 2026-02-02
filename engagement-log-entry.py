#!/usr/bin/env python3
"""Write a single engagement log entry for an E session.

Called by post-hook 17-engagement-log.sh.
Args: session_num
Reads session note from session-history.txt, writes to engagement-log.json.
"""
import json, re, sys
from pathlib import Path
from datetime import datetime

if len(sys.argv) < 2:
    print("Usage: engagement-log-entry.py <session_num>", file=sys.stderr)
    sys.exit(1)

session_num = int(sys.argv[1])
HISTORY = Path.home() / ".config/moltbook/session-history.txt"
LOG_FILE = Path.home() / ".config/moltbook/engagement-log.json"

PLATFORMS = {
    "4claw": [r"\b4claw\b", r"\bfourclaw\b"],
    "chatr": [r"\bchatr\b"],
    "moltbook": [r"\bmoltbook\b"],
    "colony": [r"\bcolony\b", r"\bthecolony\b"],
    "mdi": [r"\bmdi\b", r"\bmydeadinternet\b"],
    "tulip": [r"\btulip\b"],
    "grove": [r"\bgrove\b"],
    "moltchan": [r"\bmoltchan\b"],
    "lobchan": [r"\blobchan\b"],
    "ctxly": [r"\bctxly\b"],
}

# Find session note
note_line = None
for line in HISTORY.read_text().splitlines():
    if re.search(rf"mode=E\s+s={session_num}\b", line):
        note_line = line
        break

if not note_line:
    print(f"No E session note for s={session_num}")
    sys.exit(0)

# Parse cost
cost_m = re.search(r"cost=\$?([\d.]+)", note_line)
cost = float(cost_m.group(1)) if cost_m else 0

# Extract note
note_m = re.search(r"note:\s*(.*)", note_line)
note = note_m.group(1) if note_m else note_line


def classify(platform, patterns, note):
    """Context-aware: only check signals in clauses mentioning the platform."""
    clauses = re.split(r"[.]", note)
    relevant = [c for c in clauses if any(re.search(p, c, re.I) for p in patterns)]
    if not relevant:
        relevant = [note]
    ctx = " ".join(relevant)

    actions = []
    if re.search(r"\b(replied|commented)\b", ctx, re.I): actions.append("replied")
    if re.search(r"\bposted\b", ctx, re.I): actions.append("posted")
    if re.search(r"\bregistered\b", ctx, re.I): actions.append("registered")
    if re.search(r"\b(queued|sent)\b.*msg", ctx, re.I): actions.append("messaged")
    if re.search(r"\bscanned\b", ctx, re.I): actions.append("scanned")

    is_degraded = bool(re.search(r"\b(broken|dead|empty|401|403)\b", ctx, re.I))
    is_productive = bool(re.search(r"\b(collaboration|interop|exchange|good content)\b", ctx, re.I))

    if is_productive:
        return actions or ["mentioned"], "productive"
    if is_degraded and not actions:
        return actions or ["mentioned"], "degraded"
    if actions:
        return actions, "active"
    return ["mentioned"], "neutral"


interactions = []
for plat, patterns in PLATFORMS.items():
    if not any(re.search(p, note, re.I) for p in patterns):
        continue
    actions, outcome = classify(plat, patterns, note)
    interactions.append({"platform": plat, "actions": actions, "outcome": outcome})

entry = {
    "timestamp": datetime.now().isoformat(),
    "session": session_num,
    "cost_usd": cost,
    "platforms_engaged": len(interactions),
    "interactions": interactions,
}

# Load, append, cap, save
if LOG_FILE.exists():
    data = json.loads(LOG_FILE.read_text())
else:
    data = []
data.append(entry)
data = data[-200:]
LOG_FILE.write_text(json.dumps(data, indent=2))
print(f"engagement-log: s={session_num} logged {len(interactions)} platform interactions")

# Diversity warning: check last 5 E sessions
MIN_DIVERSITY = 3
WINDOW = 5
recent = [e for e in data if e.get("platforms_engaged", 0) > 0][-WINDOW:]
if len(recent) >= WINDOW:
    avg = sum(e["platforms_engaged"] for e in recent) / len(recent)
    if avg < MIN_DIVERSITY:
        sessions = [str(e.get("session", "?")) for e in recent]
        print(f"⚠ DIVERSITY WARNING: Last {WINDOW} E sessions averaged {avg:.1f} platforms (threshold: {MIN_DIVERSITY}). Sessions: {', '.join(sessions)}")

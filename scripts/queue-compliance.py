#!/usr/bin/env python3
"""Queue compliance tracker — measures how often B sessions complete their assigned wq item.

Reads: ~/.config/moltbook/logs/queue-compliance.log
Also cross-references work-queue.json completed array for historical data.

Output: JSON with compliance stats.
"""
import json
import os
import re
import sys
from pathlib import Path
from datetime import datetime

STATE_DIR = Path.home() / ".config" / "moltbook"
LOG_FILE = STATE_DIR / "logs" / "queue-compliance.log"
MCP_DIR = Path(__file__).resolve().parent.parent
WQ_FILE = MCP_DIR / "work-queue.json"
HISTORY_FILE = STATE_DIR / "session-history.txt"


def parse_compliance_log():
    """Parse the compliance log file."""
    entries = []
    if not LOG_FILE.exists():
        return entries
    for line in LOG_FILE.read_text().strip().split("\n"):
        if not line.strip():
            continue
        m = re.match(
            r"(\S+)\s+s=(\d+)\s+assigned=(\S+)(?:\s+title=\"([^\"]*)\")?\s+status=(\S+)",
            line,
        )
        if m:
            entries.append({
                "timestamp": m.group(1),
                "session": int(m.group(2)),
                "assigned": m.group(3),
                "title": m.group(4) or "",
                "status": m.group(5),
            })
    return entries


def infer_historical_compliance():
    """Cross-reference session history with work-queue.json to infer past compliance.

    B sessions since s395 (when injection started) that mention a wq item in their
    commit notes can be matched against the completed array.
    """
    if not WQ_FILE.exists() or not HISTORY_FILE.exists():
        return []

    wq = json.loads(WQ_FILE.read_text())
    completed_ids = {item["id"] for item in wq.get("completed", [])}

    # Map completed items to their notes for matching
    completed_items = {item["id"]: item for item in wq.get("completed", [])}

    # Parse session history for B sessions since s395
    inferred = []
    for line in HISTORY_FILE.read_text().strip().split("\n"):
        if not line.strip():
            continue
        m_mode = re.search(r"mode=B", line)
        m_session = re.search(r"s=(\d+)", line)
        if not m_mode or not m_session:
            continue
        session_num = int(m_session.group(1))
        if session_num < 395:  # injection started at s395
            continue

        # Check if session note mentions a wq item
        note = ""
        m_note = re.search(r"note:\s*(.+)$", line)
        if m_note:
            note = m_note.group(1)

        # Try to match against completed items by checking if the note references queue work
        # This is approximate — the compliance log is the authoritative source
        inferred.append({
            "session": session_num,
            "note": note,
            "had_commits": "build=(none)" not in line,
        })

    return inferred


def compute_stats():
    entries = parse_compliance_log()
    historical = infer_historical_compliance()

    assigned = [e for e in entries if e["status"] != "no_assignment"]
    completed = [e for e in entries if e["status"] == "completed"]
    incomplete = [e for e in entries if e["status"] == "incomplete"]
    no_assignment = [e for e in entries if e["status"] == "no_assignment"]

    total_b = len(entries)
    compliance_rate = (len(completed) / len(assigned) * 100) if assigned else 0

    result = {
        "total_b_sessions_tracked": total_b,
        "assigned": len(assigned),
        "completed": len(completed),
        "incomplete": len(incomplete),
        "no_assignment": len(no_assignment),
        "compliance_rate_pct": round(compliance_rate, 1),
        "tracking_started": "now" if not entries else entries[0]["timestamp"],
        "recent": entries[-10:] if entries else [],
        "historical_b_sessions_since_injection": len(historical),
        "note": "Compliance log is new — data accumulates from this session forward."
        if not entries
        else None,
    }

    # Remove None values
    result = {k: v for k, v in result.items() if v is not None}
    return result


if __name__ == "__main__":
    stats = compute_stats()
    print(json.dumps(stats, indent=2))

#!/usr/bin/env python3
"""Detect gaps in session numbering from outcomes.log.
Reports missing session numbers and sessions without summaries."""

import sys
import os
import re
from pathlib import Path

STATE_DIR = Path.home() / ".config" / "moltbook"
OUTCOMES = STATE_DIR / "logs" / "outcomes.log"
LOGS_DIR = STATE_DIR / "logs"

def main():
    if not OUTCOMES.exists():
        print("No outcomes.log found")
        return

    sessions = []
    for line in OUTCOMES.read_text().splitlines():
        m = re.search(r's=(\d+)', line)
        if m:
            sessions.append(int(m.group(1)))

    if not sessions:
        print("No sessions found in outcomes.log")
        return

    sessions.sort()
    min_s, max_s = sessions[0], sessions[-1]
    all_nums = set(sessions)

    # Find gaps
    gaps = sorted(set(range(min_s, max_s + 1)) - all_nums)

    # Find sessions without summaries
    log_files = list(LOGS_DIR.glob("*.log"))
    summaries = {f.stem for f in LOGS_DIR.glob("*.summary")}
    missing_summaries = []
    for lf in log_files:
        if lf.name.startswith("20") and lf.stem not in summaries:
            size = lf.stat().st_size
            missing_summaries.append((lf.name, size))

    print(f"Session range: {min_s}–{max_s} ({len(sessions)} recorded)")
    if gaps:
        print(f"Missing sessions ({len(gaps)}): {', '.join(str(g) for g in gaps)}")
    else:
        print("No gaps detected")

    if missing_summaries:
        print(f"\nLogs without summaries ({len(missing_summaries)}):")
        for name, size in sorted(missing_summaries):
            print(f"  {name} ({size:,} bytes)")
    else:
        print("All logs have summaries")

if __name__ == "__main__":
    main()

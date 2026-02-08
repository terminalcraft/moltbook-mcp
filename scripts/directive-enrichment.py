#!/usr/bin/env python3
"""Directive enrichment for pre-session hooks.

Blocked queue items often reference directives (via queue_item field in directives.json).
Hooks like stale-blocker need to know if the linked directive has recent progress,
but they only see work-queue.json. This script enriches the hook environment by
writing directive-enrichment.json: a map of wq-id -> last directive activity session.
Hooks can read this to suppress false escalations for items with active directive progress.

Extracted from inline heartbeat.sh heredoc in R#215 for testability.

Usage: python3 directive-enrichment.py <directives.json> <work-queue.json> <output.json>
"""

import json
import re
import sys
from pathlib import Path


def compute_enrichment(directives_data, queue_data):
    """Compute directive enrichment map for blocked queue items.

    Returns dict mapping wq-id -> {directive_id, directive_status, last_activity_session, has_recent_notes}
    """
    # Build reverse map: queue_item -> directive
    qi_to_directive = {}
    for d in directives_data.get("directives", []):
        qi = d.get("queue_item")
        if qi:
            qi_to_directive[qi] = d
        # Also match items whose title contains the directive id
        did = d.get("id", "")
        for item in queue_data.get("queue", []):
            if item.get("status") == "blocked" and did in item.get("title", ""):
                qi_to_directive[item["id"]] = d

    enrichment = {}
    for item in queue_data.get("queue", []):
        if item.get("status") != "blocked":
            continue
        wid = item["id"]
        directive = qi_to_directive.get(wid)
        if not directive:
            continue
        # Extract most recent session number from directive notes
        notes = directive.get("notes", "")
        sessions = [int(m) for m in re.findall(r"s(\d{3,4})", notes)]
        sessions += [int(m) for m in re.findall(r"R#(\d+)", notes)]
        last_activity = max(sessions) if sessions else directive.get("acked_session", 0)
        enrichment[wid] = {
            "directive_id": directive.get("id"),
            "directive_status": directive.get("status"),
            "last_activity_session": last_activity,
            "has_recent_notes": len(notes) > 50,
        }

    return enrichment


def main():
    if len(sys.argv) != 4:
        print(f"Usage: {sys.argv[0]} <directives.json> <work-queue.json> <output.json>", file=sys.stderr)
        sys.exit(1)

    directives_file, queue_file, out_file = sys.argv[1], sys.argv[2], sys.argv[3]

    directives_data = json.loads(Path(directives_file).read_text())
    queue_data = json.loads(Path(queue_file).read_text())

    enrichment = compute_enrichment(directives_data, queue_data)

    Path(out_file).write_text(json.dumps(enrichment, indent=2) + "\n")


if __name__ == "__main__":
    main()

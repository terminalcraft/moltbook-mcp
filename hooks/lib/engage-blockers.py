#!/usr/bin/env python3
"""Extract platform failures from E session logs and queue engage-blocker items.

Extracted from 26-engage-blockers.sh (R#322). Previously embedded as a 175-line
Python heredoc in a bash script, making it untestable.

Usage: python3 engage-blockers.py <log_file> <wq_file> <wq_js> <ar_file>

Exit codes:
  0: success (failures may or may not have been detected)
  1: missing required arguments
"""

import json
import re
import os
import subprocess
import sys


FAILURE_PATTERNS = [
    "401", "403", "404", "500", "502", "503",
    "empty response", "empty body", "connection refused",
    "connection_error", "timed out", "timeout",
    "auth failed", "auth_failed", "unauthorized",
    "no_creds", "bad_creds", "token expired",
    "dns", "nxdomain", "unreachable",
]

REASON_MAP = [
    ("empty response", "empty response"),
    ("empty body", "empty response body"),
    ("connection refused", "connection refused"),
    ("timed out", "timeout"),
    ("auth failed", "auth failure"),
    ("auth_failed", "auth failure"),
    ("unauthorized", "unauthorized"),
    ("no_creds", "missing credentials"),
    ("token expired", "token expired"),
    ("unreachable", "unreachable"),
]

ASSISTANT_FAILURE_PATTERNS = [
    "auth broken", "returns empty", "api broken",
    "auth expired", "token invalid", "credentials invalid",
    "can't post", "cannot post", "write failed",
]


def extract_reason(text_lower):
    for pat in ["401", "403", "404", "500", "502", "503"]:
        if pat in text_lower:
            return f"HTTP {pat}"
    for pat, desc in REASON_MAP:
        if pat in text_lower:
            return desc
    return "platform error"


def check_text(text_lower, patterns):
    return any(pat in text_lower for pat in patterns)


def load_platforms(ar_file):
    """Build platform keyword map from account-registry.json."""
    platforms = {}
    degraded_platforms = set()

    if ar_file and os.path.isfile(ar_file):
        try:
            with open(ar_file) as f:
                registry = json.load(f)
            for acct in registry.get("accounts", []):
                status = acct.get("status", "")
                if status not in ("live", "active", "degraded"):
                    continue
                plat_id = acct.get("id", "")
                plat_name = acct.get("platform", "")
                if not plat_id:
                    continue
                keywords = set()
                keywords.add(plat_id.lower())
                keywords.add(plat_id.lower().replace("-", ""))
                if plat_name:
                    keywords.add(plat_name.lower())
                    cleaned = plat_name.lower().replace(" ", "").replace(".", "").replace("-", "")
                    if cleaned:
                        keywords.add(cleaned)
                    for word in re.split(r'[\s.\-_()]+', plat_name.lower()):
                        if len(word) > 5 and word not in ("vercel", "agency"):
                            keywords.add(word)
                platforms[plat_id] = list(keywords)
                if status == "degraded":
                    degraded_platforms.add(plat_id)
        except Exception as e:
            print(f"engage-blockers: failed to read account-registry: {e}", file=sys.stderr)

    if not platforms:
        platforms = {
            "moltchan": ["moltchan"],
            "moltbook": ["moltbook"],
            "chatr": ["chatr"],
            "moltstack": ["moltstack"],
            "grove": ["grove"],
            "bluesky": ["bluesky"],
        }

    return platforms, degraded_platforms


def scan_log(log_file, platforms):
    """Scan session log for platform failures."""
    failures = {}

    with open(log_file) as f:
        for line in f:
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue

            if obj.get("type") == "user":
                content = obj.get("message", {}).get("content", [])
                if isinstance(content, list):
                    for block in content:
                        text = block.get("text", "") if isinstance(block, dict) else str(block)
                        tl = text.lower()
                        for plat_id, keywords in platforms.items():
                            if not any(kw in tl for kw in keywords):
                                continue
                            if check_text(tl, FAILURE_PATTERNS):
                                failures.setdefault(plat_id, set()).add(extract_reason(tl))

            if obj.get("type") == "assistant":
                for block in obj.get("message", {}).get("content", []):
                    text = block.get("text", "") if isinstance(block, dict) else str(block)
                    tl = text.lower()
                    for plat_id, keywords in platforms.items():
                        if not any(kw in tl for kw in keywords):
                            continue
                        if check_text(tl, ASSISTANT_FAILURE_PATTERNS):
                            failures.setdefault(plat_id, set()).add("write failure detected in session")

    return failures


def filter_degraded(failures, degraded_platforms):
    """wq-860: Degraded platforms need 2+ distinct failure patterns to avoid noise."""
    for plat_id in list(failures.keys()):
        if plat_id in degraded_platforms and len(failures[plat_id]) < 2:
            del failures[plat_id]
    return failures


def dedup_against_queue(failures_flat, wq_file):
    """Remove failures that already have pending/blocked queue items."""
    try:
        with open(wq_file) as f:
            wq = json.load(f)
    except (json.JSONDecodeError, FileNotFoundError, OSError):
        wq = {"queue": []}

    existing = set()
    for item in wq.get("queue", []):
        if item.get("status") in ("pending", "blocked"):
            title_lower = item.get("title", "").lower()
            for plat_id in failures_flat:
                if plat_id.replace("-", "") in title_lower.replace("-", ""):
                    existing.add(plat_id)

    return {k: v for k, v in failures_flat.items() if k not in existing}


def queue_failures(new_failures, wq_js):
    """Add new failure items to work queue."""
    for plat_id, reason in new_failures.items():
        title = f"{plat_id} engagement broken — {reason}. Investigate and fix auth/API."
        try:
            subprocess.run(
                ["node", wq_js, "add", title, "engage-blocker"],
                capture_output=True, timeout=5
            )
            print(f"engage-blockers: queued {plat_id} ({reason})")
        except Exception as e:
            print(f"engage-blockers: failed to queue {plat_id}: {e}", file=sys.stderr)


def main():
    if len(sys.argv) < 5:
        print("Usage: engage-blockers.py <log_file> <wq_file> <wq_js> <ar_file>", file=sys.stderr)
        sys.exit(1)

    log_file, wq_file, wq_js, ar_file = sys.argv[1:5]

    if not log_file or not wq_file or not wq_js:
        sys.exit(0)

    platforms, degraded_platforms = load_platforms(ar_file)
    failures = scan_log(log_file, platforms)
    failures = filter_degraded(failures, degraded_platforms)

    if not failures:
        print("engage-blockers: no platform failures detected")
        sys.exit(0)

    failures_flat = {k: sorted(v)[0] for k, v in failures.items()}
    new_failures = dedup_against_queue(failures_flat, wq_file)

    if not new_failures:
        print(f"engage-blockers: {len(failures_flat)} failures detected, all already queued")
        sys.exit(0)

    queue_failures(new_failures, wq_js)


if __name__ == "__main__":
    main()

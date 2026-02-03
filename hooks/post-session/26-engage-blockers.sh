#!/bin/bash
# Post-hook: Auto-detect platform failures in E session logs and queue engage-blocker items.
# Only runs after E sessions. Greps for common failure patterns, deduplicates against
# existing queue items, and adds new ones via work-queue.js.
#
# Added by human operator. DO NOT REMOVE — this automates what E sessions used to do manually.

set -uo pipefail

[ "${MODE_CHAR:-}" = "E" ] || exit 0
[ -f "${LOG_FILE:-}" ] || exit 0

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WQ="$DIR/work-queue.json"
LOG_DIR="$HOME/.config/moltbook/logs"

log() { echo "$(date -Iseconds) [engage-blockers] $*" >> "$LOG_DIR/hooks.log"; }

# Extract platform failures from session log
export WQ_FILE="$WQ"
export WQ_JS="$DIR/work-queue.js"

python3 << 'PYEOF'
import json, re, os, subprocess, sys

log_file = os.environ.get("LOG_FILE", "")
wq_file = os.environ.get("WQ_FILE", "")
wq_js = os.environ.get("WQ_JS", "")

if not log_file or not wq_file or not wq_js:
    sys.exit(0)

# Read session log — extract tool results with errors
failures = {}  # platform -> description

with open(log_file) as f:
    for line in f:
        try:
            obj = json.loads(line)
        except:
            continue

        # Check tool results for failures
        if obj.get("type") == "user":
            content = obj.get("message", {}).get("content", [])
            if isinstance(content, list):
                for block in content:
                    text = block.get("text", "") if isinstance(block, dict) else str(block)
                    tl = text.lower()

                    # Match platform names with failure patterns
                    platforms = {
                        "colony": ["colony", "thecolony"],
                        "lobchan": ["lobchan"],
                        "moltchan": ["moltchan"],
                        "tulip": ["tulip"],
                        "grove": ["grove"],
                        "mdi": ["mydeadinternet", "mdi"],
                        "ctxly-chat": ["ctxly chat", "ctxly-chat"],
                        "lobstack": ["lobstack"],
                        "chatr": ["chatr"],
                        "moltbook": ["moltbook"],
                    }

                    for plat_id, keywords in platforms.items():
                        if not any(kw in tl for kw in keywords):
                            continue
                        # Check for failure indicators
                        if any(pat in tl for pat in [
                            "401", "403", "404", "500", "502", "503",
                            "empty response", "empty body", "connection refused",
                            "connection_error", "timed out", "timeout",
                            "auth failed", "auth_failed", "unauthorized",
                            "no_creds", "bad_creds", "token expired",
                            "dns", "nxdomain", "unreachable",
                        ]):
                            # Extract a short reason
                            reason = ""
                            for pat in ["401", "403", "404", "500", "502", "503"]:
                                if pat in tl:
                                    reason = f"HTTP {pat}"
                                    break
                            if not reason:
                                for pat, desc in [
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
                                ]:
                                    if pat in tl:
                                        reason = desc
                                        break
                            if not reason:
                                reason = "platform error"

                            if plat_id not in failures:
                                failures[plat_id] = reason

        # Also check assistant tool_use calls that mention platform errors
        if obj.get("type") == "assistant":
            for block in obj.get("message", {}).get("content", []):
                text = block.get("text", "")
                tl = text.lower()
                for plat_id, keywords in platforms.items():
                    if not any(kw in tl for kw in keywords):
                        continue
                    if any(pat in tl for pat in [
                        "auth broken", "returns empty", "api broken",
                        "auth expired", "token invalid", "credentials invalid",
                        "can't post", "cannot post", "write failed",
                    ]):
                        if plat_id not in failures:
                            failures[plat_id] = "write failure detected in session"

if not failures:
    print("engage-blockers: no platform failures detected")
    sys.exit(0)

# Dedup against existing queue items
try:
    with open(wq_file) as f:
        wq = json.load(f)
except:
    wq = {"queue": []}

existing = set()
for item in wq.get("queue", []):
    if item.get("status") in ("pending", "blocked"):
        title_lower = item.get("title", "").lower()
        for plat_id in failures:
            if plat_id.replace("-", "") in title_lower.replace("-", ""):
                existing.add(plat_id)

new_failures = {k: v for k, v in failures.items() if k not in existing}

if not new_failures:
    print(f"engage-blockers: {len(failures)} failures detected, all already queued")
    sys.exit(0)

# Add new items
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

PYEOF

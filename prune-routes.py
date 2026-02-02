#!/usr/bin/env python3
"""Route pruning tool — marks zero-hit API routes as deprecated via deprecation registry.
Uses /audit endpoint to find unused routes, adds them to deprecations.json.
Usage: python3 prune-routes.py [--apply] [--gone]
  --apply  Actually write to deprecations.json (default: dry run)
  --gone   Mark as 'gone' (410) instead of 'deprecated'
(wq-043, s453)
"""

import json, sys, urllib.request, os

BASE = os.path.dirname(os.path.abspath(__file__))
DEP_FILE = os.path.join(BASE, "deprecations.json")
AUDIT_URL = "http://localhost:3847/audit"

# Routes to never prune (core infrastructure)
PROTECTED = {
    "GET /health", "GET /agent.json", "GET /audit", "GET /dashboard",
    "POST /handshake", "POST /inbox",
    "POST /cross-agent/exchange", "POST /knowledge/exchange",  # core protocol
    "POST /routstr/chat", "POST /routstr/configure",  # newly added s450
    "POST /colony/post",  # platform write endpoint
    "GET /activity/stream",  # SSE endpoint, may have clients
    "DELETE /deprecations", "POST /deprecations",  # meta endpoints
}

apply_mode = "--apply" in sys.argv
gone_mode = "--gone" in sys.argv

# Fetch audit data
try:
    with urllib.request.urlopen(AUDIT_URL, timeout=5) as r:
        audit = json.loads(r.read())
except Exception as e:
    print(f"ERROR: Cannot reach {AUDIT_URL}: {e}")
    sys.exit(1)

zero_hit = audit.get("zero_hit", [])
if not zero_hit:
    print("No zero-hit routes found.")
    sys.exit(0)

# Load existing deprecations
try:
    with open(DEP_FILE) as f:
        deps = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    deps = {}

# Filter out protected and already-deprecated routes
candidates = [r for r in zero_hit if r not in PROTECTED and r not in deps]

if not candidates:
    print(f"All {len(zero_hit)} zero-hit routes are already deprecated or protected.")
    sys.exit(0)

status = "gone" if gone_mode else "deprecated"
print(f"{'APPLYING' if apply_mode else 'DRY RUN'}: {len(candidates)} routes to mark as '{status}'")
for route in sorted(candidates):
    print(f"  {route}")
    if apply_mode:
        deps[route] = {
            "status": status,
            "message": f"Auto-pruned: zero traffic detected by audit",
            "sunset": "2026-02-02",
        }

if apply_mode:
    with open(DEP_FILE, "w") as f:
        json.dump(deps, f, indent=2)
    print(f"\nWrote {len(candidates)} entries to {DEP_FILE}")
else:
    print(f"\nRe-run with --apply to write changes.")

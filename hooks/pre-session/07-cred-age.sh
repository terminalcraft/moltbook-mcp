#!/bin/bash
# Pre-hook: Credential staleness check
# Reads account-registry.json for all platform credentials.
# Tracks last-rotated dates in cred-rotation.json. Warns when stale.

set -euo pipefail

STATE_DIR="$HOME/.config/moltbook"
ROTATION_FILE="$STATE_DIR/cred-rotation.json"
REGISTRY="$HOME/moltbook-mcp/account-registry.json"
MAX_AGE_DAYS=90

mkdir -p "$STATE_DIR"

# Initialize rotation file if missing
if [ ! -f "$ROTATION_FILE" ]; then
  echo '{"credentials":{}}' > "$ROTATION_FILE"
fi

python3 - "$ROTATION_FILE" "$REGISTRY" "$MAX_AGE_DAYS" <<'PYEOF'
import json, sys, os
from datetime import datetime
from pathlib import Path

rotation_file, registry_file, max_age_days = sys.argv[1], sys.argv[2], int(sys.argv[3])
now = datetime.now()

# Load state
rot_data = json.load(open(rotation_file))
creds = rot_data.setdefault("credentials", {})

# Load registry
try:
    registry = json.load(open(registry_file))
    accounts = registry.get("accounts", [])
except Exception:
    accounts = []

# Sync registry into rotation tracking
for acct in accounts:
    aid = acct.get("id")
    if not aid:
        continue  # skip entries with no id (malformed)
    cred_file = acct.get("cred_file") or ""
    if cred_file:
        cred_file = os.path.expanduser(cred_file)
    else:
        continue  # skip accounts with no cred file
    if aid not in creds:
        creds[aid] = {"path": cred_file, "last_rotated": None, "first_seen": None}
    else:
        creds[aid]["path"] = cred_file  # keep path in sync

stale = []
missing = []
ok_count = 0

for name, info in creds.items():
    path = info.get("path") or ""
    if not path:
        continue
    path = os.path.expanduser(path)
    last_rotated = info.get("last_rotated")

    if not os.path.exists(path):
        missing.append(name)
        continue

    if last_rotated:
        rot_date = datetime.fromisoformat(last_rotated)
        if rot_date.tzinfo is not None:
            rot_date = rot_date.replace(tzinfo=None)
    else:
        rot_date = datetime.fromtimestamp(os.path.getmtime(path))
        if not info.get("first_seen"):
            info["first_seen"] = rot_date.isoformat()

    age_days = (now - rot_date).days
    if age_days > max_age_days:
        stale.append(f"{name}: {age_days}d old (max {max_age_days}d)")
    else:
        ok_count += 1

# Save
with open(rotation_file, 'w') as f:
    json.dump(rot_data, f, indent=2)
    f.write('\n')

# Report
total = len(creds)
if stale:
    print(f"⚠ cred-age: {len(stale)} stale, {ok_count} ok, {len(missing)} missing (of {total})")
    for s in stale:
        print(f"  - {s}")
    alert_path = os.path.expanduser("~/.config/moltbook/cred-age-alert.txt")
    with open(alert_path, 'w') as af:
        af.write("## CREDENTIAL STALENESS WARNING\n")
        for s in stale:
            af.write(f"- {s}\n")
        if missing:
            af.write(f"\nMissing cred files: {', '.join(missing)}\n")
else:
    print(f"cred-age: {ok_count} ok, {len(missing)} missing (of {total}, max {max_age_days}d)")
PYEOF

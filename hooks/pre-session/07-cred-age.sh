#!/bin/bash
# Pre-hook: Credential staleness check (wq-014)
# Tracks last-rotated dates for credentials. Warns when any credential is older than MAX_AGE_DAYS.
# State file: ~/.config/moltbook/cred-rotation.json

set -euo pipefail

STATE_DIR="$HOME/.config/moltbook"
ROTATION_FILE="$STATE_DIR/cred-rotation.json"
MAX_AGE_DAYS=90
NOW_EPOCH=$(date +%s)

# Initialize rotation tracking if missing
if [ ! -f "$ROTATION_FILE" ]; then
  cat > "$ROTATION_FILE" <<'JSON'
{
  "credentials": {
    "api-token": {
      "path": "~/.config/moltbook/api-token",
      "last_rotated": null,
      "first_seen": null
    },
    "credentials.json:api_key": {
      "path": "~/.config/moltbook/credentials.json",
      "last_rotated": null,
      "first_seen": null
    }
  }
}
JSON
fi

# Check file ages as proxy for rotation date (if last_rotated is null, use file mtime)
python3 - "$ROTATION_FILE" "$MAX_AGE_DAYS" "$NOW_EPOCH" <<'PYEOF'
import json, sys, os
from datetime import datetime, timedelta
from pathlib import Path

rotation_file, max_age_days, now_epoch = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
now = datetime.fromtimestamp(now_epoch)

data = json.load(open(rotation_file))
creds = data.get("credentials", {})
stale = []

for name, info in creds.items():
    path = os.path.expanduser(info.get("path", ""))
    last_rotated = info.get("last_rotated")

    if last_rotated:
        rot_date = datetime.fromisoformat(last_rotated)
    elif os.path.exists(path):
        rot_date = datetime.fromtimestamp(os.path.getmtime(path))
        # Record first_seen if not set
        if not info.get("first_seen"):
            info["first_seen"] = rot_date.isoformat()
    else:
        continue

    age_days = (now - rot_date).days
    if age_days > max_age_days:
        stale.append(f"{name}: {age_days} days old (max {max_age_days})")

# Save any updates
with open(rotation_file, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')

if stale:
    print(f"⚠ cred-age: {len(stale)} stale credential(s):")
    for s in stale:
        print(f"  - {s}")
    # Write alert
    alert_path = os.path.expanduser("~/.config/moltbook/cred-age-alert.txt")
    with open(alert_path, 'w') as af:
        af.write("## CREDENTIAL STALENESS WARNING\n")
        for s in stale:
            af.write(f"- {s}\n")
        af.write("\nConsider rotating these credentials. Update cred-rotation.json after rotation.\n")
else:
    print(f"cred-age: all {len(creds)} credentials OK (max age {max_age_days}d)")
PYEOF

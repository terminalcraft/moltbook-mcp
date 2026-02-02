#!/bin/bash
# Post-session hook: Store session summary in Ctxly cloud memory.
# Makes ecosystem-adoption automatic infrastructure instead of per-session effort.
# Depends on: 10-summarize.sh (generates .summary file first)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LOG_DIR="$HOME/.config/moltbook/logs"
SUMMARY_FILE="${LOG_FILE%.log}.summary"

if [ ! -f "$SUMMARY_FILE" ]; then
  exit 0
fi

# Use a small Python script for reliable JSON handling
python3 - "$DIR" "$SUMMARY_FILE" "${SESSION_NUM:-?}" "${MODE_CHAR:-?}" "$LOG_DIR" <<'PYEOF'
import json, subprocess, sys, os
from datetime import datetime

dir_path, summary_file, s_num, mode, log_dir = sys.argv[1:6]

# Load ctxly key
try:
    key = json.load(open(os.path.join(dir_path, "ctxly.json")))["api_key"]
except Exception:
    sys.exit(0)

# Parse summary
try:
    with open(summary_file) as f:
        lines = f.readlines()
except Exception:
    sys.exit(0)

commits = [l.strip().lstrip("- ") for l in lines if l.strip().startswith("- ")]
files_line = next((l for l in lines if l.startswith("Files changed:")), "")
files = files_line.split(":", 1)[1].strip() if ":" in files_line else "none"

memory = f"Session {s_num} ({mode}): {'; '.join(commits[:3]) or 'no commits'}. Files: {files}."[:500]

import urllib.request
req = urllib.request.Request(
    "https://ctxly.app/remember",
    data=json.dumps({"content": memory, "tags": ["session", "auto"]}).encode(),
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    method="POST"
)
try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        code = resp.status
except Exception as e:
    code = getattr(e, "code", 0) if hasattr(e, "code") else "err"

log_line = f"{datetime.now().isoformat()} s={s_num} ctxly_remember: HTTP {code}\n"
os.makedirs(log_dir, exist_ok=True)
with open(os.path.join(log_dir, "ctxly-sync.log"), "a") as f:
    f.write(log_line)
PYEOF

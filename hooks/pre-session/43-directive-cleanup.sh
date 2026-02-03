#!/bin/bash
# Pre-hook: Directive lifecycle cleanup detector (wq-153)
# Scans session files for references to completed directives and flags them
# for cleanup. Outputs warnings to session context.

set -euo pipefail

DIR="$HOME/moltbook-mcp"
STATE_DIR="$HOME/.config/moltbook"
OUTPUT_FILE="$STATE_DIR/directive-cruft.json"
DIRECTIVES="$DIR/directives.json"
SESSION_NUM="${SESSION_NUM:-0}"

mkdir -p "$STATE_DIR"

python3 - "$DIRECTIVES" "$DIR" "$OUTPUT_FILE" "$SESSION_NUM" <<'PYEOF'
import json, sys, re, os
from pathlib import Path

directives_file = sys.argv[1]
project_dir = Path(sys.argv[2])
output_file = Path(sys.argv[3])
session = int(sys.argv[4])

if session == 0:
    sys.exit(0)

# Load directives and get completed ones
try:
    with open(directives_file) as f:
        data = json.load(f)
except:
    print("DIRECTIVE_CLEANUP: Cannot read directives.json")
    sys.exit(0)

completed = set()
all_ids = set()
for d in data.get("directives", []):
    did = d.get("id", "")
    all_ids.add(did)
    if d.get("status") == "completed":
        completed.add(did)

if not completed:
    print("DIRECTIVE_CLEANUP: No completed directives to check")
    sys.exit(0)

# Files to scan for directive references
session_files = [
    "SESSION_BUILD.md",
    "SESSION_ENGAGE.md",
    "SESSION_REFLECT.md",
    "SESSION_AUDIT.md",
    "BRIEFING.md",
    "BRAINSTORMING.md",
]

# Pattern to match directive IDs (d001, d002, etc.)
# Also catch references to non-existent directive IDs
pattern = re.compile(r'\bd(\d{3})\b')

cruft = []
stale_refs = []  # References to non-existent directive IDs

for fname in session_files:
    fpath = project_dir / fname
    if not fpath.exists():
        continue

    content = fpath.read_text()
    lines = content.splitlines()

    for lineno, line in enumerate(lines, 1):
        matches = pattern.findall(line)
        for m in matches:
            did = f"d{m}"

            # Check if directive exists at all
            if did not in all_ids:
                stale_refs.append({
                    "file": fname,
                    "line": lineno,
                    "directive": did,
                    "reason": "non-existent",
                    "snippet": line.strip()[:100]
                })
            elif did in completed:
                cruft.append({
                    "file": fname,
                    "line": lineno,
                    "directive": did,
                    "reason": "completed",
                    "snippet": line.strip()[:100]
                })

# Write detailed report
report = {
    "session": session,
    "completed_directives": sorted(completed),
    "references_to_completed": cruft,
    "references_to_nonexistent": stale_refs,
    "total_cruft": len(cruft) + len(stale_refs)
}
output_file.write_text(json.dumps(report, indent=2) + "\n")

# Output summary
if cruft or stale_refs:
    print(f"DIRECTIVE_CLEANUP: {len(cruft) + len(stale_refs)} stale reference(s) found")

    if cruft:
        by_file = {}
        for c in cruft:
            by_file.setdefault(c["file"], []).append(c["directive"])
        for fname, dids in by_file.items():
            unique_dids = sorted(set(dids))
            print(f"  - {fname}: {', '.join(unique_dids)} (completed)")

    if stale_refs:
        by_file = {}
        for c in stale_refs:
            by_file.setdefault(c["file"], []).append(c["directive"])
        for fname, dids in by_file.items():
            unique_dids = sorted(set(dids))
            print(f"  - {fname}: {', '.join(unique_dids)} (non-existent)")

    print(f"  Details: ~/.config/moltbook/directive-cruft.json")
else:
    print(f"DIRECTIVE_CLEANUP: No stale directive references in session files")
PYEOF

#!/bin/bash
# Pre-hook: BRIEFING.md auto-staleness detector (wq-011)
# Parses BRIEFING.md into sections by ## headers, checks a state file
# for when each section was last confirmed/updated. Flags sections
# stale for >50 sessions. Outputs warnings that get injected into
# session context.

set -euo pipefail

BRIEFING="$HOME/moltbook-mcp/BRIEFING.md"
STATE_DIR="$HOME/.config/moltbook"
STATE_FILE="$STATE_DIR/briefing-staleness.json"
SESSION_NUM="${SESSION_NUM:-0}"
STALE_THRESHOLD=50

mkdir -p "$STATE_DIR"

# Initialize state if missing
if [ ! -f "$STATE_FILE" ]; then
  echo '{}' > "$STATE_FILE"
fi

python3 - "$BRIEFING" "$STATE_FILE" "$SESSION_NUM" "$STALE_THRESHOLD" <<'PYEOF'
import json, sys, re, os
from pathlib import Path

briefing_file = sys.argv[1]
state_file = sys.argv[2]
session = int(sys.argv[3])
threshold = int(sys.argv[4])

if session == 0:
    sys.exit(0)

home = Path.home()
mcp_dir = home / "moltbook-mcp"

content = Path(briefing_file).read_text()

# --- Phase 1: Section-level staleness (existing) ---
sections = []
for line in content.splitlines():
    m = re.match(r'^##\s+(.+)$', line)
    if m:
        sections.append(m.group(1).strip())

if not sections:
    print("BRIEFING_STALE: No sections found")
    sys.exit(0)

state = json.loads(Path(state_file).read_text())
changed = False
for sec in sections:
    if sec not in state:
        state[sec] = {"last_updated": session}
        changed = True
for key in list(state.keys()):
    if key not in sections:
        del state[key]
        changed = True
if changed:
    Path(state_file).write_text(json.dumps(state, indent=2) + "\n")

stale = []
for sec in sections:
    last = state[sec].get("last_updated", 0)
    age = session - last
    if age >= threshold:
        stale.append((sec, age))

if stale:
    print(f"BRIEFING_STALE: {len(stale)} section(s) need review:")
    for sec, age in stale:
        print(f"  - \"{sec}\" — {age} sessions since last update")
else:
    print(f"BRIEFING_STALE: All {len(sections)} sections fresh (threshold: {threshold})")

# --- Phase 2: Content-level reference checks ---
warnings = []

# 2a: File path references that don't exist
# Match ~/path, ~/.config/path, and bare filenames like backlog.md, work-queue.json
for m in re.finditer(r'~/([^\s,)]+)', content):
    p = home / m.group(1)
    if not p.exists():
        warnings.append(f"Missing file: ~/{m.group(1)}")

for m in re.finditer(r'\b(\w[\w.-]+\.(?:md|json|sh|mjs|js|txt|conf))\b', content):
    fname = m.group(1)
    # Skip common false positives and generic names
    if fname in ('agent.json', 'session-history.txt', 'package.json'):
        continue
    candidates = [mcp_dir / fname, home / fname]
    # Also check common subdirectories
    for sub in ('hooks/pre-session', 'hooks/post-session'):
        candidates.append(mcp_dir / sub / fname)
    if not any(c.exists() for c in candidates):
        warnings.append(f"Referenced file not found locally: {fname}")

# 2b: Session references that are very old (>200 sessions ago)
old_refs = set()
for m in re.finditer(r'\b[sS](\d{3,4})\b', content):
    ref_session = int(m.group(1))
    if session - ref_session > 200:
        old_refs.add(ref_session)
if old_refs:
    oldest = min(old_refs)
    warnings.append(f"{len(old_refs)} old session refs (oldest: s{oldest}, {session - oldest} sessions ago) — consider pruning")

# 2c: "Next X: session NNN" where NNN is in the past
for m in re.finditer(r'[Nn]ext\s+\w+:\s+session\s+(\d+)', content):
    target = int(m.group(1))
    if target < session:
        warnings.append(f"Overdue scheduled check: 'next ... session {target}' (current: {session})")

# 2d: Version numbers — flag if version ref is >0.10.0 behind current
# (just detect presence, agent decides if stale)
versions = re.findall(r'\bVersion:\s*([\d.]+)', content)
if versions:
    for v in versions:
        warnings.append(f"Version reference: {v} — verify still current")

if warnings:
    print(f"BRIEFING_REFS: {len(warnings)} reference issue(s):")
    for w in warnings:
        print(f"  - {w}")
else:
    print("BRIEFING_REFS: All references valid")
PYEOF

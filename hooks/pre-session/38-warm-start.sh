#!/bin/bash
# Pre-hook: Generate session warm-start context cache.
# Reads session-history.txt + work-queue.json + engagement-intel.json
# and writes a single session-context.md for the agent to consume.
# Runs for ALL session types. (wq-042, s453)

STATE_DIR="$HOME/.config/moltbook"
MCP_DIR="$HOME/moltbook-mcp"
OUTPUT_FILE="$STATE_DIR/session-context.md"

python3 - "$STATE_DIR" "$MCP_DIR" "${SESSION_NUM:-?}" "${MODE_CHAR:-?}" "${B_FOCUS:-}" <<'PYEOF'
import json, sys, os

state_dir, mcp_dir, session_num, mode, b_focus = sys.argv[1:6]
lines = []

lines.append(f"# Session {session_num} ({mode}) Context")
if mode == "B" and b_focus:
    lines.append(f"B_FOCUS={b_focus}")
lines.append("")

# 1. Work queue — top 3 items with status
wq_file = os.path.join(mcp_dir, "work-queue.json")
try:
    with open(wq_file) as f:
        wq = json.load(f)
    items = wq.get("queue", [])[:4]
    if items:
        lines.append("## Work Queue (top items)")
        for it in items:
            tag = ",".join(it.get("tags", []))
            lines.append(f"- [{it['status']}] **{it['id']}**: {it['title']}" + (f" ({tag})" if tag else ""))
            if it.get("notes"):
                # Truncate notes to 120 chars
                n = it["notes"][:120]
                lines.append(f"  > {n}{'...' if len(it.get('notes',''))>120 else ''}")
        lines.append("")
except Exception:
    pass

# 2. Recent session history — last 5 entries
hist_file = os.path.join(state_dir, "session-history.txt")
try:
    with open(hist_file) as f:
        history = [l.strip() for l in f if l.strip()]
    recent = history[-5:]
    if recent:
        lines.append("## Recent Sessions")
        for entry in recent:
            lines.append(f"- {entry}")
        lines.append("")
except FileNotFoundError:
    pass

# 3. Engagement intel — last 4 entries (compact)
intel_file = os.path.join(state_dir, "engagement-intel.json")
try:
    with open(intel_file) as f:
        intel = json.load(f)
    if intel:
        recent_intel = intel[-4:]
        lines.append("## Engagement Intel")
        for item in recent_intel:
            typ = item.get("type", "?")
            summary = item.get("summary", "")
            sess = item.get("session", "?")
            lines.append(f"- [{typ}] (s{sess}) {summary}")
        lines.append("")
except Exception:
    pass

output = os.path.join(state_dir, "session-context.md")
with open(output, "w") as f:
    f.write("\n".join(lines))

print(f"warm-start: wrote {len(lines)} lines to session-context.md")
PYEOF

#!/bin/bash
# Pre-hook: Trim dialogue.md before R sessions.
# Keeps: header, open directives (Status != Done), last 5 agent summaries.
# Archives removed content to dialogue-archive.md.
# Only runs for R sessions. (s467, R#40)

[ "$MODE_CHAR" = "R" ] || exit 0

MCP_DIR="$HOME/moltbook-mcp"
DIALOGUE="$MCP_DIR/dialogue.md"
ARCHIVE="$MCP_DIR/dialogue-archive.md"

[ -f "$DIALOGUE" ] || exit 0

python3 - "$DIALOGUE" "$ARCHIVE" <<'PYEOF'
import sys, re

dialogue_path, archive_path = sys.argv[1], sys.argv[2]

with open(dialogue_path) as f:
    content = f.read()

# Split into sections by ## or ### headers
sections = re.split(r'(?=^##[# ])', content, flags=re.MULTILINE)

header = sections[0] if sections else ""  # Everything before first ##
entries = sections[1:] if len(sections) > 1 else []

keep = []
archive = []

# Classify each section
agent_summaries = []  # (index, section) for agent session summaries
for i, entry in enumerate(entries):
    lines = entry.strip()

    # Human directives with non-Done status — always keep
    if 'Human' in entry.split('\n')[0] or 'directive' in entry.split('\n')[0].lower():
        if '**Status**: Done' not in entry and '**Status**:' in entry:
            keep.append(entry)
            continue
        elif '**Status**: Done' in entry:
            archive.append(entry)
            continue
        # Human directive without any status marker — keep (open)
        if 'Human' in entry.split('\n')[0]:
            keep.append(entry)
            continue

    # Agent session summaries — collect to keep last 5
    if re.match(r'^##[# ]+Session \d+', entry):
        agent_summaries.append((i, entry))
        continue

    # Anything else — keep
    keep.append(entry)

# Keep last 5 agent summaries, archive the rest
if len(agent_summaries) > 5:
    for _, entry in agent_summaries[:-5]:
        archive.append(entry)
    for _, entry in agent_summaries[-5:]:
        keep.append(entry)
else:
    for _, entry in agent_summaries:
        keep.append(entry)

if not archive:
    print("dialogue-trim: nothing to archive")
    sys.exit(0)

# Write archive (append)
with open(archive_path, "a") as f:
    f.write(f"\n\n<!-- Archived by pre-hook s{__import__('os').environ.get('SESSION_NUM', '?')} -->\n")
    for entry in archive:
        f.write(entry)

# Write trimmed dialogue
with open(dialogue_path, "w") as f:
    f.write(header)
    for entry in keep:
        f.write(entry)

original_lines = content.count('\n')
new_content = header + ''.join(keep)
new_lines = new_content.count('\n')
print(f"dialogue-trim: {original_lines} -> {new_lines} lines ({len(archive)} sections archived)")
PYEOF

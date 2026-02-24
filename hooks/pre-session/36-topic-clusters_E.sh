#!/bin/bash
# Pre-hook: Populate Chatr thread state and inject topic cluster recommendations into E session context.
# Depends on: 36-engagement-seed_E.sh (creates e-session-context.md first)
# wq-595: Integrate chatr-topic-clusters into E session prompt
# Only runs for E sessions (enforced by _E.sh filename suffix).

cd /home/moltbot/moltbook-mcp

STATE_DIR="$HOME/.config/moltbook"
CONTEXT_FILE="$STATE_DIR/e-session-context.md"

# Step 1: Update Chatr thread state (fetches new messages, builds thread map)
echo "[topic-clusters] Updating Chatr thread state..."
update_out=$(timeout 10 node chatr-thread-tracker.mjs update --json 2>/dev/null)
update_exit=$?

if [ $update_exit -eq 124 ]; then
  echo "[topic-clusters] Thread tracker timed out (10s), using stale state"
elif [ $update_exit -ne 0 ]; then
  echo "[topic-clusters] Thread tracker failed (exit $update_exit), trying clusters with existing state"
fi

# Step 2: Run topic cluster analysis
clusters_json=$(timeout 8 node chatr-topic-clusters.mjs --json --hours 72 2>/dev/null)
clusters_exit=$?

if [ $clusters_exit -ne 0 ] || [ -z "$clusters_json" ]; then
  echo "[topic-clusters] No cluster data available (exit $clusters_exit), skipping"
  exit 0
fi

# Step 3: Extract recommendations and append to e-session-context.md
recs=$(echo "$clusters_json" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except:
    sys.exit(0)

recs = data.get('recommendations', [])
clusters = data.get('clusters', [])
thread_count = data.get('threadCount', 0)
cluster_count = data.get('clusterCount', 0)

if not recs and not clusters:
    sys.exit(0)

lines = []
lines.append('## Chatr topic clusters (auto-generated)')
lines.append(f'{thread_count} threads in {cluster_count} clusters (last 72h)')
lines.append('')

if recs:
    lines.append('**Recommended engagement targets:**')
    for r in recs:
        who = ', '.join('@' + p for p in r.get('participants', []))
        who_str = f' ({who})' if who else ''
        lines.append(f'- **{r[\"topic\"]}**: {r[\"reason\"]}{who_str}')
    lines.append('')

if clusters:
    lines.append('**Cluster overview:**')
    for c in clusters[:5]:
        tag = '[engaged]' if c.get('engaged') and c.get('engagementGap', 0) == 0 else '[gap]' if c.get('engagementGap', 0) > 0 else '[unengaged]'
        lines.append(f'- {c[\"label\"]} {tag}: {c[\"threadCount\"]} threads, {c[\"totalMessages\"]} msgs')
    lines.append('')

print('\n'.join(lines))
" 2>/dev/null)

if [ -n "$recs" ]; then
  echo "" >> "$CONTEXT_FILE"
  echo "$recs" >> "$CONTEXT_FILE"
  line_count=$(echo "$recs" | wc -l)
  echo "[topic-clusters] Appended $line_count lines to e-session-context.md"
else
  echo "[topic-clusters] No recommendations to inject"
fi

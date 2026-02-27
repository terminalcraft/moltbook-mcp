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
# wq-705: Replaced python3 with jq for JSON parsing
recs=$(echo "$clusters_json" | jq -r '
  if ((.recommendations // []) | length) == 0 and ((.clusters // []) | length) == 0 then empty else

  "## Chatr topic clusters (auto-generated)",
  "\(.threadCount // 0) threads in \(.clusterCount // 0) clusters (last 72h)",
  "",

  (if ((.recommendations // []) | length) > 0 then
    "**Recommended engagement targets:**",
    (.recommendations[] |
      ([.participants[]? | "@" + .] | join(", ")) as $who |
      (if ($who | length) > 0 then " (\($who))" else "" end) as $who_str |
      "- **\(.topic)**: \(.reason)\($who_str)"
    ),
    ""
  else empty end),

  (if ((.clusters // []) | length) > 0 then
    "**Cluster overview:**",
    (.clusters[:5][] |
      (if .engaged and (.engagementGap // 0) == 0 then "[engaged]"
       elif (.engagementGap // 0) > 0 then "[gap]"
       else "[unengaged]" end) as $tag |
      "- \(.label) \($tag): \(.threadCount) threads, \(.totalMessages) msgs"
    ),
    ""
  else empty end)

  end
' 2>/dev/null)

if [ -n "$recs" ]; then
  echo "" >> "$CONTEXT_FILE"
  echo "$recs" >> "$CONTEXT_FILE"
  line_count=$(echo "$recs" | wc -l)
  echo "[topic-clusters] Appended $line_count lines to e-session-context.md"
else
  echo "[topic-clusters] No recommendations to inject"
fi

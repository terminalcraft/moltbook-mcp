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

# wq-705: Replaced python3 with jq+bash for credential staleness check
NOW_EPOCH=$(date +%s)

# Sync registry into rotation tracking — add new accounts, update paths
if [ -f "$REGISTRY" ]; then
  TMP_ROT=$(mktemp)
  jq --slurpfile reg "$REGISTRY" '
    .credentials as $creds |
    reduce ($reg[0].accounts // [] | .[] | select(.id != null and .cred_file != null and .cred_file != "")) as $acct (.;
      ($acct.cred_file | gsub("^~"; env.HOME)) as $path |
      if .credentials[$acct.id] then
        .credentials[$acct.id].path = $path
      else
        .credentials[$acct.id] = {"path": $path, "last_rotated": null, "first_seen": null}
      end
    )
  ' "$ROTATION_FILE" > "$TMP_ROT" && mv "$TMP_ROT" "$ROTATION_FILE"
fi

# Check each credential for staleness
STALE=()
MISSING=()
OK_COUNT=0

# Iterate through credentials using jq to extract name/path/last_rotated
while IFS=$'\t' read -r name path last_rotated; do
  [ -z "$path" ] && continue
  # Expand ~ in path
  path="${path/#\~/$HOME}"

  if [ ! -e "$path" ]; then
    MISSING+=("$name")
    continue
  fi

  if [ -n "$last_rotated" ] && [ "$last_rotated" != "null" ]; then
    ROT_EPOCH=$(date -d "$last_rotated" +%s 2>/dev/null || echo 0)
  else
    ROT_EPOCH=$(stat -c %Y "$path" 2>/dev/null || echo "$NOW_EPOCH")
    # Set first_seen if not set
    FIRST_SEEN=$(jq -r --arg name "$name" '.credentials[$name].first_seen // empty' "$ROTATION_FILE" 2>/dev/null)
    if [ -z "$FIRST_SEEN" ]; then
      FS_DATE=$(date -d "@$ROT_EPOCH" -Iseconds 2>/dev/null)
      TMP_FS=$(mktemp)
      jq --arg name "$name" --arg fs "$FS_DATE" '.credentials[$name].first_seen = $fs' "$ROTATION_FILE" > "$TMP_FS" && mv "$TMP_FS" "$ROTATION_FILE"
    fi
  fi

  AGE_DAYS=$(( (NOW_EPOCH - ROT_EPOCH) / 86400 ))
  if [ "$AGE_DAYS" -gt "$MAX_AGE_DAYS" ]; then
    STALE+=("$name: ${AGE_DAYS}d old (max ${MAX_AGE_DAYS}d)")
  else
    OK_COUNT=$((OK_COUNT + 1))
  fi
done < <(jq -r '.credentials | to_entries[] | [.key, .value.path, .value.last_rotated] | @tsv' "$ROTATION_FILE" 2>/dev/null)

TOTAL=$(jq '.credentials | length' "$ROTATION_FILE" 2>/dev/null || echo 0)

# Report
if [ "${#STALE[@]}" -gt 0 ]; then
  echo "cred-age: ${#STALE[@]} stale, $OK_COUNT ok, ${#MISSING[@]} missing (of $TOTAL)"
  for s in "${STALE[@]}"; do
    echo "  - $s"
  done
  # Write alert file
  ALERT_PATH="$STATE_DIR/cred-age-alert.txt"
  {
    echo "## CREDENTIAL STALENESS WARNING"
    for s in "${STALE[@]}"; do echo "- $s"; done
    if [ "${#MISSING[@]}" -gt 0 ]; then
      echo ""
      echo "Missing cred files: $(IFS=', '; echo "${MISSING[*]}")"
    fi
  } > "$ALERT_PATH"
else
  echo "cred-age: $OK_COUNT ok, ${#MISSING[@]} missing (of $TOTAL, max ${MAX_AGE_DAYS}d)"
fi

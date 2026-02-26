#!/bin/bash
# Pre-hook: Engagement platform liveness for E sessions.
# Opens circuits for degraded platforms so platform-picker excludes them.
# wq-197: Engagement platform liveness monitor
# R#271: Cache-first — skip live probe if cron-platform-probe.sh warmed cache <2h ago.
#        Live probe is fallback only. Saves ~12s on E session startup.
# R#275: Replace python3 subprocess with jq. Reduce live probe timeout 9s→5s.
#
# Only runs for E sessions (enforced by _E.sh filename suffix).

cd /home/moltbot/moltbook-mcp

CACHE_FILE="$HOME/.config/moltbook/liveness-cache.json"
CACHE_MAX_AGE=7200  # 2 hours in seconds (matches node CACHE_TTL_MS)

# Check if cache is fresh enough to skip live probe
cache_fresh=false
if [ -f "$CACHE_FILE" ]; then
  cache_mtime=$(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0)
  now=$(date +%s)
  cache_age=$(( now - cache_mtime ))
  if [ "$cache_age" -lt "$CACHE_MAX_AGE" ]; then
    cache_fresh=true
  fi
fi

if [ "$cache_fresh" = true ]; then
  echo "[liveness] Cache fresh (${cache_age}s old), skipping live probe."
  # Still print circuit summary from cached state for prompt visibility
  if [ -f "platform-circuits.json" ]; then
    open_count=$(jq '[to_entries[] | select(.value | type == "object" and .status == "open")] | length' platform-circuits.json 2>/dev/null || echo "?")
    echo "[liveness] Open circuits: $open_count (from cached probe)"
  fi
  echo "[liveness] Done."
  exit 0
fi

# Cache stale or missing — run live probe
echo "[liveness] Cache stale (${cache_age:-missing}s), probing live..."

# Hard timeout: 5s max — stale cache is acceptable fallback
output=$(timeout 5 node engagement-liveness-probe.mjs --session "${SESSION_NUM:-0}" 2>&1)
exit_code=$?

echo "$output"

if [ $exit_code -eq 124 ]; then
  echo "[liveness] WARNING: Probe exceeded 5s hard limit, killed. Using cached circuit state."
elif [ $exit_code -ne 0 ]; then
  echo "[liveness] WARNING: Probe failed (exit $exit_code), continuing with cached circuit state"
fi

echo "[liveness] Done."

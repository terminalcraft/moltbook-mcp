#!/bin/bash
# hooks/lib/cache-wrapper.sh — Generic caching wrapper for slow pre-session hooks.
# wq-547: Hooks source this and call cache_run to skip execution when cache is fresh.
#
# Usage in a hook:
#   source "$(dirname "$0")/lib/cache-wrapper.sh"
#   cache_run "service-liveness" 60 node service-liveness.mjs --update
#
# Arguments:
#   $1 = cache key (unique name, e.g. "service-liveness")
#   $2 = TTL in minutes (how long cached result stays valid)
#   $3... = command to execute if cache is stale
#
# Cache files: ~/.config/moltbook/hook-cache/<key>.json
# Format: { "timestamp": <epoch_seconds>, "session": <N>, "exit_code": <N>, "output": "..." }

HOOK_CACHE_DIR="${HOME}/.config/moltbook/hook-cache"
mkdir -p "$HOOK_CACHE_DIR" 2>/dev/null

# cache_run <key> <ttl_minutes> <command...>
# Returns the exit code of the cached/executed command.
cache_run() {
  local key="$1"
  local ttl_minutes="$2"
  shift 2
  local cmd=("$@")

  local cache_file="${HOOK_CACHE_DIR}/${key}.json"
  local now
  now=$(date +%s)
  local ttl_seconds=$((ttl_minutes * 60))

  # Check cache freshness
  if [ -f "$cache_file" ]; then
    local cached_ts
    cached_ts=$(jq -r '.timestamp // 0' "$cache_file" 2>/dev/null)
    if [ -n "$cached_ts" ] && [ "$cached_ts" != "null" ]; then
      local age=$(( now - cached_ts ))
      if [ "$age" -lt "$ttl_seconds" ]; then
        local remaining=$(( (ttl_seconds - age) / 60 ))
        echo "[cache] Using cached result for '${key}' (${remaining}m remaining)"
        # Replay cached output
        jq -r '.output // ""' "$cache_file" 2>/dev/null
        # Return cached exit code
        local cached_exit
        cached_exit=$(jq -r '.exit_code // 0' "$cache_file" 2>/dev/null)
        return "${cached_exit:-0}"
      fi
    fi
  fi

  # Cache miss or stale — execute command
  echo "[cache] Cache miss for '${key}', executing..."
  local output
  output=$("${cmd[@]}" 2>&1)
  local exit_code=$?

  # Print output
  echo "$output"

  # Write cache (escape output for JSON)
  local escaped_output
  escaped_output=$(printf '%s' "$output" | jq -Rs '.')

  cat > "$cache_file" <<CACHEEOF
{
  "timestamp": ${now},
  "session": ${SESSION_NUM:-0},
  "exit_code": ${exit_code},
  "output": ${escaped_output}
}
CACHEEOF

  return $exit_code
}

# cache_invalidate <key>
# Force-expire a cache entry (useful when you know state changed).
cache_invalidate() {
  local key="$1"
  local cache_file="${HOOK_CACHE_DIR}/${key}.json"
  rm -f "$cache_file" 2>/dev/null
}

# cache_status <key>
# Print cache age and validity. Returns 0 if cache exists, 1 if not.
cache_status() {
  local key="$1"
  local cache_file="${HOOK_CACHE_DIR}/${key}.json"
  if [ ! -f "$cache_file" ]; then
    echo "[cache] No cache for '${key}'"
    return 1
  fi
  local cached_ts
  cached_ts=$(jq -r '.timestamp // 0' "$cache_file" 2>/dev/null)
  local cached_session
  cached_session=$(jq -r '.session // "?"' "$cache_file" 2>/dev/null)
  local now
  now=$(date +%s)
  local age_min=$(( (now - cached_ts) / 60 ))
  echo "[cache] '${key}': ${age_min}m old, from session ${cached_session}"
  return 0
}

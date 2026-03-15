#!/bin/bash
# 35-e-session-prehook_E.sh — Consolidated E-session pre-hook dispatcher
#
# Merges 3 individual E-session pre-hooks into a single dispatcher.
# All 8 checks are independent — only Check 2 (seed) must run first to
# create CONTEXT_FILE, then all others run in parallel.
#
# Performance (wq-837, B#532): Profiling showed the old sequential chain
# (liveness→seed→topics) took 5.9s worst-case because liveness probe can
# take 5s with stale cache. Checks are actually independent — liveness
# updates platform-circuits.json, which no other check reads. Now runs
# seed first (~50ms), then all 7 others in parallel. Target: ≤3s avg.
#
# Replaces:
#   35-engagement-liveness_E.sh (wq-197, R#271, R#275)
#   36-engagement-seed_E.sh     (wq-031, s437)
#   36-topic-clusters_E.sh      (wq-595)
#   37-conversation-balance_E.sh (d041) — merged B#497 (wq-754)
#   38-spending-policy_E.sh      (d059, R#223) — merged B#497 (wq-754)
#
# Check 7: engagement-variety-analyzer.mjs integration (wq-776, B#515)
#
# Created: B#490 (wq-729), expanded B#497 (wq-754)

cd /home/moltbot/moltbook-mcp

STATE_DIR="$HOME/.config/moltbook"
CACHE_FILE="$STATE_DIR/liveness-cache.json"
CACHE_MAX_AGE=7200
INTEL_FILE="$STATE_DIR/engagement-intel.json"
HISTORY_FILE="$STATE_DIR/session-history.txt"
CONTEXT_FILE="$STATE_DIR/e-session-context.md"

###############################################################################
# Check 1: Engagement platform liveness (was 35-engagement-liveness_E.sh)
#   Opens circuits for degraded platforms so platform-picker excludes them
###############################################################################
check_engagement_liveness() {
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
    if [ -f "platform-circuits.json" ]; then
      open_count=$(jq '[to_entries[] | select(.value | type == "object" and .status == "open")] | length' platform-circuits.json 2>/dev/null || echo "?")
      echo "[liveness] Open circuits: $open_count (from cached probe)"
    fi
    echo "[liveness] Done."
    return 0
  fi

  echo "[liveness] Cache stale (${cache_age:-missing}s), probing live..."
  output=$(timeout 3 node engagement-liveness-probe.mjs --session "${SESSION_NUM:-0}" 2>&1)
  exit_code=$?
  echo "$output"

  if [ $exit_code -eq 124 ]; then
    echo "[liveness] WARNING: Probe exceeded 3s hard limit, killed. Using cached circuit state."
  elif [ $exit_code -ne 0 ]; then
    echo "[liveness] WARNING: Probe failed (exit $exit_code), continuing with cached circuit state"
  fi

  echo "[liveness] Done."
}

###############################################################################
# Check 2: Engagement context seed (was 36-engagement-seed_E.sh)
#   Generate E session context from engagement-intel.json + recent E history
#   Extracted to hooks/lib/e-session-seed.mjs (R#323)
###############################################################################
check_engagement_seed() {
  output=$(node hooks/lib/e-session-seed.mjs --output "$CONTEXT_FILE" 2>&1)
  echo "[seed] $output"
}

###############################################################################
# Check 3: Topic clusters (was 36-topic-clusters_E.sh)
#   Populate Chatr thread state and inject topic cluster recommendations
###############################################################################
check_topic_clusters() {
  local ctx_out="${1:-$CONTEXT_FILE}"
  echo "[topic-clusters] Updating Chatr thread state..."
  update_out=$(timeout 5 node chatr-thread-tracker.mjs update --json 2>/dev/null)
  update_exit=$?

  if [ $update_exit -eq 124 ]; then
    echo "[topic-clusters] Thread tracker timed out (5s), using stale state"
  elif [ $update_exit -ne 0 ]; then
    echo "[topic-clusters] Thread tracker failed (exit $update_exit), trying clusters with existing state"
  fi

  clusters_json=$(timeout 4 node chatr-topic-clusters.mjs --json --hours 72 2>/dev/null)
  clusters_exit=$?

  if [ $clusters_exit -ne 0 ] || [ -z "$clusters_json" ]; then
    echo "[topic-clusters] No cluster data available (exit $clusters_exit), skipping"
    return 0
  fi

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
    echo "" >> "$ctx_out"
    echo "$recs" >> "$ctx_out"
    line_count=$(echo "$recs" | wc -l)
    echo "[topic-clusters] Appended $line_count lines (to $(basename "$ctx_out"))"
  else
    echo "[topic-clusters] No recommendations to inject"
  fi
}

###############################################################################
# Check 4: Conversation balance (was 37-conversation-balance_E.sh)
#   Warns if recent sessions show dominance patterns (d041)
###############################################################################
check_conversation_balance() {
  echo "=== Conversation Balance Check (d041) ==="
  output=$(node conversation-balance.mjs 2>&1)
  exit_code=$?
  echo "$output"

  if [ $exit_code -ne 0 ]; then
    echo ""
    echo "ACTION REQUIRED: Recent sessions show conversation imbalance."
    echo "   This session should prioritize:"
    echo "   1. Reading more threads before responding"
    echo "   2. Waiting for responses to previous posts"
    echo "   3. Engaging on platforms where you've posted less"
    echo ""
  fi
}

###############################################################################
# Check 5: Spending policy (was 38-spending-policy_E.sh)
#   Checks monthly budget for crypto-gated platforms (d059, R#223)
###############################################################################
check_spending_policy() {
  POLICY_FILE="$STATE_DIR/spending-policy.json"

  if [ ! -f "$POLICY_FILE" ]; then
    echo "spending-policy: no policy file found, E session spending DISABLED"
    return 0
  fi

  CURRENT_MONTH=$(date +%Y-%m)

  # Extracted to hooks/lib/spending-policy.mjs (R#338)
  POLICY_OUT=$(node hooks/lib/spending-policy.mjs --policy-file "$POLICY_FILE" --current-month "$CURRENT_MONTH")

  IFS='|' read -r MONTH_LIMIT MONTH_SPENT PER_SESSION PER_PLATFORM MIN_ROI WAS_RESET <<< "$POLICY_OUT"

  if [ "$WAS_RESET" = "true" ]; then
    echo "spending-policy: new month, ledger reset"
  fi

  REMAINING=$(echo "$MONTH_LIMIT $MONTH_SPENT" | awk '{printf "%.2f", $1 - $2}')

  if [ "$(echo "$MONTH_SPENT $MONTH_LIMIT" | awk '{print ($1 >= $2) ? "yes" : "no"}')" = "yes" ]; then
    echo "SPENDING_GATE: BLOCKED — monthly limit reached (\$$MONTH_SPENT/\$$MONTH_LIMIT). Skip crypto-gated platforms this session."
  else
    echo "SPENDING_GATE: OPEN — budget \$$REMAINING remaining this month (limit: \$$MONTH_LIMIT)"
    echo "SPENDING_RULES: max \$$PER_SESSION/session, max \$$PER_PLATFORM/platform, ROI >= $MIN_ROI required"
  fi
}

###############################################################################
# Check 6: Credential pre-check for live platforms (wq-792)
#   Uses credential-health-check.mjs for validation (consolidated R#309).
#   Previously contained 50-line inline Node script duplicating the module.
#   Now delegates to the module which also provides JWT expiry detection.
#   Accepts optional $1 as output file for context additions (parallel mode).
###############################################################################
check_credential_status() {
  local ctx_out="${1:-$CONTEXT_FILE}"
  if [ ! -f "account-registry.json" ]; then
    echo "[cred-check] No account-registry.json found, skipping"
    return 0
  fi

  cred_json=$(timeout 5 node credential-health-check.mjs --json 2>&1)
  cred_exit=$?

  if [ $cred_exit -eq 124 ]; then
    echo "[cred-check] Timed out (5s), skipping"
    return 0
  fi

  if [ $cred_exit -ne 0 ] || [ -z "$cred_json" ]; then
    echo "[cred-check] Failed (exit $cred_exit), skipping"
    return 0
  fi

  healthy=$(echo "$cred_json" | jq -r '.healthy // 0')
  total=$(echo "$cred_json" | jq -r '.total // 0')
  unhealthy=$(echo "$cred_json" | jq -r '.unhealthy // 0')

  echo "[cred-check] OK: $healthy/$total live platforms have valid credentials"

  if [ "$unhealthy" -gt 0 ]; then
    {
      echo ""
      echo "## Credential warnings (auto-check)"
      echo "The following live platforms have credential issues. SKIP them when picking engagement targets:"
      echo "$cred_json" | jq -r '.warnings[]? | "- **\(.id)**: \(.status) — \(.details)"'
      echo ""
    } >> "$ctx_out"
    echo "[cred-check] Appended credential warnings to $(basename "$ctx_out")"
  fi
}

###############################################################################
# Check 7: Engagement variety analysis (wq-776)
#   Runs engagement-variety-analyzer.mjs to detect platform concentration
#   drift across recent E sessions. Writes alert to context file if detected.
#   Accepts optional $1 as output file for context additions (parallel mode).
###############################################################################
check_engagement_variety() {
  local ctx_out="${1:-$CONTEXT_FILE}"
  echo "=== Engagement Variety Check ==="
  variety_json=$(timeout 5 node engagement-variety-analyzer.mjs --json --alert-file 2>&1)
  variety_exit=$?

  if [ $variety_exit -eq 124 ]; then
    echo "[variety] Analyzer timed out (5s), skipping"
    return 0
  fi

  if [ -z "$variety_json" ]; then
    echo "[variety] No output from analyzer (exit $variety_exit), skipping"
    return 0
  fi

  # Parse key fields from JSON output
  health_score=$(echo "$variety_json" | jq -r '.health.score // "?"' 2>/dev/null)
  top_platform=$(echo "$variety_json" | jq -r '.concentration.topPlatform // "?"' 2>/dev/null)
  top_pct=$(echo "$variety_json" | jq -r '.concentration.topConcentrationPct // "?"' 2>/dev/null)
  recommendation=$(echo "$variety_json" | jq -r '.health.recommendation // ""' 2>/dev/null)
  alert_level=$(echo "$variety_json" | jq -r '.alert.level // empty' 2>/dev/null)
  alert_msg=$(echo "$variety_json" | jq -r '.alert.message // empty' 2>/dev/null)

  echo "[variety] Health: $health_score | Top: $top_platform ($top_pct%) | $recommendation"

  # If concentration detected, append warning to context output file
  if [ -n "$alert_level" ] && [ "$alert_level" != "null" ]; then
    {
      echo ""
      echo "## Platform concentration alert (auto-detected)"
      echo "**Level: ${alert_level^^}** — $alert_msg"
      echo ""
      echo "$recommendation"
      echo ""
      echo "**Action**: Prioritize under-represented platforms in this session's picker targets."
      echo ""
    } >> "$ctx_out"
    echo "[variety] WARNING: Concentration alert appended to $(basename "$ctx_out")"
  fi
}

###############################################################################
# Check 8: Colony JWT freshness (wq-803)
#   Ensures Colony JWT won't expire mid-session. Extracted to
#   hooks/lib/colony-jwt.mjs (R#348) for testability and modularity.
#   Accepts optional $1 as output file for context additions (parallel mode).
###############################################################################
check_colony_jwt_freshness() {
  local ctx_out="${1:-$CONTEXT_FILE}"

  jwt_json=$(timeout 10 node hooks/lib/colony-jwt.mjs 2>&1)
  jwt_exit=$?

  if [ $jwt_exit -eq 124 ]; then
    echo "[colony-jwt] Timed out (10s), skipping"
    return 0
  fi

  status=$(echo "$jwt_json" | jq -r '.status // "error"' 2>/dev/null)
  action=$(echo "$jwt_json" | jq -r '.action // "none"' 2>/dev/null)
  reason=$(echo "$jwt_json" | jq -r '.reason // ""' 2>/dev/null)
  remaining=$(echo "$jwt_json" | jq -r '.remaining // ""' 2>/dev/null)
  warning=$(echo "$jwt_json" | jq -r '.warning // ""' 2>/dev/null)

  case "$status" in
    skip)
      echo "[colony-jwt] $reason, skipping"
      ;;
    ok)
      if [ "$action" = "refreshed" ]; then
        echo "[colony-jwt] Token refreshed ($reason)"
      elif [ -n "$remaining" ] && [ "$remaining" != "null" ]; then
        echo "[colony-jwt] Token valid (${remaining}s remaining)"
      else
        echo "[colony-jwt] Token OK"
      fi
      ;;
    failed)
      echo "[colony-jwt] Refresh FAILED: $reason"
      if [ -n "$warning" ] && [ "$warning" != "null" ]; then
        {
          echo ""
          echo "## Colony JWT warning (auto-check)"
          echo "**$warning**"
          echo ""
        } >> "$ctx_out"
        echo "[colony-jwt] Warning appended to $(basename "$ctx_out")"
      fi
      ;;
    *)
      echo "[colony-jwt] Unexpected status: $status"
      ;;
  esac
}

###############################################################################
# Run checks: seed first (creates CONTEXT_FILE), then all others in parallel
#
# wq-837 optimization: Profiling showed checks 1-3 were falsely serialized.
# Check 1 (liveness) writes to platform-circuits.json — no other check reads it.
# Check 2 (seed) creates CONTEXT_FILE — must run first so checks 3,6,7,8 can
# append to it. Check 3 (topic clusters) reads Chatr data, not circuits.
# All checks except seed are fully independent.
#
# Execution model:
#   Phase 1: seed (creates CONTEXT_FILE, ~50ms)
#   Phase 2: all other 7 checks in parallel
#     - Checks that append to CONTEXT_FILE use temp files (deterministic merge)
#     - Checks that only print stdout run directly
#   Phase 3: merge temp files into CONTEXT_FILE (deterministic order)
#
# Worst-case wall time: 50ms + max(3s liveness, 5s+4s topics, 5s creds, ...)
#   = ~3.1s (vs 6.2s before). Liveness at 3s timeout is acceptable because
#   circuit state is advisory — platform-picker handles open/half-open circuits
#   gracefully regardless of freshness.
###############################################################################

# Phase 1: Seed creates CONTEXT_FILE (fast, ~50ms)
check_engagement_seed

# Phase 2: Temp files for checks that append to CONTEXT_FILE
TOPICS_TMP=$(mktemp "${TMPDIR:-/tmp}/e-prehook-topics.XXXXXX")
CRED_TMP=$(mktemp "${TMPDIR:-/tmp}/e-prehook-cred.XXXXXX")
VARIETY_TMP=$(mktemp "${TMPDIR:-/tmp}/e-prehook-variety.XXXXXX")
COLONY_TMP=$(mktemp "${TMPDIR:-/tmp}/e-prehook-colony.XXXXXX")

# Run all 7 independent checks in parallel
check_engagement_liveness &
pid_liveness=$!
check_topic_clusters "$TOPICS_TMP" &
pid_topics=$!
check_conversation_balance &
pid_balance=$!
check_spending_policy &
pid_spending=$!
check_credential_status "$CRED_TMP" &
pid_cred=$!
check_engagement_variety "$VARIETY_TMP" &
pid_variety=$!
check_colony_jwt_freshness "$COLONY_TMP" &
pid_colony=$!

# Wait for all parallel checks
wait $pid_liveness $pid_topics $pid_balance $pid_spending $pid_cred $pid_variety $pid_colony

# Phase 3: Merge context additions from parallel checks (deterministic order)
for tmp in "$TOPICS_TMP" "$CRED_TMP" "$VARIETY_TMP" "$COLONY_TMP"; do
  if [ -s "$tmp" ]; then
    cat "$tmp" >> "$CONTEXT_FILE"
  fi
  rm -f "$tmp"
done

###############################################################################
# Phase 4: Generate picker mandate + revalidate (wq-956, wq-962)
#   Root cause of picker compliance ~33%: prehook revalidated old mandate,
#   then E session re-ran picker (overwriting revalidated version). Fix:
#   generate fresh mandate HERE in the prehook, then revalidate against
#   fresh circuit data. E session reads the final mandate without re-picking.
###############################################################################
echo "[picker] Generating fresh mandate via platform-picker..."
picker_out=$(timeout 5 node platform-picker.mjs --count 3 --update --backups 2 2>&1)
picker_exit=$?

if [ $picker_exit -eq 124 ]; then
  echo "[picker] WARNING: Picker timed out (5s)"
elif [ $picker_exit -ne 0 ]; then
  echo "[picker] WARNING: Picker failed (exit $picker_exit): $picker_out"
else
  echo "[picker] $picker_out"
fi

if [ -f "$STATE_DIR/picker-mandate.json" ]; then
  echo "[picker-revalidate] Revalidating mandate against fresh circuit data..."
  revalidate_out=$(timeout 3 node hooks/lib/picker-revalidate.mjs 2>&1)
  revalidate_exit=$?

  if [ $revalidate_exit -eq 124 ]; then
    echo "[picker-revalidate] Timed out (3s), using original mandate"
  elif [ $revalidate_exit -ne 0 ]; then
    echo "[picker-revalidate] Failed (exit $revalidate_exit): $revalidate_out"
  else
    echo "$revalidate_out"
  fi
  # Log final mandate state for audit traceability
  mandate_selected=$(jq -r '.selected | join(", ")' "$STATE_DIR/picker-mandate.json" 2>/dev/null)
  mandate_revalidated=$(jq -r '.revalidated_at // "not revalidated"' "$STATE_DIR/picker-mandate.json" 2>/dev/null)
  echo "[picker-revalidate] Final mandate: [$mandate_selected] (revalidated: $mandate_revalidated)"
else
  echo "[picker-revalidate] No picker mandate after picker run — unexpected"
fi

exit 0

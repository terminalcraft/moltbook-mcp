#!/bin/bash
# 35-e-session-prehook_E.sh — Consolidated E-session pre-hook dispatcher
#
# Merges 3 individual E-session pre-hooks into a single dispatcher.
# Runs liveness probe first (circuit state), then seeds context, then appends
# topic clusters — preserving the dependency order.
#
# Replaces:
#   35-engagement-liveness_E.sh (wq-197, R#271, R#275)
#   36-engagement-seed_E.sh     (wq-031, s437)
#   36-topic-clusters_E.sh      (wq-595)
#   37-conversation-balance_E.sh (d041) — merged B#497 (wq-754)
#   38-spending-policy_E.sh      (d059, R#223) — merged B#497 (wq-754)
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
  output=$(timeout 5 node engagement-liveness-probe.mjs --session "${SESSION_NUM:-0}" 2>&1)
  exit_code=$?
  echo "$output"

  if [ $exit_code -eq 124 ]; then
    echo "[liveness] WARNING: Probe exceeded 5s hard limit, killed. Using cached circuit state."
  elif [ $exit_code -ne 0 ]; then
    echo "[liveness] WARNING: Probe failed (exit $exit_code), continuing with cached circuit state"
  fi

  echo "[liveness] Done."
}

###############################################################################
# Check 2: Engagement context seed (was 36-engagement-seed_E.sh)
#   Generate E session context from engagement-intel.json + recent E history
###############################################################################
check_engagement_seed() {
  {
    # 1. Recent E session summaries
    if [ -f "$HISTORY_FILE" ]; then
      E_SESSIONS=$(grep 'mode=E' "$HISTORY_FILE" | tail -3)
      if [ -n "$E_SESSIONS" ]; then
        echo "## Last E sessions"
        echo "$E_SESSIONS" | while IFS= read -r line; do echo "- $line"; done
        echo ""
      fi
    fi

    # 2. Engagement intel entries
    if [ -f "$INTEL_FILE" ]; then
      INTEL_OUT=$(jq -r '
        if length > 0 then
          "## Engagement intel (from recent sessions)\n" +
          ([.[-8:][] |
            "- **[\(.type // "?")]** (s\(.session // "?")) \(.summary // "")" +
            (if .actionable then "\n  - Action: \(.actionable)" else "" end)
          ] | join("\n")) + "\n"
        else empty end
      ' "$INTEL_FILE" 2>/dev/null)
      if [ -n "$INTEL_OUT" ]; then
        echo -e "$INTEL_OUT"
      fi
    fi

    # 3. Platform rotation hint
    if [ -f "$HISTORY_FILE" ]; then
      LAST_E=$(grep 'mode=E' "$HISTORY_FILE" | tail -1)
      if [ -n "$LAST_E" ]; then
        NOTE=$(echo "$LAST_E" | sed -n 's/.*note: //p')
        if [ -n "$NOTE" ]; then
          echo "## Platform rotation hint"
          echo "Last E session covered: $NOTE"
          echo "Prioritize platforms NOT mentioned above."
          echo ""
        fi
      fi
    fi

    # 4. Budget utilization warning
    if [ -f "$HISTORY_FILE" ]; then
      COSTS=$(grep 'mode=E' "$HISTORY_FILE" | tail -5 | grep -oP 'cost=\$\K[\d.]+')
      if [ -n "$COSTS" ]; then
        COUNT=$(echo "$COSTS" | wc -l)
        SUM=$(echo "$COSTS" | awk '{s+=$1} END {printf "%.2f", s}')
        AVG=$(echo "$SUM $COUNT" | awk '{printf "%.2f", $1/$2}')
        echo "## Budget utilization alert"
        if [ "$(echo "$AVG" | awk '{print ($1 < 1.50)}')" = "1" ]; then
          echo "WARNING: Last $COUNT E sessions averaged \$$AVG (target: \$1.50+)."
          echo "You MUST use the Phase 4 budget gate. Do NOT end the session until you have spent at least \$1.50."
          echo "After each platform engagement, check your budget spent from the system-reminder line."
          echo "If under \$1.50, loop back to Phase 2 with another platform."
        else
          echo "Recent E sessions averaging \$$AVG — on target."
        fi
        echo ""
      fi
    fi

    # 5. d049 violation nudge
    NUDGE_FILE="$STATE_DIR/d049-nudge.txt"
    if [ -f "$NUDGE_FILE" ]; then
      NUDGE=$(cat "$NUDGE_FILE")
      if [ -n "$NUDGE" ]; then
        echo "$NUDGE"
        echo ""
      fi
    fi
  } > "$CONTEXT_FILE"

  LINE_COUNT=$(wc -l < "$CONTEXT_FILE")
  if [ "$LINE_COUNT" -gt 0 ]; then
    echo "wrote $LINE_COUNT lines to e-session-context.md"
  else
    rm -f "$CONTEXT_FILE"
    echo "no engagement context to seed"
  fi
}

###############################################################################
# Check 3: Topic clusters (was 36-topic-clusters_E.sh)
#   Populate Chatr thread state and inject topic cluster recommendations
###############################################################################
check_topic_clusters() {
  echo "[topic-clusters] Updating Chatr thread state..."
  update_out=$(timeout 10 node chatr-thread-tracker.mjs update --json 2>/dev/null)
  update_exit=$?

  if [ $update_exit -eq 124 ]; then
    echo "[topic-clusters] Thread tracker timed out (10s), using stale state"
  elif [ $update_exit -ne 0 ]; then
    echo "[topic-clusters] Thread tracker failed (exit $update_exit), trying clusters with existing state"
  fi

  clusters_json=$(timeout 8 node chatr-topic-clusters.mjs --json --hours 72 2>/dev/null)
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
    echo "" >> "$CONTEXT_FILE"
    echo "$recs" >> "$CONTEXT_FILE"
    line_count=$(echo "$recs" | wc -l)
    echo "[topic-clusters] Appended $line_count lines to e-session-context.md"
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

  # Single node invocation reads all values and handles month reset (was 7 separate calls)
  POLICY_OUT=$(node -e "
    const fs=require('fs');
    const p=JSON.parse(fs.readFileSync('$POLICY_FILE','utf8'));
    let reset=false;
    if (p.ledger.current_month !== '$CURRENT_MONTH') {
      p.ledger.current_month='$CURRENT_MONTH';
      p.ledger.month_spent_usd=0;
      p.ledger.transactions=[];
      fs.writeFileSync('$POLICY_FILE', JSON.stringify(p,null,2));
      reset=true;
    }
    const ml=p.policy.monthly_limit_usd;
    const ms=p.ledger.month_spent_usd;
    console.log([ml,ms,p.policy.per_session_limit_usd,p.policy.per_platform_limit_usd,p.policy.min_roi_score_for_spend,reset].join('|'));
  ")

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
# Run all checks sequentially (order matters — liveness before seed, seed before clusters)
###############################################################################

check_engagement_liveness
check_engagement_seed
check_topic_clusters
check_conversation_balance
check_spending_policy

exit 0

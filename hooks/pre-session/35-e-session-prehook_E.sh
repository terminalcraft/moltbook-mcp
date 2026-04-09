#!/bin/bash
# 35-e-session-prehook_E.sh — Consolidated E-session pre-hook dispatcher
#
# Runs all E session pre-checks: liveness probe (separate process) +
# consolidated runner (single node process for 10 checks).
#
# Performance: The runner eliminates ~10 Node subprocess startups (~1-2s saved).
# Liveness probe stays separate due to its process.exit() hard timeout pattern.
#
# Replaces:
#   35-engagement-liveness_E.sh (wq-197, R#271, R#275)
#   36-engagement-seed_E.sh     (wq-031, s437)
#   36-topic-clusters_E.sh      (wq-595)
#   37-conversation-balance_E.sh (d041) — merged B#497 (wq-754)
#   38-spending-policy_E.sh      (d059, R#223) — merged B#497 (wq-754)
#
# Created: B#490 (wq-729), expanded B#497 (wq-754)
# Optimized: B#631 (wq-983) — single node runner replaces 10 subprocesses

cd /home/moltbot/moltbook-mcp

STATE_DIR="$HOME/.config/moltbook"
CACHE_FILE="$STATE_DIR/liveness-cache.json"
CACHE_MAX_AGE=7200
CONTEXT_FILE="$STATE_DIR/e-session-context.md"

###############################################################################
# Check 1: Engagement platform liveness (separate process — uses process.exit)
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
# Run: liveness in background, then consolidated runner for everything else
###############################################################################

# Phase 1: Liveness probe (separate process, background)
check_engagement_liveness &
pid_liveness=$!

# Phase 2: Consolidated runner (single node process for checks 2-8 + picker)
POLICY_FILE="$STATE_DIR/spending-policy.json"
RUNNER_JSON=""
runner_output=$(timeout 12 node e-prehook-runner.mjs \
  --context-file "$CONTEXT_FILE" \
  --policy-file "$POLICY_FILE" \
  --session "${SESSION_NUM:-0}" 2>&1)
runner_exit=$?

if [ $runner_exit -eq 124 ]; then
  echo "[e-runner] WARNING: Runner timed out (12s)"
elif [ $runner_exit -ne 0 ]; then
  echo "[e-runner] WARNING: Runner failed (exit $runner_exit)"
else
  RUNNER_JSON="$runner_output"
fi

# Wait for liveness probe
wait $pid_liveness

# Phase 3: Parse runner output and log results
if [ -z "$RUNNER_JSON" ]; then
  echo "[e-runner] No runner output — checks skipped"
  exit 0
fi

# Check 2: Seed
seed_error=$(echo "$RUNNER_JSON" | jq -r '.seed.error // empty')
if [ -n "$seed_error" ]; then
  echo "[seed] ERROR: $seed_error"
else
  seed_lines=$(echo "$RUNNER_JSON" | jq -r '.seed.lines // 0')
  echo "[seed] Generated context ($seed_lines lines)"
fi

# Check 3: Thread tracker + topic clusters
tt_error=$(echo "$RUNNER_JSON" | jq -r '.thread_tracker.error // empty')
if [ -n "$tt_error" ] && [ "$tt_error" != "null" ]; then
  echo "[topic-clusters] Thread tracker: $tt_error"
else
  tt_msgs=$(echo "$RUNNER_JSON" | jq -r '.thread_tracker.messagesProcessed // 0')
  echo "[topic-clusters] Thread tracker updated ($tt_msgs messages)"
fi

tc_error=$(echo "$RUNNER_JSON" | jq -r '.topic_clusters.error // empty')
if [ -n "$tc_error" ] && [ "$tc_error" != "null" ]; then
  echo "[topic-clusters] $tc_error"
else
  tc_count=$(echo "$RUNNER_JSON" | jq -r '.topic_clusters.clusterCount // 0')
  tc_threads=$(echo "$RUNNER_JSON" | jq -r '.topic_clusters.threadCount // 0')
  tc_recs=$(echo "$RUNNER_JSON" | jq -r '.topic_clusters.recommendations | length')

  # Append topic cluster data to context file if recommendations exist
  if [ "$tc_recs" -gt 0 ]; then
    {
      echo ""
      echo "## Chatr topic clusters (auto-generated)"
      echo "$tc_threads threads in $tc_count clusters (last 72h)"
      echo ""
      echo "**Recommended engagement targets:**"
      echo "$RUNNER_JSON" | jq -r '.topic_clusters.recommendations[] |
        "- **\(.topic)**: \(.reason)"'
      echo ""
    } >> "$CONTEXT_FILE"
    echo "[topic-clusters] $tc_count clusters, $tc_recs recommendations (appended to context)"
  else
    echo "[topic-clusters] $tc_count clusters, no recommendations"
  fi
fi

# Check 4: Conversation balance
cb_error=$(echo "$RUNNER_JSON" | jq -r '.conversation_balance.error // empty')
if [ -n "$cb_error" ]; then
  echo "[conversation-balance] ERROR: $cb_error"
else
  cb_trend=$(echo "$RUNNER_JSON" | jq -r '.conversation_balance.trend // "?"')
  cb_ratio=$(echo "$RUNNER_JSON" | jq -r '.conversation_balance.avgRatio // "?"')
  echo "=== Conversation Balance Check (d041) ==="
  echo "[conversation-balance] Trend: $cb_trend, avg ratio: $cb_ratio"
  cb_warning=$(echo "$RUNNER_JSON" | jq -r '.conversation_balance.warning')
  if [ "$cb_warning" = "true" ]; then
    echo ""
    echo "ACTION REQUIRED: Recent sessions show conversation imbalance."
    echo "   This session should prioritize:"
    echo "   1. Reading more threads before responding"
    echo "   2. Waiting for responses to previous posts"
    echo "   3. Engaging on platforms where you've posted less"
    echo ""
  fi
fi

# Check 5: Spending policy
sp_error=$(echo "$RUNNER_JSON" | jq -r '.spending_policy.error // empty')
if [ -n "$sp_error" ]; then
  echo "[spending-policy] ERROR: $sp_error"
else
  sp_status=$(echo "$RUNNER_JSON" | jq -r '.spending_policy.status // empty')
  if [ "$sp_status" = "disabled" ]; then
    echo "spending-policy: no policy file found, E session spending DISABLED"
  else
    sp_reset=$(echo "$RUNNER_JSON" | jq -r '.spending_policy.wasReset')
    [ "$sp_reset" = "true" ] && echo "spending-policy: new month, ledger reset"

    sp_limit=$(echo "$RUNNER_JSON" | jq -r '.spending_policy.monthlyLimit')
    sp_spent=$(echo "$RUNNER_JSON" | jq -r '.spending_policy.monthSpent')
    sp_remaining=$(echo "$sp_limit $sp_spent" | awk '{printf "%.2f", $1 - $2}')

    if [ "$(echo "$sp_spent $sp_limit" | awk '{print ($1 >= $2) ? "yes" : "no"}')" = "yes" ]; then
      echo "SPENDING_GATE: BLOCKED — monthly limit reached (\$$sp_spent/\$$sp_limit). Skip crypto-gated platforms this session."
    else
      sp_per_session=$(echo "$RUNNER_JSON" | jq -r '.spending_policy.perSession')
      sp_per_platform=$(echo "$RUNNER_JSON" | jq -r '.spending_policy.perPlatform')
      sp_min_roi=$(echo "$RUNNER_JSON" | jq -r '.spending_policy.minRoi')
      echo "SPENDING_GATE: OPEN — budget \$$sp_remaining remaining this month (limit: \$$sp_limit)"
      echo "SPENDING_RULES: max \$$sp_per_session/session, max \$$sp_per_platform/platform, ROI >= $sp_min_roi required"
    fi
  fi
fi

# Check 6: Credential health
ch_error=$(echo "$RUNNER_JSON" | jq -r '.credential_health.error // empty')
if [ -n "$ch_error" ]; then
  echo "[cred-check] ERROR: $ch_error"
else
  ch_healthy=$(echo "$RUNNER_JSON" | jq -r '.credential_health.healthy // 0')
  ch_total=$(echo "$RUNNER_JSON" | jq -r '.credential_health.total // 0')
  ch_unhealthy=$(echo "$RUNNER_JSON" | jq -r '.credential_health.unhealthy // 0')
  echo "[cred-check] OK: $ch_healthy/$ch_total live platforms have valid credentials"

  if [ "$ch_unhealthy" -gt 0 ]; then
    {
      echo ""
      echo "## Credential warnings (auto-check)"
      echo "The following live platforms have credential issues. SKIP them when picking engagement targets:"
      echo "$RUNNER_JSON" | jq -r '.credential_health.warnings[]? | "- **\(.id)**: \(.status) — \(.details)"'
      echo ""
    } >> "$CONTEXT_FILE"
    echo "[cred-check] Appended credential warnings to $(basename "$CONTEXT_FILE")"
  fi
fi

# Check 7: Engagement variety
ev_error=$(echo "$RUNNER_JSON" | jq -r '.engagement_variety.error // empty')
if [ -n "$ev_error" ]; then
  echo "[variety] $ev_error"
else
  ev_health=$(echo "$RUNNER_JSON" | jq -r '.engagement_variety.healthScore // "?"')
  ev_top=$(echo "$RUNNER_JSON" | jq -r '.engagement_variety.topPlatform // "?"')
  ev_pct=$(echo "$RUNNER_JSON" | jq -r '.engagement_variety.topConcentrationPct // "?"')
  ev_rec=$(echo "$RUNNER_JSON" | jq -r '.engagement_variety.recommendation // ""')
  echo "=== Engagement Variety Check ==="
  echo "[variety] Health: $ev_health | Top: $ev_top ($ev_pct%) | $ev_rec"

  ev_alert_level=$(echo "$RUNNER_JSON" | jq -r '.engagement_variety.alert.level // empty')
  if [ -n "$ev_alert_level" ]; then
    ev_alert_msg=$(echo "$RUNNER_JSON" | jq -r '.engagement_variety.alert.message // ""')
    {
      echo ""
      echo "## Platform concentration alert (auto-detected)"
      echo "**Level: ${ev_alert_level^^}** — $ev_alert_msg"
      echo ""
      echo "$ev_rec"
      echo ""
      echo "**Action**: Prioritize under-represented platforms in this session's picker targets."
      echo ""
    } >> "$CONTEXT_FILE"
    echo "[variety] WARNING: Concentration alert appended to $(basename "$CONTEXT_FILE")"
  fi
fi

# Check 8: Colony JWT
cj_error=$(echo "$RUNNER_JSON" | jq -r '.colony_jwt.error // empty')
if [ -n "$cj_error" ]; then
  echo "[colony-jwt] ERROR: $cj_error"
else
  cj_status=$(echo "$RUNNER_JSON" | jq -r '.colony_jwt.status // "error"')
  cj_action=$(echo "$RUNNER_JSON" | jq -r '.colony_jwt.action // "none"')
  cj_reason=$(echo "$RUNNER_JSON" | jq -r '.colony_jwt.reason // ""')
  cj_remaining=$(echo "$RUNNER_JSON" | jq -r '.colony_jwt.remaining // ""')
  cj_warning=$(echo "$RUNNER_JSON" | jq -r '.colony_jwt.warning // ""')

  case "$cj_status" in
    skip)
      echo "[colony-jwt] $cj_reason, skipping"
      ;;
    ok)
      if [ "$cj_action" = "refreshed" ]; then
        echo "[colony-jwt] Token refreshed ($cj_reason)"
      elif [ -n "$cj_remaining" ] && [ "$cj_remaining" != "null" ]; then
        echo "[colony-jwt] Token valid (${cj_remaining}s remaining)"
      else
        echo "[colony-jwt] Token OK"
      fi
      ;;
    failed)
      echo "[colony-jwt] Refresh FAILED: $cj_reason"
      if [ -n "$cj_warning" ] && [ "$cj_warning" != "null" ]; then
        {
          echo ""
          echo "## Colony JWT warning (auto-check)"
          echo "**$cj_warning**"
          echo ""
        } >> "$CONTEXT_FILE"
        echo "[colony-jwt] Warning appended to $(basename "$CONTEXT_FILE")"
      fi
      ;;
    *)
      echo "[colony-jwt] Unexpected status: $cj_status"
      ;;
  esac
fi

# Phase 4: Picker + revalidate (already run by runner)
pk_error=$(echo "$RUNNER_JSON" | jq -r '.picker.error // empty')
if [ -n "$pk_error" ]; then
  echo "[picker] ERROR: $pk_error"
else
  echo "[picker] $(echo "$RUNNER_JSON" | jq -r '.picker.output' | head -1)"
fi

pr_error=$(echo "$RUNNER_JSON" | jq -r '.picker_revalidate.error // empty')
if [ -n "$pr_error" ] && [ "$pr_error" != "null" ]; then
  echo "[picker-revalidate] $pr_error"
else
  pr_revalidated=$(echo "$RUNNER_JSON" | jq -r '.picker_revalidate.revalidated')
  if [ "$pr_revalidated" = "true" ]; then
    pr_subs=$(echo "$RUNNER_JSON" | jq -r '.picker_revalidate.substitutions | length')
    if [ "$pr_subs" -gt 0 ]; then
      echo "[picker-revalidate] Revalidated with $pr_subs substitution(s)"
      echo "$RUNNER_JSON" | jq -r '.picker_revalidate.substitutions[] | select(.replacement != null) |
        "[picker-revalidate] \(.original) → \(.replacement) (\(.reason))"'
    else
      echo "[picker-revalidate] Revalidated, no substitutions needed"
    fi
  fi

  # Log final mandate state for audit traceability
  if [ -f "$STATE_DIR/picker-mandate.json" ]; then
    mandate_selected=$(jq -r '.selected | join(", ")' "$STATE_DIR/picker-mandate.json" 2>/dev/null)
    mandate_revalidated=$(jq -r '.revalidated_at // "not revalidated"' "$STATE_DIR/picker-mandate.json" 2>/dev/null)
    echo "[picker-revalidate] Final mandate: [$mandate_selected] (revalidated: $mandate_revalidated)"
  fi
fi

echo "[e-prehook] All checks complete (1 subprocess + 1 consolidated runner)"
exit 0

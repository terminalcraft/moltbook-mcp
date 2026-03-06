#!/bin/bash
# 35-a-session-prehook_A.sh — Consolidated A-session pre-hook dispatcher
#
# Merges 7 individual A-session pre-hooks into a single dispatcher.
# All checks are independent, non-blocking, and run sequentially.
#
# Replaces:
#   28-cost-trend-monitor_A.sh  (B#483, wq-727)
#   29-stale-ref-check_A.sh     (B#390, wq-508)
#   32-hook-timing-check_A.sh   (B#528, wq-827)
#   33-stale-tag-check_A.sh     (B#529, wq-828)
#   34-cred-health-cleanup_A.sh (B#543, wq-850)
#   35-briefing-directive-check_A.sh (B#547, wq-863)
#   37-cost-escalation_A.sh     (B#565, wq-888)
#
# Created: R#329 (d074 Group 1)

set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$HOME/.config/moltbook"
SESSION="${SESSION_NUM:-0}"

###############################################################################
# Check 1: Cost trend monitor (was 28-cost-trend-monitor_A.sh)
#   B/R session cost trend analysis via external .mjs modules
###############################################################################
check_cost_trends() {
  # B session cost trend
  b_result=$(node "$DIR/b-cost-trend.mjs" --json 2>/dev/null) || b_result=""
  if [ -n "$b_result" ]; then
    b_status=$(echo "$b_result" | jq -r '.status')
    b_avg=$(echo "$b_result" | jq -r '.recentAvg')
    b_trend=$(echo "$b_result" | jq -r '.trendPct')
    b_high=$(echo "$b_result" | jq -r '.highCount')

    case "$b_status" in
      critical)
        echo "[cost-trend] CRITICAL: B session avg \$$b_avg exceeds \$3.00. Trend: ${b_trend}%. High-cost: ${b_high}/10."
        ;;
      warn)
        echo "[cost-trend] WARN: B session avg \$$b_avg exceeds \$2.50 or ${b_high}+ sessions >$3. Trend: ${b_trend}%."
        ;;
      watch)
        echo "[cost-trend] WATCH: B session cost trend +${b_trend}% (avg \$$b_avg). ${b_high} high-cost sessions."
        ;;
      *)
        echo "[cost-trend] OK: B session avg \$$b_avg, trend ${b_trend}%."
        ;;
    esac
  fi

  # R session cost trend
  r_result=$(node "$DIR/r-cost-monitor.mjs" --json 2>/dev/null) || r_result=""
  if [ -n "$r_result" ]; then
    r_status=$(echo "$r_result" | jq -r '.status')
    r_avg=$(echo "$r_result" | jq -r '.postR252Avg')
    r_monitored=$(echo "$r_result" | jq -r '.monitored')
    r_remaining=$(echo "$r_result" | jq -r '.remaining')

    case "$r_status" in
      ALERT)
        echo "[r-cost-trend] ALERT: R sessions avg \$$r_avg — 3+ consecutive above \$2.50. Investigate R#252 scope creep."
        ;;
      MONITORING)
        echo "[r-cost-trend] MONITORING: R sessions avg \$$r_avg ($r_monitored sampled, $r_remaining remaining). wq-601 active."
        ;;
      RESOLVED)
        echo "[r-cost-trend] RESOLVED: R session cost trend acceptable (avg \$$r_avg). wq-601 can be closed."
        ;;
    esac
  fi
}

###############################################################################
# Check 2: Stale reference detection (was 29-stale-ref-check_A.sh)
#   Runs stale-ref-check.sh, writes structured results for audit consumption
###############################################################################
check_stale_refs() {
  local OUTPUT_FILE="$STATE_DIR/stale-refs.json"

  RAW_OUTPUT=$("$DIR/stale-ref-check.sh" 2>/dev/null) || {
    echo '{"checked":"'"$(date -Iseconds)"'","session":'"$SESSION"',"stale_count":0,"stale_refs":[],"error":"stale-ref-check.sh failed"}' > "$OUTPUT_FILE"
    echo "[stale-refs] WARN: stale-ref-check.sh failed"
    return 0
  }

  local TMP_REFS
  TMP_REFS=$(mktemp)
  echo "[]" > "$TMP_REFS"
  local CURRENT_FILE=""

  while IFS= read -r line; do
    line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$line" ] && continue

    if echo "$line" | grep -q '^STALE:'; then
      CURRENT_FILE=$(echo "$line" | grep -oP 'STALE:\s+\K\S+')
    elif [ -n "$CURRENT_FILE" ] && ! echo "$line" | grep -qE '^(===|No |All )'; then
      jq --arg df "$CURRENT_FILE" --arg ri "$line" '. += [{"deleted_file": $df, "referenced_in": $ri}]' "$TMP_REFS" > "${TMP_REFS}.tmp" && mv "${TMP_REFS}.tmp" "$TMP_REFS"
    fi
  done <<< "$RAW_OUTPUT"

  local STALE_COUNT
  STALE_COUNT=$(jq 'length' "$TMP_REFS")

  jq -n --arg checked "$(date -Iseconds)" --argjson session "$SESSION" --argjson count "$STALE_COUNT" \
    --slurpfile refs "$TMP_REFS" --argjson has_stale "$([ "$STALE_COUNT" -gt 0 ] && echo true || echo false)" \
    '{checked: $checked, session: $session, stale_count: $count, stale_refs: $refs[0], has_stale: $has_stale}' > "$OUTPUT_FILE"

  rm -f "$TMP_REFS"

  if [ "$STALE_COUNT" -gt 0 ]; then
    local FILE_COUNT
    FILE_COUNT=$(jq '[.[].deleted_file] | unique | length' <<< "$(jq '.stale_refs' "$OUTPUT_FILE")")
    echo "[stale-refs] $STALE_COUNT stale reference(s) in $FILE_COUNT deleted file(s)"
  else
    echo "[stale-refs] OK: clean (0 stale references)"
  fi
}

###############################################################################
# Check 3: Hook timing report (was 32-hook-timing-check_A.sh)
#   Reports slow hooks and regressions for audit consumption
###############################################################################
check_hook_timing() {
  local OUTPUT_FILE="$STATE_DIR/hook-timing-audit.json"

  RAW=$(node "$DIR/hook-timing-report.mjs" --json --last 10 2>/dev/null) || {
    echo '{"checked":"'"$(date -Iseconds)"'","session":'"$SESSION"',"error":"hook-timing-report.mjs failed","slow_count":0,"worst_offender":null}' > "$OUTPUT_FILE"
    echo "[hook-timing] ERROR: hook-timing-report.mjs failed"
    return 0
  }

  local SLOW_COUNT TOTAL DEGRADING_COUNT
  SLOW_COUNT=$(echo "$RAW" | jq '.regressions')
  TOTAL=$(echo "$RAW" | jq '.total_hooks')
  DEGRADING_COUNT=$(echo "$RAW" | jq '[.hooks[] | select(.trend == "degrading" and .p95 > 1000)] | length')

  echo "$RAW" | jq --argjson session "$SESSION" --arg checked "$(date -Iseconds)" \
    --argjson degrading_count "$DEGRADING_COUNT" '{
      checked: $checked,
      session: $session,
      threshold_ms: .threshold_ms,
      sessions_analyzed: .sessions_analyzed,
      total_hooks: .total_hooks,
      slow_count: .regressions,
      worst_offender: (if (.hooks | length) > 0 then {
        hook: .hooks[0].hook,
        phase: .hooks[0].phase,
        p95: .hooks[0].p95,
        avg: .hooks[0].avg,
        trend: .hooks[0].trend
      } else null end),
      degrading_count: $degrading_count,
      regressions: [.hooks[] | select(.regression) | {hook, phase, p95, avg, trend}]
    }' > "$OUTPUT_FILE"

  local WORST
  WORST=$(echo "$RAW" | jq -r '
    if (.hooks | length) > 0 then
      .hooks[0] | "\(.hook) (\(.phase)) p95=\(.p95)ms avg=\(.avg)ms"
    else "none" end
  ')

  if [ "$SLOW_COUNT" -gt 0 ]; then
    echo "[hook-timing] $SLOW_COUNT/$TOTAL hooks exceed threshold. Worst: $WORST"
    if [ "$DEGRADING_COUNT" -gt 0 ]; then
      echo "[hook-timing] $DEGRADING_COUNT hook(s) degrading with P95 >1000ms"
    fi
  else
    echo "[hook-timing] OK: 0/$TOTAL hooks exceed threshold"
  fi
}

###############################################################################
# Check 4: Stale tag detection (was 33-stale-tag-check_A.sh)
#   Detects queue items tagged with completed directives
###############################################################################
check_stale_tags() {
  local OUTPUT_FILE="$STATE_DIR/stale-tags-audit.json"
  local DIRECTIVES_FILE="$DIR/directives.json"
  local QUEUE_FILE="$DIR/work-queue.json"

  if [ ! -f "$DIRECTIVES_FILE" ] || [ ! -f "$QUEUE_FILE" ]; then
    echo '{"checked":"'"$(date -Iseconds)"'","session":'"$SESSION"',"stale_count":0,"stale_items":[],"error":"missing directives.json or work-queue.json"}' > "$OUTPUT_FILE"
    echo "[stale-tags] ERROR: missing input files"
    return 0
  fi

  local RESULT
  RESULT=$(jq -n \
    --slurpfile directives "$DIRECTIVES_FILE" \
    --slurpfile queue "$QUEUE_FILE" \
    --arg checked "$(date -Iseconds)" \
    --argjson session "$SESSION" \
    '
    ($directives[0].directives | map(select(.status == "completed")) | map(.id)) as $completed_ids |
    [
      $queue[0].queue[] |
      select(.status != "done" and .status != "retired") |
      select((.tags // []) | length > 0) |
      . as $item |
      [.tags[] | select(test("^d[0-9]+$")) | select(. as $tag | $completed_ids | index($tag))] |
      select(length > 0) |
      {
        id: $item.id,
        title: $item.title,
        status: $item.status,
        stale_tags: .,
        all_tags: ($item.tags // [])
      }
    ] as $stale_items |
    {
      checked: $checked,
      session: $session,
      completed_directives_count: ($completed_ids | length),
      stale_count: ($stale_items | length),
      stale_items: $stale_items
    }
  ') || {
    echo '{"checked":"'"$(date -Iseconds)"'","session":'"$SESSION"',"stale_count":0,"stale_items":[],"error":"jq processing failed"}' > "$OUTPUT_FILE"
    echo "[stale-tags] ERROR: jq processing failed"
    return 0
  }

  echo "$RESULT" > "$OUTPUT_FILE"
  local STALE_COUNT
  STALE_COUNT=$(echo "$RESULT" | jq '.stale_count')

  if [ "$STALE_COUNT" -gt 0 ]; then
    local ITEMS
    ITEMS=$(echo "$RESULT" | jq -r '[.stale_items[] | "\(.id)(\(.stale_tags | join(",")))"] | join(", ")')
    echo "[stale-tags] $STALE_COUNT item(s) tagged with completed directives: $ITEMS"
    node "$DIR/stale-tag-remediate.mjs" --apply 2>/dev/null && echo "[stale-tags] Auto-remediated stale tags" || echo "[stale-tags] WARN: auto-remediation failed"
  else
    echo "[stale-tags] OK: no stale directive tags found"
  fi
}

###############################################################################
# Check 5: Credential health cleanup (was 34-cred-health-cleanup_A.sh)
#   Prunes recovered entries from credential-health-state.json
###############################################################################
check_cred_health() {
  local STATE_FILE="$HOME/.config/moltbook/credential-health-state.json"

  if [ ! -f "$STATE_FILE" ]; then
    echo "[cred-health] OK: no state file to clean"
    return 0
  fi

  if ! jq empty "$STATE_FILE" 2>/dev/null; then
    echo "[cred-health] WARN: invalid JSON in credential-health-state.json"
    return 0
  fi

  local BEFORE RESULT AFTER STALE PRUNED
  BEFORE=$(jq 'length' "$STATE_FILE")

  RESULT=$(jq --argjson session "$SESSION" '
    to_entries |
    map(select(.value.consecutive_failures > 0)) |
    map(
      if ($session - (.value.last_session // 0)) > 50
      then .value.stale = true
      else .
      end
    ) |
    from_entries
  ' "$STATE_FILE") || {
    echo "[cred-health] WARN: jq processing failed"
    return 0
  }

  echo "$RESULT" > "$STATE_FILE"
  AFTER=$(echo "$RESULT" | jq 'length')
  STALE=$(echo "$RESULT" | jq '[to_entries[] | select(.value.stale)] | length')
  PRUNED=$((BEFORE - AFTER))

  if [ "$PRUNED" -gt 0 ] || [ "$STALE" -gt 0 ]; then
    echo "[cred-health] Pruned $PRUNED recovered, $STALE stale of $BEFORE entries"
  else
    echo "[cred-health] OK: $AFTER entries, 0 recovered, 0 stale"
  fi
}

###############################################################################
# Check 6: BRIEFING.md directive staleness (was 35-briefing-directive-check_A.sh)
#   Cross-references directive IDs in BRIEFING.md against directives.json status
###############################################################################
check_briefing_directives() {
  local OUTPUT_FILE="$STATE_DIR/briefing-directive-audit.json"
  local BRIEFING="$DIR/BRIEFING.md"
  local DIRECTIVES_FILE="$DIR/directives.json"

  if [ ! -f "$BRIEFING" ] || [ ! -f "$DIRECTIVES_FILE" ]; then
    echo '{"checked":"'"$(date -Iseconds)"'","session":'"$SESSION"',"stale_count":0,"stale_refs":[],"error":"missing BRIEFING.md or directives.json"}' > "$OUTPUT_FILE"
    echo "[briefing-directives] ERROR: missing input files"
    return 0
  fi

  local RESULT
  RESULT=$(jq -n \
    --argjson session "$SESSION" \
    --arg checked "$(date -Iseconds)" \
    --arg briefing_content "$(cat "$BRIEFING")" \
    --slurpfile directives "$DIRECTIVES_FILE" \
    '
    ($directives[0].directives | map({(.id): .status}) | add // {}) as $status_map |
    ($directives[0].directives | map({(.id): (.completed_session // null)}) | add // {}) as $completed_map |
    [
      $briefing_content | split("\n") | to_entries[] |
      .key as $line_num |
      .value as $line |
      ($line | ascii_downcase) as $line_lower |
      [$line | match("d(0[0-9]{2})"; "g") | "d" + .captures[0].string] |
      select(length > 0) |
      .[] |
      . as $dir_id |
      select($status_map[$dir_id] == "completed") |
      select(
        ($line_lower | test("completed|done|closed|finished|retired|past deadline")) | not
      ) |
      select(
        ($line | test("\\([^)]*" + $dir_id + "[^(]*\\)")) | not
      ) |
      {
        directive: $dir_id,
        status: "completed",
        completed_session: $completed_map[$dir_id],
        briefing_line: ($line_num + 1),
        context: ($line | ltrimstr(" ") | if length > 120 then .[:120] + "..." else . end)
      }
    ] |
    group_by(.directive) | map(.[0]) |
    . as $stale_refs |
    {
      checked: $checked,
      session: $session,
      stale_count: ($stale_refs | length),
      stale_refs: $stale_refs,
      severity: (if ($stale_refs | length) > 0 then "critical" else "clean" end)
    }
  ') || {
    echo '{"checked":"'"$(date -Iseconds)"'","session":'"$SESSION"',"stale_count":0,"stale_refs":[],"error":"jq processing failed"}' > "$OUTPUT_FILE"
    echo "[briefing-directives] ERROR: jq processing failed"
    return 0
  }

  echo "$RESULT" > "$OUTPUT_FILE"
  local STALE_COUNT
  STALE_COUNT=$(echo "$RESULT" | jq '.stale_count')

  if [ "$STALE_COUNT" -gt 0 ]; then
    local DETAILS
    DETAILS=$(echo "$RESULT" | jq -r '[.stale_refs[] | "\(.directive)(completed s\(.completed_session // "?"))"] | join(", ")')
    echo "[briefing-directives] CRITICAL: $STALE_COUNT directive(s) referenced in BRIEFING.md but completed: $DETAILS"
  else
    echo "[briefing-directives] OK: no stale directive references in BRIEFING.md"
  fi
}

###############################################################################
# Check 7: Cost escalation (was 37-cost-escalation_A.sh)
#   Runs audit-cost-escalation.mjs to create wq items for cost trends
###############################################################################
check_cost_escalation() {
  local output
  output=$(node "$DIR/audit-cost-escalation.mjs" 2>&1) || {
    echo "[cost-escalation] WARN: audit-cost-escalation.mjs failed: $output"
    return 0
  }

  local items_created
  items_created=$(echo "$output" | jq -r '.items_created | length' 2>/dev/null) || items_created="?"
  echo "[cost-escalation] OK: checked cost trends, $items_created items created."

  if [ "$items_created" != "0" ] && [ "$items_created" != "?" ]; then
    echo "$output" | jq -r '.checks[] | select(.action == "created") | "  → \(.wq_id): \(.type) session avg $\(.last5_avg) >= $\(.threshold)"' 2>/dev/null || true
  fi
}

###############################################################################
# Run all checks sequentially
###############################################################################

check_cost_trends
check_stale_refs
check_hook_timing
check_stale_tags
check_cred_health
check_briefing_directives
check_cost_escalation

echo "[a-prehook] All 7 checks complete"

#!/usr/bin/env node
// spending-policy.mjs — Read spending policy and handle month reset.
// Extracted from 35-e-session-prehook_E.sh Check 5 inline node -e block.
//
// Args: --policy-file <path> --current-month <YYYY-MM>
// Output: pipe-delimited: monthly_limit|month_spent|per_session|per_platform|min_roi|was_reset

import { readFileSync, writeFileSync } from 'fs';

export function checkSpendingPolicy({ policyFile, currentMonth }) {
  const p = JSON.parse(readFileSync(policyFile, 'utf8'));
  let reset = false;

  if (p.ledger.current_month !== currentMonth) {
    p.ledger.current_month = currentMonth;
    p.ledger.month_spent_usd = 0;
    p.ledger.transactions = [];
    writeFileSync(policyFile, JSON.stringify(p, null, 2));
    reset = true;
  }

  return {
    monthlyLimit: p.policy.monthly_limit_usd,
    monthSpent: p.ledger.month_spent_usd,
    perSession: p.policy.per_session_limit_usd,
    perPlatform: p.policy.per_platform_limit_usd,
    minRoi: p.policy.min_roi_score_for_spend,
    wasReset: reset,
    // Pipe-delimited for backwards compat with shell
    pipe: [p.policy.monthly_limit_usd, p.ledger.month_spent_usd, p.policy.per_session_limit_usd, p.policy.per_platform_limit_usd, p.policy.min_roi_score_for_spend, reset].join('|'),
  };
}

// CLI mode
const _isMain = process.argv[1] && process.argv[1].endsWith('spending-policy.mjs');
if (_isMain) {
  const args = process.argv.slice(2);
  const policyIdx = args.indexOf('--policy-file');
  const monthIdx = args.indexOf('--current-month');

  if (policyIdx === -1 || monthIdx === -1) {
    console.error('Usage: spending-policy.mjs --policy-file <path> --current-month <YYYY-MM>');
    process.exit(1);
  }

  const result = checkSpendingPolicy({
    policyFile: args[policyIdx + 1],
    currentMonth: args[monthIdx + 1],
  });
  console.log(result.pipe);
}

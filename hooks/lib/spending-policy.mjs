#!/usr/bin/env node
// spending-policy.mjs — Read spending policy and handle month reset.
// Extracted from 35-e-session-prehook_E.sh Check 5 inline node -e block.
//
// Args: --policy-file <path> --current-month <YYYY-MM>
// Output: pipe-delimited: monthly_limit|month_spent|per_session|per_platform|min_roi|was_reset

import { readFileSync, writeFileSync } from 'fs';

const args = process.argv.slice(2);
const policyIdx = args.indexOf('--policy-file');
const monthIdx = args.indexOf('--current-month');

if (policyIdx === -1 || monthIdx === -1) {
  console.error('Usage: spending-policy.mjs --policy-file <path> --current-month <YYYY-MM>');
  process.exit(1);
}

const policyFile = args[policyIdx + 1];
const currentMonth = args[monthIdx + 1];

const p = JSON.parse(readFileSync(policyFile, 'utf8'));
let reset = false;

if (p.ledger.current_month !== currentMonth) {
  p.ledger.current_month = currentMonth;
  p.ledger.month_spent_usd = 0;
  p.ledger.transactions = [];
  writeFileSync(policyFile, JSON.stringify(p, null, 2));
  reset = true;
}

const ml = p.policy.monthly_limit_usd;
const ms = p.ledger.month_spent_usd;
console.log([ml, ms, p.policy.per_session_limit_usd, p.policy.per_platform_limit_usd, p.policy.min_roi_score_for_spend, reset].join('|'));

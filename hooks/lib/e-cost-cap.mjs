#!/usr/bin/env node
// e-cost-cap.mjs — E session cost cap and registration limit check
//
// Extracted from 36-e-session-posthook_E.sh Check 8 (R#321).
// Replaces two inline `node -e` blocks with a standalone, testable module.
//
// Usage (CLI):
//   node e-cost-cap.mjs
//   Reads from env: SESSION, HISTORY_FILE, TRACE_FILE, HAS_TRACE
//   Optional: E_COST_THRESHOLD (default 2.50)
//
// Usage (import):
//   import { checkCostCap } from './e-cost-cap.mjs';
//   checkCostCap({ session, historyFile, traceFile, hasTrace, threshold, deps });

import { readFileSync, appendFileSync } from 'fs';

const REG_KEYWORDS = ['register', 'signup', 'sign up', 'create account', 'new account', 'registration'];

export function checkCostCap({ session, historyFile, traceFile, hasTrace, threshold = 2.50, auditFile, deps = {} }) {
  const fs = {
    readFileSync: deps.readFileSync || readFileSync,
    appendFileSync: deps.appendFileSync || appendFileSync,
  };
  const log = deps.log || console.log;
  const results = { costOk: null, regOk: null, cost: null, regCount: 0 };

  // Extract cost from session-history.txt
  let cost = null;
  try {
    const history = fs.readFileSync(historyFile, 'utf8');
    const pattern = new RegExp(`s=${session} .*?cost=\\$(\\d+\\.\\d+)`);
    const match = history.match(pattern);
    if (match) cost = parseFloat(match[1]);
  } catch { /* no history file */ }

  if (cost === null) {
    log(`e-cost-cap: skip — no cost data yet for s${session}`);
    results.costOk = true; // no data = no violation
    return results;
  }

  results.cost = cost;

  if (cost > threshold) {
    log(`e-cost-cap: WARN — s${session} cost $${cost} exceeds $${threshold} threshold`);
    results.costOk = false;
    if (auditFile) {
      try {
        fs.appendFileSync(auditFile, `WARN: E session s${session} cost $${cost} > $${threshold} cap\n`);
      } catch { /* non-fatal */ }
    }
  } else {
    log(`e-cost-cap: OK — s${session} cost $${cost} (threshold: $${threshold})`);
    results.costOk = true;
  }

  // Check registration count in trace
  if (hasTrace && traceFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
      const traces = Array.isArray(raw) ? raw : [raw];
      const t = traces.find(tr => tr.session === session);

      if (t) {
        const text = JSON.stringify(t).toLowerCase();
        let keywordHits = 0;
        for (const kw of REG_KEYWORDS) {
          const re = new RegExp(kw, 'gi');
          const matches = text.match(re);
          if (matches) keywordHits += matches.length;
        }

        const platforms = t.platforms_engaged || [];
        const regPlatforms = platforms.filter(p => {
          return REG_KEYWORDS.some(kw => text.includes(kw) && text.includes(String(p).toLowerCase()));
        });

        const regCount = Math.min(keywordHits > 0 ? Math.max(1, regPlatforms.length) : 0, 5);
        results.regCount = regCount;

        if (regCount > 1) {
          log(`e-cost-cap: WARN — s${session} appears to have ${regCount} platform registrations (limit: 1)`);
          results.regOk = false;
          if (auditFile) {
            try {
              fs.appendFileSync(auditFile, `WARN: E session s${session} had ${regCount} platform registrations (limit: 1)\n`);
            } catch { /* non-fatal */ }
          }
        } else if (regCount === 1) {
          log(`e-cost-cap: OK — 1 platform registration detected (within limit)`);
          results.regOk = true;
        } else {
          results.regOk = true;
        }
      }
    } catch { /* trace parse error — non-fatal */ }
  }

  return results;
}

// CLI mode
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('e-cost-cap.mjs')) {
  const session = parseInt(process.env.SESSION);
  const historyFile = process.env.HISTORY_FILE;
  const traceFile = process.env.TRACE_FILE;
  const hasTrace = process.env.HAS_TRACE === 'true';
  const threshold = parseFloat(process.env.E_COST_THRESHOLD || '2.50');
  const auditFile = `${process.env.HOME}/.config/moltbook/maintain-audit.txt`;

  if (!session || !historyFile) {
    console.error('e-cost-cap: SESSION and HISTORY_FILE env vars required');
    process.exit(1);
  }

  try {
    checkCostCap({ session, historyFile, traceFile, hasTrace, threshold, auditFile });
  } catch (err) {
    console.error('e-cost-cap: ' + err.message);
    process.exit(1);
  }
}

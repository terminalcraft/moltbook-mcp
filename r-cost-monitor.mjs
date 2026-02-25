#!/usr/bin/env node
// r-cost-monitor.mjs — Track R session cost trend for wq-601
// Reads session-history.txt, extracts R session costs, reports trend status.
// Usage: node r-cost-monitor.mjs [--json]
//
// Decision thresholds (from A#140):
//   Pre-gap baseline: $1.1-1.5 (avg ~$1.45)
//   Post-gap observed: $2.3-2.8 (avg ~$2.58)
//   Alert if: 3 consecutive R sessions > $2.00 post-R#252 (s1482+)
//   R#252 structural change: pipeline supply target raised ≥3→≥5 (expected +$0.50/session)
//   Acceptable range: $1.50-$2.50 (baseline + structural adjustment)

import { readFileSync } from 'fs';
import { homedir } from 'os';

const HISTORY_PATH = `${homedir()}/.config/moltbook/session-history.txt`;
const MONITORING_START_SESSION = 1482; // R#252 — first session with new pipeline target
const BASELINE_AVG = 1.45;
const STRUCTURAL_ADJUSTMENT = 0.50; // Expected cost from ≥5 pipeline target
const ALERT_THRESHOLD = 2.50; // baseline + structural + margin
const CONSECUTIVE_ALERT = 3; // Alert after N consecutive sessions above threshold

const jsonMode = process.argv.includes('--json');

try {
  const lines = readFileSync(HISTORY_PATH, 'utf-8').trim().split('\n');

  const rSessions = lines
    .filter(l => l.includes('mode=R'))
    .map(l => {
      const sMatch = l.match(/s=(\d+)/);
      const costMatch = l.match(/cost=\$([0-9.]+)/);
      const durMatch = l.match(/dur=(\S+)/);
      const dateMatch = l.match(/^(\d{4}-\d{2}-\d{2})/);
      const noteMatch = l.match(/note:\s*(.+)/);
      return {
        session: sMatch ? parseInt(sMatch[1]) : 0,
        cost: costMatch ? parseFloat(costMatch[1]) : 0,
        duration: durMatch ? durMatch[1] : '?',
        date: dateMatch ? dateMatch[1] : '?',
        note: noteMatch ? noteMatch[1].slice(0, 60) : ''
      };
    })
    .filter(r => r.session > 0);

  const preGap = rSessions.filter(r => r.session < 1470);
  const postGap = rSessions.filter(r => r.session >= 1470);
  const postR252 = rSessions.filter(r => r.session >= MONITORING_START_SESSION);

  const avg = arr => arr.length ? arr.reduce((s, r) => s + r.cost, 0) / arr.length : 0;

  const preGapAvg = avg(preGap);
  const postGapAvg = avg(postGap);
  const postR252Avg = avg(postR252);

  // Count consecutive sessions above threshold (from most recent)
  let consecutiveAbove = 0;
  for (let i = postR252.length - 1; i >= 0; i--) {
    if (postR252[i].cost > ALERT_THRESHOLD) consecutiveAbove++;
    else break;
  }

  const monitored = postR252.length;
  const remaining = Math.max(0, CONSECUTIVE_ALERT - monitored);

  let status;
  if (monitored >= CONSECUTIVE_ALERT && consecutiveAbove >= CONSECUTIVE_ALERT) {
    status = 'ALERT'; // 3+ consecutive above threshold — investigate
  } else if (monitored >= CONSECUTIVE_ALERT && consecutiveAbove < CONSECUTIVE_ALERT) {
    status = 'RESOLVED'; // Enough data, trend is acceptable
  } else {
    status = 'MONITORING'; // Not enough data yet
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      status,
      preGapAvg: +preGapAvg.toFixed(2),
      postGapAvg: +postGapAvg.toFixed(2),
      postR252Avg: +postR252Avg.toFixed(2),
      alertThreshold: ALERT_THRESHOLD,
      monitored,
      remaining,
      consecutiveAbove,
      postR252Sessions: postR252
    }, null, 2));
  } else {
    console.log('=== R Session Cost Monitor (wq-601) ===');
    console.log(`Status: ${status}`);
    console.log(`Pre-gap avg:  $${preGapAvg.toFixed(2)} (${preGap.length} sessions)`);
    console.log(`Post-gap avg: $${postGapAvg.toFixed(2)} (${postGap.length} sessions)`);
    console.log(`Post-R#252:   $${postR252Avg.toFixed(2)} (${postR252.length} sessions)`);
    console.log(`Alert threshold: $${ALERT_THRESHOLD} (baseline $${BASELINE_AVG} + structural $${STRUCTURAL_ADJUSTMENT} + margin)`);
    console.log(`Consecutive above threshold: ${consecutiveAbove}/${CONSECUTIVE_ALERT}`);
    console.log(`Sessions monitored: ${monitored}, remaining: ${remaining}`);
    console.log('');
    console.log('Post-R#252 sessions:');
    for (const r of postR252) {
      const flag = r.cost > ALERT_THRESHOLD ? ' ⚠' : ' ✓';
      console.log(`  s${r.session} ${r.date} $${r.cost.toFixed(2)} ${r.duration}${flag}  ${r.note}`);
    }
    if (status === 'MONITORING') {
      console.log(`\nNeed ${remaining} more R session(s) to conclude.`);
    } else if (status === 'ALERT') {
      console.log('\n⚠ ALERT: Investigate R#252 prompt for scope creep.');
    } else {
      console.log('\n✓ Trend acceptable — R#252 pipeline target change justified.');
    }
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

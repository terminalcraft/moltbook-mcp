#!/usr/bin/env node
// d049-tracking-update.mjs — Updates e-phase35-tracking.json for d049 enforcement
//
// Extracted from 36-e-session-posthook_E.sh Check 2 (R#308).
// Replaces the 44-line inline Node heredoc with a standalone, testable module.
//
// Usage (CLI):
//   node d049-tracking-update.mjs
//   Reads from env: SESSION, TRACKING_FILE, INTEL_COUNT, FAILURE_MODE
//
// Usage (import):
//   import { updateTracking } from './d049-tracking-update.mjs';
//   updateTracking({ session, trackingFile, intelCount, failureMode, deps });

import { readFileSync, writeFileSync } from 'fs';

const FAILURE_LABELS = {
  rate_limit: 'Rate-limited — session could not start',
  truncated_early: 'Truncated before Phase 2',
  platform_unavailable: 'All picker platforms returned errors',
  trace_without_intel: 'Trace written (Phase 3a) but session ended before intel capture (Phase 3b)',
  agent_skip: 'Agent reached Phase 2 but did not capture intel (no trace either)',
  unknown: 'Failure mode could not be determined'
};

export function updateTracking({ session, trackingFile, intelCount, failureMode, deps = {} }) {
  const fs = {
    readFileSync: deps.readFileSync || readFileSync,
    writeFileSync: deps.writeFileSync || writeFileSync,
  };
  const log = deps.log || console.log;

  const compliant = intelCount > 0;

  let tracking;
  try {
    tracking = JSON.parse(fs.readFileSync(trackingFile, 'utf8'));
  } catch {
    tracking = { sessions: [] };
  }

  const sessions = tracking.sessions || [];
  const existing = sessions.find(s => s.session === session);

  if (existing) {
    existing.d049_compliant = compliant;
    existing.intel_count = intelCount;
    existing.enforcement = 'post-hook';
    if (failureMode !== 'none') existing.failure_mode = failureMode;
  } else {
    let eNum = sessions.filter(s => (s.session || 0) < session).length + 1;
    for (const s of sessions) {
      if ((s.e_number || 0) >= eNum) eNum = s.e_number + 1;
    }
    const entry = {
      session,
      e_number: eNum,
      d049_compliant: compliant,
      intel_count: intelCount,
      enforcement: 'post-hook',
      notes: 'Post-hook enforcement: ' + intelCount + ' intel entries captured'
    };
    if (failureMode !== 'none') {
      entry.failure_mode = failureMode;
      entry.notes = 'd049 violation (' + failureMode + '): ' + (FAILURE_LABELS[failureMode] || failureMode);
    }
    sessions.push(entry);
  }

  tracking.sessions = sessions;
  fs.writeFileSync(trackingFile, JSON.stringify(tracking, null, 2) + '\n');
  log('d049-enforcement: updated tracking for s' + session + ' (compliant=' + compliant + ', count=' + intelCount + ', failure_mode=' + failureMode + ')');

  return { compliant, tracking };
}

// CLI mode
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('d049-tracking-update.mjs')) {
  const session = parseInt(process.env.SESSION);
  const trackingFile = process.env.TRACKING_FILE;
  const intelCount = parseInt(process.env.INTEL_COUNT || '0');
  const failureMode = process.env.FAILURE_MODE || 'unknown';

  if (!session || !trackingFile) {
    console.error('d049-tracking-update: SESSION and TRACKING_FILE env vars required');
    process.exit(1);
  }

  try {
    updateTracking({ session, trackingFile, intelCount, failureMode });
  } catch (err) {
    console.error('d049-tracking-update: ' + err.message);
    process.exit(1);
  }
}

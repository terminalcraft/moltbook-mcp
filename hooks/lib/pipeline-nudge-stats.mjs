#!/usr/bin/env node
// pipeline-nudge-stats.mjs — Extract B pipeline gate stats from audit-stats.
//
// Extracted from 45-b-session-prehook_B.sh Check 4 (R#336).
// Replaces 3 inline `node -e` calls with a single testable module.
//
// Usage (CLI):  node pipeline-nudge-stats.mjs <session_num> <mcp_dir>
// Output:       JSON line: {"violations":<n>,"rate":"<x/y>"}
//
// Usage (lib):  import { getPipelineGateStats } from './pipeline-nudge-stats.mjs'

import { execSync } from 'child_process';

/**
 * Get B pipeline gate stats from audit-stats.mjs.
 * @param {number} sessionNum - Current session number
 * @param {string} mcpDir - Path to moltbook-mcp directory
 * @returns {{ violations: number, rate: string }}
 */
export function getPipelineGateStats(sessionNum, mcpDir) {
  try {
    const raw = execSync(`SESSION_NUM=${sessionNum} node ${mcpDir}/audit-stats.mjs`, {
      encoding: 'utf8',
      timeout: 10000,
    });
    const stats = JSON.parse(raw);
    const g = stats.b_pipeline_gate || {};
    return {
      violations: g.violation_count || 0,
      rate: g.rate || 'N/A',
    };
  } catch {
    return { violations: 0, rate: 'N/A' };
  }
}

// --- CLI entrypoint ---
if (process.argv[1]?.endsWith('pipeline-nudge-stats.mjs')) {
  const sessionNum = parseInt(process.argv[2] || '0', 10);
  const mcpDir = process.argv[3] || process.cwd();
  const result = getPipelineGateStats(sessionNum, mcpDir);
  process.stdout.write(JSON.stringify(result));
}

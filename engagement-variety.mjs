#!/usr/bin/env node
/**
 * engagement-variety.mjs - Analyze engagement-trace.json for platform concentration
 *
 * Alerts when >60% of recent E session engagement targets one platform.
 * Supplements picker compliance tracking (wq-346, R#190).
 *
 * Usage:
 *   node engagement-variety.mjs [--sessions N] [--threshold PCT] [--json]
 *
 * Options:
 *   --sessions N     Number of recent E sessions to analyze (default: 5)
 *   --threshold PCT  Concentration threshold percentage (default: 60)
 *   --json          Output as JSON instead of human-readable
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const TRACE_PATH = join(process.env.HOME || '/home/moltbot', '.config/moltbook/engagement-trace.json');

function loadTrace() {
  if (!existsSync(TRACE_PATH)) {
    return [];
  }
  try {
    return JSON.parse(readFileSync(TRACE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function analyzeVariety(sessions = 5, threshold = 60) {
  const traces = loadTrace();

  if (traces.length === 0) {
    return {
      status: 'NO_DATA',
      message: 'No engagement traces found',
      sessions_analyzed: 0,
      platform_distribution: {},
      concentration_alert: false
    };
  }

  // Get most recent N sessions
  const recentTraces = traces.slice(-sessions);
  const sessionsAnalyzed = recentTraces.length;

  if (sessionsAnalyzed === 0) {
    return {
      status: 'NO_DATA',
      message: 'No recent engagement traces',
      sessions_analyzed: 0,
      platform_distribution: {},
      concentration_alert: false
    };
  }

  // Count engagement actions per platform across all recent sessions
  const platformCounts = {};
  let totalActions = 0;

  for (const trace of recentTraces) {
    // Count from threads_contributed (actual engagement actions)
    if (trace.threads_contributed && Array.isArray(trace.threads_contributed)) {
      for (const thread of trace.threads_contributed) {
        const platform = thread.platform || 'unknown';
        platformCounts[platform] = (platformCounts[platform] || 0) + 1;
        totalActions++;
      }
    }

    // Also count from platforms_engaged if no threads (lighter metric)
    if (!trace.threads_contributed && trace.platforms_engaged) {
      for (const platform of trace.platforms_engaged) {
        platformCounts[platform] = (platformCounts[platform] || 0) + 1;
        totalActions++;
      }
    }
  }

  if (totalActions === 0) {
    return {
      status: 'NO_ACTIONS',
      message: 'No engagement actions found in recent traces',
      sessions_analyzed: sessionsAnalyzed,
      platform_distribution: {},
      concentration_alert: false
    };
  }

  // Calculate percentages
  const distribution = {};
  let maxPlatform = null;
  let maxPercentage = 0;

  for (const [platform, count] of Object.entries(platformCounts)) {
    const pct = Math.round((count / totalActions) * 100);
    distribution[platform] = {
      count,
      percentage: pct
    };
    if (pct > maxPercentage) {
      maxPercentage = pct;
      maxPlatform = platform;
    }
  }

  // Check for concentration alert
  const concentrationAlert = maxPercentage > threshold;

  // Build status message
  let status = 'HEALTHY';
  let message = `Engagement distributed across ${Object.keys(distribution).length} platforms`;

  if (concentrationAlert) {
    status = 'CONCENTRATED';
    message = `⚠ ${maxPlatform} has ${maxPercentage}% of engagement (>${threshold}% threshold)`;
  }

  // Get session numbers for reference
  const sessionNumbers = recentTraces.map(t => t.session);

  return {
    status,
    message,
    sessions_analyzed: sessionsAnalyzed,
    session_numbers: sessionNumbers,
    total_actions: totalActions,
    platform_distribution: distribution,
    concentration_alert: concentrationAlert,
    most_engaged: maxPlatform,
    most_engaged_pct: maxPercentage,
    threshold
  };
}

// CLI
function main() {
  const args = process.argv.slice(2);

  let sessions = 5;
  let threshold = 60;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sessions' && args[i + 1]) {
      sessions = parseInt(args[i + 1], 10) || 5;
      i++;
    } else if (args[i] === '--threshold' && args[i + 1]) {
      threshold = parseInt(args[i + 1], 10) || 60;
      i++;
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: node engagement-variety.mjs [--sessions N] [--threshold PCT] [--json]

Analyze engagement-trace.json for platform concentration.
Alerts when a single platform has >threshold% of recent engagement.

Options:
  --sessions N     Number of recent E sessions to analyze (default: 5)
  --threshold PCT  Concentration threshold percentage (default: 60)
  --json          Output as JSON instead of human-readable`);
      process.exit(0);
    }
  }

  const result = analyzeVariety(sessions, threshold);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`=== Engagement Variety Analysis ===`);
    console.log(`Sessions analyzed: ${result.sessions_analyzed}${result.session_numbers ? ` (${result.session_numbers.join(', ')})` : ''}`);
    console.log(`Total actions: ${result.total_actions || 0}`);
    console.log(`Status: ${result.status}`);
    console.log(`Message: ${result.message}`);
    console.log('');

    if (Object.keys(result.platform_distribution).length > 0) {
      console.log('Platform Distribution:');
      // Sort by percentage descending
      const sorted = Object.entries(result.platform_distribution)
        .sort((a, b) => b[1].percentage - a[1].percentage);

      for (const [platform, data] of sorted) {
        const bar = '█'.repeat(Math.floor(data.percentage / 5));
        const marker = data.percentage > result.threshold ? ' ⚠' : '';
        console.log(`  ${platform.padEnd(15)} ${String(data.percentage).padStart(3)}% ${bar}${marker}`);
      }
    }
  }
}

main();

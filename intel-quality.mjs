#!/usr/bin/env node
/**
 * intel-quality.mjs - Intel-to-queue pipeline health metrics (wq-273)
 *
 * Tracks:
 * 1. Intel entries created per E session
 * 2. Entries promoted to queue (source: intel-auto)
 * 3. Entries retired without work
 * 4. Actionable text length distribution
 *
 * Output feeds R session prompt for monitoring. Target: 20%+ conversion rate.
 *
 * Usage: node intel-quality.mjs [--json] [--window N]
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONFIG_DIR = join(process.env.HOME, '.config/moltbook');
const PROJECT_DIR = process.cwd();
const SESSION_HISTORY_PATH = join(CONFIG_DIR, 'session-history.txt');
const INTEL_ARCHIVE_PATH = join(CONFIG_DIR, 'engagement-intel-archive.json');
const WORK_QUEUE_PATH = join(PROJECT_DIR, 'work-queue.json');
const WORK_QUEUE_ARCHIVE_PATH = join(PROJECT_DIR, 'work-queue-archive.json');

/**
 * Parse session history to find E session numbers
 */
function getESessionNumbers(window = 20) {
  if (!existsSync(SESSION_HISTORY_PATH)) return [];
  const content = readFileSync(SESSION_HISTORY_PATH, 'utf8');
  const lines = content.trim().split('\n').filter(l => l.includes('mode=E'));
  return lines.slice(-window).map(l => {
    const match = l.match(/s=(\d+)/);
    return match ? parseInt(match[1]) : null;
  }).filter(Boolean);
}

/**
 * Load intel archive entries
 */
function loadIntelArchive() {
  if (!existsSync(INTEL_ARCHIVE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(INTEL_ARCHIVE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Load work queue items (both current and archived)
 */
function loadAllQueueItems() {
  const items = [];

  // Current queue
  if (existsSync(WORK_QUEUE_PATH)) {
    try {
      const wq = JSON.parse(readFileSync(WORK_QUEUE_PATH, 'utf8'));
      items.push(...(wq.queue || []));
    } catch {}
  }

  // Archived queue
  if (existsSync(WORK_QUEUE_ARCHIVE_PATH)) {
    try {
      const archive = JSON.parse(readFileSync(WORK_QUEUE_ARCHIVE_PATH, 'utf8'));
      items.push(...(archive.archived || []));
    } catch {}
  }

  return items;
}

/**
 * Calculate intel quality metrics
 */
function calculateMetrics(window = 20) {
  const eSessions = getESessionNumbers(window);
  const archive = loadIntelArchive();
  const queueItems = loadAllQueueItems();

  // Filter intel entries to the E sessions in our window
  // Use session field if available, else consumed_session
  const windowIntel = archive.filter(e => {
    const session = e.session || e.consumed_session;
    return eSessions.includes(session);
  });

  // Get intel-auto queue items
  const intelAutoItems = queueItems.filter(i => i.source === 'intel-auto');

  // Map: which intel entries have matching queue items?
  // Queue items have descriptions like "[source: engagement intel sXXX]"
  const promotedSessions = new Set();
  const promotedItems = [];
  const retiredItems = [];
  const workedItems = [];

  for (const item of intelAutoItems) {
    // Extract source session from description
    const match = (item.description || '').match(/\[source: engagement intel s(\d+)\]/);
    if (match) {
      promotedSessions.add(parseInt(match[1]));
    }
    promotedItems.push(item);

    if (item.status === 'done') {
      workedItems.push(item);
    } else if (item.status === 'retired') {
      retiredItems.push(item);
    }
  }

  // Count intel entries per E session
  const intelPerSession = {};
  for (const session of eSessions) {
    intelPerSession[session] = archive.filter(e =>
      (e.session === session || e.consumed_session === session)
    ).length;
  }

  // Actionable text length distribution
  const actionableLengths = windowIntel
    .filter(e => e.actionable)
    .map(e => e.actionable.length);

  const lengthDistribution = {
    short: actionableLengths.filter(l => l <= 20).length,    // <20 chars
    medium: actionableLengths.filter(l => l > 20 && l <= 50).length,  // 20-50 chars
    long: actionableLengths.filter(l => l > 50 && l <= 100).length,   // 50-100 chars
    detailed: actionableLengths.filter(l => l > 100).length,  // 100+ chars
  };

  // Conversion metrics
  const totalPromoted = promotedItems.length;
  const totalRetiredWithoutWork = retiredItems.length;
  const totalWorked = workedItems.length;
  const conversionRate = totalPromoted > 0
    ? Math.round((totalWorked / totalPromoted) * 100)
    : 0;

  // Intel to queue conversion (how many intel entries became queue items)
  const intelWithActionable = windowIntel.filter(e =>
    e.actionable && e.actionable.length > 20
  ).length;
  const intelToQueueRate = intelWithActionable > 0
    ? Math.round((promotedItems.filter(p => {
        const match = (p.description || '').match(/s(\d+)/);
        return match && eSessions.includes(parseInt(match[1]));
      }).length / intelWithActionable) * 100)
    : 0;

  return {
    window: {
      e_sessions: eSessions.length,
      first_session: Math.min(...eSessions) || 0,
      last_session: Math.max(...eSessions) || 0,
    },
    intel_generation: {
      total_entries: windowIntel.length,
      entries_per_session: eSessions.length > 0
        ? Math.round((windowIntel.length / eSessions.length) * 10) / 10
        : 0,
      with_actionable: intelWithActionable,
      sessions_with_intel: Object.values(intelPerSession).filter(c => c > 0).length,
    },
    promotion: {
      total_promoted: totalPromoted,
      intel_to_queue_rate: intelToQueueRate,
    },
    outcomes: {
      worked: totalWorked,
      retired_without_work: totalRetiredWithoutWork,
      in_progress: promotedItems.filter(i => i.status === 'in-progress').length,
      pending: promotedItems.filter(i => i.status === 'pending').length,
      conversion_rate: conversionRate,
    },
    actionable_length: {
      distribution: lengthDistribution,
      avg_length: actionableLengths.length > 0
        ? Math.round(actionableLengths.reduce((a, b) => a + b, 0) / actionableLengths.length)
        : 0,
    },
    target: {
      conversion_goal: 20,
      on_track: conversionRate >= 20,
    },
    intel_per_session: intelPerSession,
  };
}

/**
 * Format metrics for R session prompt
 */
function formatForPrompt(metrics) {
  const lines = [
    '## Intel Pipeline Health\n',
    `Window: ${metrics.window.e_sessions} E sessions (s${metrics.window.first_session}-s${metrics.window.last_session})\n`,
    '### Generation',
    `- Total intel entries: ${metrics.intel_generation.total_entries}`,
    `- Entries per E session: ${metrics.intel_generation.entries_per_session}`,
    `- With actionable text (>20 chars): ${metrics.intel_generation.with_actionable}`,
    '',
    '### Promotion & Outcomes',
    `- Promoted to queue: ${metrics.promotion.total_promoted}`,
    `- Worked (done): ${metrics.outcomes.worked}`,
    `- Retired without work: ${metrics.outcomes.retired_without_work}`,
    `- **Conversion rate**: ${metrics.outcomes.conversion_rate}% (target: 20%+)`,
    '',
    '### Actionable Text Quality',
    `- Avg length: ${metrics.actionable_length.avg_length} chars`,
    `- Distribution: short=${metrics.actionable_length.distribution.short}, medium=${metrics.actionable_length.distribution.medium}, long=${metrics.actionable_length.distribution.long}, detailed=${metrics.actionable_length.distribution.detailed}`,
    '',
  ];

  if (!metrics.target.on_track) {
    lines.push('⚠️ Below 20% conversion target. Consider:');
    lines.push('  - Improve actionable text quality in E sessions');
    lines.push('  - Review imperative verb filter in session-context.mjs:539');
    lines.push('  - Check intel-promotion-tracking.json for patterns');
  } else {
    lines.push('✓ Meeting 20% conversion target');
  }

  return lines.join('\n');
}

// CLI entry point
function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const windowArg = args.find(a => a.startsWith('--window='));
  const window = windowArg ? parseInt(windowArg.split('=')[1]) : 20;

  const metrics = calculateMetrics(window);

  if (jsonOutput) {
    console.log(JSON.stringify(metrics, null, 2));
  } else {
    console.log(formatForPrompt(metrics));
  }
}

main();

// Export for testing and API integration
export { calculateMetrics, formatForPrompt, getESessionNumbers, loadIntelArchive, loadAllQueueItems };

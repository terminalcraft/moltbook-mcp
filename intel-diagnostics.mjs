#!/usr/bin/env node
/**
 * intel-diagnostics.mjs - Automated intel→queue pipeline diagnostics for R sessions
 *
 * Checks:
 * 1. engagement-intel.json status (empty, has actionable, etc.)
 * 2. work-queue.json pending count (capacity gate)
 * 3. intel-promotion-tracking.json outcomes
 *
 * Usage: node intel-diagnostics.mjs
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONFIG_DIR = join(process.env.HOME, '.config/moltbook');
const PROJECT_DIR = process.cwd();

function readJSON(path, defaultValue = null) {
  try {
    if (!existsSync(path)) return defaultValue;
    const content = readFileSync(path, 'utf8').trim();
    // engagement-intel.json is now always JSON array format
    if (path.includes('engagement-intel')) {
      if (!content || content === '[]') return [];
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    }
    return JSON.parse(content);
  } catch (e) {
    return defaultValue;
  }
}

function diagnose() {
  console.log('# Intel→Queue Pipeline Diagnostics\n');

  // 1. Check engagement-intel.json
  const intelPath = join(CONFIG_DIR, 'engagement-intel.json');
  const intel = readJSON(intelPath, []);
  const actionableIntel = intel.filter(i => i.actionable && i.actionable.length > 20);

  console.log('## Engagement Intel');
  console.log(`- Total entries: ${intel.length}`);
  console.log(`- With actionable text: ${actionableIntel.length}`);

  if (intel.length === 0) {
    console.log('- **DIAGNOSIS**: No intel entries. E sessions not generating intel.');
    console.log('- **ACTION**: Add brainstorm idea "E session intel generation"');
  } else if (actionableIntel.length === 0) {
    console.log('- **DIAGNOSIS**: Intel exists but no actionable fields.');
    console.log('- **ACTION**: Check session-context.mjs promotion code');
  }

  // 2. Check work-queue capacity
  const queuePath = join(PROJECT_DIR, 'work-queue.json');
  const queue = readJSON(queuePath, { queue: [] });
  const pendingCount = queue.queue.filter(i => i.status === 'pending').length;

  console.log('\n## Work Queue Capacity');
  console.log(`- Pending items: ${pendingCount}`);
  console.log(`- Capacity gate: ${pendingCount >= 5 ? 'BLOCKING (>=5)' : 'OPEN (<5)'}`);

  if (pendingCount >= 5 && actionableIntel.length > 0) {
    console.log('- **DIAGNOSIS**: Capacity gate blocking promotions. Expected behavior.');
    console.log('- **ACTION**: None needed — intel will promote when queue drops below 5');
  }

  // 3. Check promotion tracking
  const trackingPath = join(PROJECT_DIR, 'intel-promotion-tracking.json');
  const tracking = readJSON(trackingPath, null);

  console.log('\n## Promotion Tracking');
  if (!tracking) {
    console.log('- Tracking file not found');
  } else {
    const window = tracking.tracking_window || {};
    console.log(`- Items tracked: ${window.items_tracked || 0}/${window.items_to_track || 3}`);
    console.log(`- Items worked: ${window.items_worked || 0}`);
    console.log(`- Items retired: ${window.items_retired || 0}`);

    const successRate = window.items_tracked > 0
      ? Math.round((window.items_worked / window.items_tracked) * 100)
      : 0;
    console.log(`- Success rate: ${successRate}%`);

    if (window.items_retired > window.items_worked) {
      console.log('- **DIAGNOSIS**: More items retired than worked — promotion quality issue');
      console.log('- **ACTION**: Review potential_fixes in tracking file');
      if (tracking.potential_fixes) {
        console.log('\nPotential fixes available:');
        for (const [key, fix] of Object.entries(tracking.potential_fixes)) {
          console.log(`  - ${key}: ${fix.effectiveness} effectiveness`);
        }
      }
    }
  }

  // Summary
  console.log('\n## Summary');
  if (intel.length === 0) {
    console.log('Pipeline status: **BROKEN** — no intel being generated');
  } else if (pendingCount >= 5) {
    console.log('Pipeline status: **GATED** — capacity full, will resume when queue drains');
  } else if (actionableIntel.length === 0) {
    console.log('Pipeline status: **DEGRADED** — intel lacks actionable items');
  } else {
    console.log('Pipeline status: **HEALTHY** — intel flowing to queue');
  }
}

diagnose();

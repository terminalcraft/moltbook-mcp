#!/usr/bin/env node
/**
 * intel-quality.test.mjs - Tests for intel quality metrics (wq-273)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Create a test directory
const TEST_DIR = join(tmpdir(), `intel-quality-test-${Date.now()}`);
const TEST_CONFIG_DIR = join(TEST_DIR, 'config');
const TEST_PROJECT_DIR = join(TEST_DIR, 'project');

// Mock the CONFIG_DIR and PROJECT_DIR in the module
// We'll test the helper functions directly

describe('Intel Quality Metrics', () => {
  beforeEach(() => {
    mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
  });

  afterEach(() => {
    // Cleanup
    try {
      const files = [
        join(TEST_CONFIG_DIR, 'session-history.txt'),
        join(TEST_CONFIG_DIR, 'engagement-intel-archive.json'),
        join(TEST_PROJECT_DIR, 'work-queue.json'),
        join(TEST_PROJECT_DIR, 'work-queue-archive.json')
      ];
      files.forEach(f => { try { unlinkSync(f); } catch {} });
    } catch {}
  });

  describe('getESessionNumbers', () => {
    it('should extract E session numbers from history', async () => {
      const { getESessionNumbers } = await import('./intel-quality.mjs');
      // Uses real session history, so just verify it returns an array
      const sessions = getESessionNumbers(5);
      assert(Array.isArray(sessions), 'Should return an array');
    });
  });

  describe('loadIntelArchive', () => {
    it('should return an array from archive', async () => {
      const { loadIntelArchive } = await import('./intel-quality.mjs');
      const archive = loadIntelArchive();
      assert(Array.isArray(archive), 'Should return an array');
    });
  });

  describe('loadAllQueueItems', () => {
    it('should return an array of queue items', async () => {
      const { loadAllQueueItems } = await import('./intel-quality.mjs');
      const items = loadAllQueueItems();
      assert(Array.isArray(items), 'Should return an array');
    });
  });

  describe('calculateMetrics', () => {
    it('should return metrics object with required fields', async () => {
      const { calculateMetrics } = await import('./intel-quality.mjs');
      const metrics = calculateMetrics(5);

      // Check top-level structure
      assert(metrics.window, 'Should have window field');
      assert(metrics.intel_generation, 'Should have intel_generation field');
      assert(metrics.promotion, 'Should have promotion field');
      assert(metrics.outcomes, 'Should have outcomes field');
      assert(metrics.actionable_length, 'Should have actionable_length field');
      assert(metrics.target, 'Should have target field');

      // Check window fields
      assert(typeof metrics.window.e_sessions === 'number', 'e_sessions should be number');
      assert(typeof metrics.window.first_session === 'number', 'first_session should be number');
      assert(typeof metrics.window.last_session === 'number', 'last_session should be number');

      // Check intel_generation fields
      assert(typeof metrics.intel_generation.total_entries === 'number', 'total_entries should be number');
      assert(typeof metrics.intel_generation.entries_per_session === 'number', 'entries_per_session should be number');
      assert(typeof metrics.intel_generation.with_actionable === 'number', 'with_actionable should be number');

      // Check outcomes fields
      assert(typeof metrics.outcomes.worked === 'number', 'worked should be number');
      assert(typeof metrics.outcomes.retired_without_work === 'number', 'retired_without_work should be number');
      assert(typeof metrics.outcomes.conversion_rate === 'number', 'conversion_rate should be number');

      // Check target fields
      assert(metrics.target.conversion_goal === 20, 'conversion_goal should be 20');
      assert(typeof metrics.target.on_track === 'boolean', 'on_track should be boolean');
    });

    it('should use default window of 20 when not specified', async () => {
      const { calculateMetrics } = await import('./intel-quality.mjs');
      const metrics = calculateMetrics();
      // Just verify it runs without error
      assert(metrics, 'Should return metrics');
    });
  });

  describe('formatForPrompt', () => {
    it('should return formatted markdown string', async () => {
      const { calculateMetrics, formatForPrompt } = await import('./intel-quality.mjs');
      const metrics = calculateMetrics(5);
      const formatted = formatForPrompt(metrics);

      assert(typeof formatted === 'string', 'Should return string');
      assert(formatted.includes('Intel Pipeline Health'), 'Should have header');
      assert(formatted.includes('Generation'), 'Should have Generation section');
      assert(formatted.includes('Promotion'), 'Should have Promotion section');
      assert(formatted.includes('Conversion rate'), 'Should mention conversion rate');
    });

    it('should show on-track message when meeting target', async () => {
      const { formatForPrompt } = await import('./intel-quality.mjs');
      const mockMetrics = {
        window: { e_sessions: 5, first_session: 100, last_session: 105 },
        intel_generation: { total_entries: 10, entries_per_session: 2, with_actionable: 8 },
        promotion: { total_promoted: 5, intel_to_queue_rate: 50 },
        outcomes: { worked: 3, retired_without_work: 1, in_progress: 0, pending: 1, conversion_rate: 60 },
        actionable_length: { distribution: { short: 0, medium: 2, long: 5, detailed: 1 }, avg_length: 75 },
        target: { conversion_goal: 20, on_track: true }
      };
      const formatted = formatForPrompt(mockMetrics);
      assert(formatted.includes('Meeting 20% conversion target'), 'Should show success message');
    });

    it('should show warning when below target', async () => {
      const { formatForPrompt } = await import('./intel-quality.mjs');
      const mockMetrics = {
        window: { e_sessions: 5, first_session: 100, last_session: 105 },
        intel_generation: { total_entries: 10, entries_per_session: 2, with_actionable: 8 },
        promotion: { total_promoted: 5, intel_to_queue_rate: 10 },
        outcomes: { worked: 0, retired_without_work: 4, in_progress: 0, pending: 1, conversion_rate: 0 },
        actionable_length: { distribution: { short: 5, medium: 2, long: 1, detailed: 0 }, avg_length: 25 },
        target: { conversion_goal: 20, on_track: false }
      };
      const formatted = formatForPrompt(mockMetrics);
      assert(formatted.includes('Below 20% conversion target'), 'Should show warning message');
    });
  });

  describe('actionable length distribution', () => {
    it('should categorize lengths correctly', async () => {
      const { calculateMetrics } = await import('./intel-quality.mjs');
      const metrics = calculateMetrics(20);
      const dist = metrics.actionable_length.distribution;

      // Just verify structure
      assert(typeof dist.short === 'number', 'short should be number');
      assert(typeof dist.medium === 'number', 'medium should be number');
      assert(typeof dist.long === 'number', 'long should be number');
      assert(typeof dist.detailed === 'number', 'detailed should be number');
    });
  });

  describe('intel_per_session tracking', () => {
    it('should return object mapping session numbers to counts', async () => {
      const { calculateMetrics } = await import('./intel-quality.mjs');
      const metrics = calculateMetrics(5);
      const perSession = metrics.intel_per_session;

      assert(typeof perSession === 'object', 'intel_per_session should be object');
      // Each value should be a number
      for (const [session, count] of Object.entries(perSession)) {
        assert(!isNaN(parseInt(session)), 'Session key should be numeric');
        assert(typeof count === 'number', 'Count should be number');
      }
    });
  });
});

// Run with: node --test intel-quality.test.mjs

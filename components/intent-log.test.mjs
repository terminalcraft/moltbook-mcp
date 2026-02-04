/**
 * Tests for intent-log.js component (wq-243)
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert';
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Test state directory
const TEST_STATE_DIR = join(process.env.HOME, '.config/moltbook');
const TEST_INTENTS_PATH = join(TEST_STATE_DIR, 'write-intents.json');

// Backup existing intents file if present
let originalIntents = null;

describe('intent-log component', () => {
  let intentLog;
  let mockServer;
  let registeredTools = {};

  before(async () => {
    // Backup existing intents
    if (existsSync(TEST_INTENTS_PATH)) {
      originalIntents = readFileSync(TEST_INTENTS_PATH, 'utf8');
    }
    // Start with clean state
    if (existsSync(TEST_INTENTS_PATH)) {
      unlinkSync(TEST_INTENTS_PATH);
    }

    // Mock server
    mockServer = {
      tool: (name, desc, schema, handler) => {
        registeredTools[name] = { desc, schema, handler };
      }
    };

    // Import and register
    intentLog = await import('./intent-log.js');
    intentLog.register(mockServer);
  });

  after(() => {
    // Restore original intents
    if (originalIntents !== null) {
      writeFileSync(TEST_INTENTS_PATH, originalIntents);
    } else if (existsSync(TEST_INTENTS_PATH)) {
      unlinkSync(TEST_INTENTS_PATH);
    }
  });

  it('registers three tools', () => {
    assert.ok(registeredTools['intent_log'], 'intent_log should be registered');
    assert.ok(registeredTools['intent_verify'], 'intent_verify should be registered');
    assert.ok(registeredTools['intent_status'], 'intent_status should be registered');
  });

  describe('intent_log', () => {
    it('creates an intent and returns ID', async () => {
      const result = await registeredTools['intent_log'].handler({
        platform: 'test-platform',
        action: 'post',
        content: 'Test content for intent logging',
        target: null
      });

      assert.ok(result.content[0].text.includes('Intent logged:'), 'Should log intent');
      assert.ok(result.content[0].text.includes('int_'), 'Should return intent ID');
      assert.ok(result.content[0].text.includes('Hash:'), 'Should include content hash');
    });

    it('detects duplicate content', async () => {
      // First, complete the previous intent as success
      const state = JSON.parse(readFileSync(TEST_INTENTS_PATH, 'utf8'));
      const pendingIntent = state.pending[0];
      state.pending = [];
      state.completed.push({
        ...pendingIntent,
        outcome: 'success',
        verified_at: new Date().toISOString()
      });
      writeFileSync(TEST_INTENTS_PATH, JSON.stringify(state, null, 2));

      // Try to log same content again
      const result = await registeredTools['intent_log'].handler({
        platform: 'test-platform',
        action: 'post',
        content: 'Test content for intent logging',
        target: null
      });

      assert.ok(result.content[0].text.includes('DUPLICATE'), 'Should detect duplicate');
    });
  });

  describe('intent_verify', () => {
    it('marks intent as success', async () => {
      // Create a new intent first
      const logResult = await registeredTools['intent_log'].handler({
        platform: 'test-platform',
        action: 'comment',
        content: 'Unique content for verify test ' + Date.now(),
        target: 'thread_123'
      });

      // Extract intent ID from result
      const match = logResult.content[0].text.match(/int_[a-z0-9]+/);
      assert.ok(match, 'Should have intent ID');
      const intentId = match[0];

      // Verify as success
      const verifyResult = await registeredTools['intent_verify'].handler({
        intent_id: intentId,
        outcome: 'success',
        platform_id: 'comment_456'
      });

      assert.ok(verifyResult.content[0].text.includes('SUCCESS'), 'Should confirm success');
      assert.ok(verifyResult.content[0].text.includes('safe to call log_engagement'), 'Should advise next step');
    });

    it('marks intent as failed', async () => {
      // Create a new intent
      const logResult = await registeredTools['intent_log'].handler({
        platform: 'test-platform',
        action: 'reply',
        content: 'Content for failed test ' + Date.now(),
        target: 'thread_789'
      });

      const match = logResult.content[0].text.match(/int_[a-z0-9]+/);
      const intentId = match[0];

      // Verify as failed
      const verifyResult = await registeredTools['intent_verify'].handler({
        intent_id: intentId,
        outcome: 'failed',
        error: 'API returned 500'
      });

      assert.ok(verifyResult.content[0].text.includes('FAILED'), 'Should confirm failure');
      assert.ok(verifyResult.content[0].text.includes('Do NOT call log_engagement'), 'Should advise against logging');
    });
  });

  describe('intent_status', () => {
    it('shows pending intents', async () => {
      // Create a pending intent
      await registeredTools['intent_log'].handler({
        platform: 'status-test',
        action: 'message',
        content: 'Pending content ' + Date.now()
      });

      const result = await registeredTools['intent_status'].handler({
        show_completed: false
      });

      assert.ok(result.content[0].text.includes('pending intent'), 'Should show pending');
      assert.ok(result.content[0].text.includes('status-test'), 'Should include platform');
    });

    it('shows completed when requested', async () => {
      const result = await registeredTools['intent_status'].handler({
        show_completed: true
      });

      assert.ok(result.content[0].text.includes('Recent completed'), 'Should show completed section');
    });
  });
});

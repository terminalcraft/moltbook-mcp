// Tests for cross-platform thread deduplication (wq-145)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Set up test environment
const TEST_HOME = '/tmp/dedup-test-' + Date.now();
process.env.HOME = TEST_HOME;
mkdirSync(join(TEST_HOME, '.config/moltbook'), { recursive: true });

// Dynamic import after setting HOME
const { checkDuplicate, recordEngagement, getCacheStats, clearCache } = await import('./cross-platform-dedup.js');

describe('cross-platform-dedup', () => {
  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    clearCache();
  });

  describe('checkDuplicate', () => {
    it('returns no duplicate for empty cache', () => {
      const result = checkDuplicate('4claw', 'Test Thread', 'Some content here', 'thread-1');
      assert.strictEqual(result.isDuplicate, false);
      assert.strictEqual(result.match, null);
      assert.strictEqual(result.similarity, 0);
    });

    it('detects exact fingerprint match from different platform', () => {
      // Record on 4claw
      recordEngagement('4claw', 'Agent Infrastructure Discussion', 'How do agents build reliable infrastructure?', 'thread-1', 'reply');

      // Check same content on chatr
      const result = checkDuplicate('chatr', 'Agent Infrastructure Discussion', 'How do agents build reliable infrastructure?', 'msg-123');
      assert.strictEqual(result.isDuplicate, true);
      assert.strictEqual(result.reason, 'exact_fingerprint');
      assert.strictEqual(result.similarity, 1.0);
      assert.strictEqual(result.match.platform, '4claw');
    });

    it('does not match same platform', () => {
      recordEngagement('4claw', 'Test Thread', 'Content here', 'thread-1', 'reply');

      // Same content on same platform should not be flagged
      const result = checkDuplicate('4claw', 'Test Thread', 'Content here', 'thread-2');
      assert.strictEqual(result.isDuplicate, false);
    });

    it('detects phrase similarity match', () => {
      // Record discussion about MCP servers
      recordEngagement('4claw', 'Building MCP Servers for Agent Communication', 'This thread discusses how to build model context protocol servers for agent-to-agent communication and knowledge exchange.', 'thread-1', 'reply');

      // Similar topic on chatr with different wording
      const result = checkDuplicate('chatr', 'MCP Server Development Tips', 'Sharing tips on building MCP servers for agent communication and cross-platform knowledge exchange.', 'msg-456');

      // Should detect similarity due to shared phrases like "mcp servers", "agent communication", "knowledge exchange"
      assert.strictEqual(result.isDuplicate, true);
      assert.strictEqual(result.reason, 'phrase_similarity');
      // Threshold is 0.3, actual similarity should exceed that
      assert(result.similarity >= 0.3, `Similarity ${result.similarity} should be >= 0.3 (threshold)`);
    });

    it('does not match unrelated content', () => {
      recordEngagement('4claw', 'Weather discussion today', 'The weather is nice outside and sunny', 'thread-1', 'reply');

      const result = checkDuplicate('chatr', 'Crypto market analysis', 'Bitcoin prices are fluctuating wildly this week', 'msg-789');
      assert.strictEqual(result.isDuplicate, false);
    });
  });

  describe('recordEngagement', () => {
    it('adds entry to cache', () => {
      recordEngagement('4claw', 'Test Thread', 'Content', 'thread-1', 'reply');
      const stats = getCacheStats();
      assert.strictEqual(stats.totalEntries, 1);
      assert.strictEqual(stats.byPlatform['4claw'], 1);
    });

    it('updates existing entry on same platform+threadId', () => {
      recordEngagement('4claw', 'Test Thread', 'Content', 'thread-1', 'reply');
      recordEngagement('4claw', 'Test Thread Updated', 'New Content', 'thread-1', 'comment');

      const stats = getCacheStats();
      assert.strictEqual(stats.totalEntries, 1);
    });

    it('adds separate entries for different threads', () => {
      recordEngagement('4claw', 'Thread 1', 'Content 1', 'thread-1', 'reply');
      recordEngagement('4claw', 'Thread 2', 'Content 2', 'thread-2', 'reply');
      recordEngagement('chatr', 'Message 1', 'Content 3', 'msg-1', 'comment');

      const stats = getCacheStats();
      assert.strictEqual(stats.totalEntries, 3);
      assert.strictEqual(stats.byPlatform['4claw'], 2);
      assert.strictEqual(stats.byPlatform['chatr'], 1);
    });

    it('caps cache at 200 entries', () => {
      for (let i = 0; i < 210; i++) {
        recordEngagement('test', `Thread ${i}`, `Content ${i}`, `thread-${i}`, 'reply');
      }

      const stats = getCacheStats();
      assert.strictEqual(stats.totalEntries, 200);
    });
  });

  describe('getCacheStats', () => {
    it('returns empty stats for empty cache', () => {
      const stats = getCacheStats();
      assert.strictEqual(stats.totalEntries, 0);
      assert.strictEqual(stats.freshEntries, 0);
      assert.deepStrictEqual(stats.byPlatform, {});
    });

    it('counts entries correctly by platform', () => {
      recordEngagement('4claw', 'T1', 'C1', 'id1', 'reply');
      recordEngagement('4claw', 'T2', 'C2', 'id2', 'reply');
      recordEngagement('chatr', 'T3', 'C3', 'id3', 'comment');
      recordEngagement('moltbook', 'T4', 'C4', 'id4', 'post');

      const stats = getCacheStats();
      assert.strictEqual(stats.totalEntries, 4);
      assert.strictEqual(stats.byPlatform['4claw'], 2);
      assert.strictEqual(stats.byPlatform['chatr'], 1);
      assert.strictEqual(stats.byPlatform['moltbook'], 1);
    });
  });

  describe('key phrase extraction', () => {
    it('detects topic overlap across different wordings', () => {
      // Topic: agent memory systems
      recordEngagement('4claw', 'How do agents remember things?', 'Discussion about agent memory persistence and state management across sessions. How do you handle long-term memory in your agent?', 'thread-1', 'reply');

      // Same topic, different phrasing
      const result1 = checkDuplicate('chatr', 'Agent memory and state persistence', 'Talking about how agents persist their state and manage long-term memory across restarts', 'msg-1');

      assert.strictEqual(result1.isDuplicate, true);
      assert(result1.similarity >= 0.3, `Similarity ${result1.similarity} should be >= 0.3`);
    });

    it('does not match topics with different keywords', () => {
      recordEngagement('4claw', 'Deployment strategies for microservices', 'How to deploy containerized microservices in kubernetes clusters', 'thread-1', 'reply');

      const result = checkDuplicate('chatr', 'Machine learning model training', 'Best practices for training neural networks with PyTorch', 'msg-1');

      assert.strictEqual(result.isDuplicate, false);
    });
  });
});

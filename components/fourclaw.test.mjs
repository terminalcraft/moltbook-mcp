#!/usr/bin/env node
// fourclaw.test.mjs — Tests for fourclaw.js component (wq-151)
// Run with: node --test components/fourclaw.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';

const CREDS_PATH = "/home/moltbot/moltbook-mcp/fourclaw-credentials.json";
const BACKUP_PATH = "/home/moltbot/moltbook-mcp/fourclaw-credentials.json.test-backup";

// Mock server that captures tool registrations
function createMockServer() {
  const tools = {};
  return {
    tool: (name, description, schema, handler) => {
      tools[name] = { description, schema, handler };
    },
    getTools: () => tools,
    callTool: async (name, args) => {
      if (!tools[name]) throw new Error(`Tool ${name} not found`);
      return tools[name].handler(args);
    }
  };
}

// Extract text from tool result
function getText(result) {
  return result?.content?.[0]?.text || '';
}

describe('fourclaw.js component', () => {
  let server;
  let originalCreds = null;

  before(async () => {
    // Backup original creds if they exist
    if (existsSync(CREDS_PATH)) {
      originalCreds = readFileSync(CREDS_PATH, 'utf8');
      writeFileSync(BACKUP_PATH, originalCreds);
    }

    // Start with test creds
    writeFileSync(CREDS_PATH, JSON.stringify({ api_key: 'test-api-key' }));

    // Import and register
    const mod = await import('./fourclaw.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    // Restore original creds
    if (originalCreds) {
      writeFileSync(CREDS_PATH, originalCreds);
    }
    if (existsSync(BACKUP_PATH)) {
      unlinkSync(BACKUP_PATH);
    }
    mock.reset();
  });

  test('registers 7 tools', () => {
    const tools = server.getTools();
    assert.ok(tools.fourclaw_boards, 'fourclaw_boards should be registered');
    assert.ok(tools.fourclaw_threads, 'fourclaw_threads should be registered');
    assert.ok(tools.fourclaw_thread, 'fourclaw_thread should be registered');
    assert.ok(tools.fourclaw_post, 'fourclaw_post should be registered');
    assert.ok(tools.fourclaw_reply, 'fourclaw_reply should be registered');
    assert.ok(tools.fourclaw_search, 'fourclaw_search should be registered');
    assert.ok(tools.fourclaw_digest, 'fourclaw_digest should be registered');
    assert.equal(Object.keys(tools).length, 7, 'Should register exactly 7 tools');
  });

  describe('no credentials', () => {
    test('fourclaw_boards returns error when no creds', async () => {
      // Temporarily remove creds
      if (existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);
      const result = await server.callTool('fourclaw_boards', {});
      const text = getText(result);
      assert.match(text, /No 4claw credentials/);
      // Restore creds
      writeFileSync(CREDS_PATH, JSON.stringify({ api_key: 'test-api-key' }));
    });
  });

  describe('fourclaw_boards with mocked fetch', () => {
    test('lists boards successfully', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            boards: [
              { slug: 'singularity', title: 'Singularity', description: 'AI discussions' },
              { slug: 'b', title: 'Random', description: 'Random stuff' }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_boards', {});
        const text = getText(result);
        assert.match(text, /\/singularity\//);
        assert.match(text, /\/b\//);
        assert.match(text, /AI discussions/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles API error', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({ error: 'Unauthorized' })
        };
      };

      try {
        const result = await server.callTool('fourclaw_boards', {});
        const text = getText(result);
        assert.match(text, /Error.*Unauthorized/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles non-JSON response', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          status: 503,
          headers: { get: () => 'text/html' },
          json: async () => { throw new Error('not json'); }
        };
      };

      try {
        const result = await server.callTool('fourclaw_boards', {});
        const text = getText(result);
        assert.match(text, /Error.*503|endpoint.*broken/i);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('fourclaw_threads with mocked fetch', () => {
    test('lists threads successfully', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        assert.match(url, /boards\/singularity\/threads/);
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            threads: [
              { id: 't1', title: 'Test Thread', agent_name: 'testbot', replyCount: 5, content: 'Hello world this is content' },
              { id: 't2', title: 'Another', anon: true, replyCount: 0, content: 'Anonymous post' }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_threads', { board: 'singularity' });
        const text = getText(result);
        assert.match(text, /\/singularity\//);
        assert.match(text, /Test Thread/);
        assert.match(text, /testbot/);
        assert.match(text, /5r/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('passes sort parameter', async () => {
      const originalFetch = global.fetch;
      let capturedUrl;
      global.fetch = async (url) => {
        capturedUrl = url;
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({ threads: [] })
        };
      };

      try {
        await server.callTool('fourclaw_threads', { board: 'b', sort: 'new' });
        assert.match(capturedUrl, /sort=new/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('fourclaw_thread with mocked fetch', () => {
    test('gets thread with replies', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            thread: { id: 't1', title: 'Test', agent_name: 'author', content: 'OP content', replyCount: 2 },
            replies: [
              { agent_name: 'replier1', content: 'First reply' },
              { anon: true, content: 'Anonymous reply' }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_thread', { thread_id: 't1' });
        const text = getText(result);
        assert.match(text, /"Test" by author/);
        assert.match(text, /OP content/);
        assert.match(text, /First reply/);
        assert.match(text, /anon.*Anonymous reply/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('filters spam replies', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            thread: { id: 't1', title: 'Test', content: 'Content' },
            replies: [
              { content: 'Normal reply' },
              { content: '$CLAWIRC 0x1234567890abcdef1234567890abcdef12345678' }, // Spam: 2 patterns
              { content: 'Another normal reply' }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_thread', { thread_id: 't1' });
        const text = getText(result);
        assert.match(text, /Normal reply/);
        assert.match(text, /spam hidden/);
        assert.ok(!text.includes('$CLAWIRC'), 'Spam should be filtered');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('deduplicates near-identical replies', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            thread: { id: 't1', title: 'Test', content: 'Content' },
            replies: [
              { content: 'This is a longer reply that will be checked for duplicates' },
              { content: 'This is a longer reply that will be checked for duplicates' }, // Exact duplicate
              { content: 'This is a longer reply that will be checked for duplicates!' }, // Near duplicate
              { content: 'Unique reply here' },
              { content: 'Another unique response' }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_thread', { thread_id: 't1' });
        const text = getText(result);
        assert.match(text, /duplicates.*hidden/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('fourclaw_post with mocked fetch', () => {
    test('creates thread successfully', async () => {
      const originalFetch = global.fetch;
      let capturedBody;
      global.fetch = async (url, opts) => {
        if (opts?.method === 'POST') {
          capturedBody = JSON.parse(opts.body);
        }
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({ thread: { id: 'new-thread-123' } })
        };
      };

      try {
        const result = await server.callTool('fourclaw_post', {
          board: 'singularity',
          title: 'New Thread',
          content: 'Thread content here',
          anon: false
        });
        const text = getText(result);
        assert.match(text, /Thread created.*new-thread-123/);
        assert.equal(capturedBody.title, 'New Thread');
        assert.equal(capturedBody.content, 'Thread content here');
        assert.equal(capturedBody.anon, false);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('fourclaw_reply with mocked fetch', () => {
    test('posts reply successfully', async () => {
      const originalFetch = global.fetch;
      let capturedBody;
      global.fetch = async (url, opts) => {
        if (opts?.method === 'POST') {
          capturedBody = JSON.parse(opts.body);
        }
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({ reply: { id: 'reply-456' } })
        };
      };

      try {
        const result = await server.callTool('fourclaw_reply', {
          thread_id: 't1',
          content: 'My reply',
          anon: true,
          bump: false
        });
        const text = getText(result);
        assert.match(text, /Reply posted.*t1/);
        assert.equal(capturedBody.content, 'My reply');
        assert.equal(capturedBody.anon, true);
        assert.equal(capturedBody.bump, false);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('defaults bump to true', async () => {
      const originalFetch = global.fetch;
      let capturedBody;
      global.fetch = async (url, opts) => {
        if (opts?.method === 'POST') {
          capturedBody = JSON.parse(opts.body);
        }
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({})
        };
      };

      try {
        await server.callTool('fourclaw_reply', { thread_id: 't1', content: 'Reply' });
        assert.equal(capturedBody.bump, true);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('fourclaw_search with mocked fetch', () => {
    test('returns search results', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        assert.match(url, /search\?q=test/);
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            results: [
              { id: 'r1', title: 'Test Result', content: 'Matching content here' },
              { id: 'r2', title: null, content: 'Reply result' }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_search', { query: 'test' });
        const text = getText(result);
        assert.match(text, /Test Result/);
        assert.match(text, /\(reply\)/); // Null title shows as (reply)
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles no results', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({ results: [] })
        };
      };

      try {
        const result = await server.callTool('fourclaw_search', { query: 'nonexistent' });
        const text = getText(result);
        assert.match(text, /No results/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('fourclaw_digest with mocked fetch', () => {
    test('returns filtered digest', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            threads: [
              { id: 't1', title: 'Good thread?', content: 'Substantive content here that is over 200 chars. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.', replyCount: 10 },
              { id: 't2', title: 'Spam', content: '$CLAWIRC 0x1234567890abcdef1234567890abcdef12345678', replyCount: 0 },
              { id: 't3', title: 'OK thread', content: 'Short', replyCount: 2 }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_digest', { board: 'singularity' });
        const text = getText(result);
        assert.match(text, /singularity.*digest/);
        assert.match(text, /Good thread/);
        assert.match(text, /spam filtered/);
        assert.match(text, /pts\]/); // Score format
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('wide mode shows all with scores', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            threads: [
              { id: 't1', title: 'Thread 1', content: 'Content', replyCount: 5 },
              { id: 't2', title: 'Spammy', content: '$CLAWIRC 0x1234567890abcdef1234567890abcdef12345678', replyCount: 0 }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_digest', { mode: 'wide' });
        const text = getText(result);
        assert.match(text, /\(wide\)/);
        assert.match(text, /\[SPAM\]/); // Spam threads shown but marked
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('detects flood authors', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            threads: [
              { id: 't1', title: 'Post 1', content: 'Content', agent_name: 'spammer', replyCount: 0 },
              { id: 't2', title: 'Post 2', content: 'Content', agent_name: 'spammer', replyCount: 0 },
              { id: 't3', title: 'Post 3', content: 'Content', agent_name: 'spammer', replyCount: 0 },
              { id: 't4', title: 'Post 4', content: 'Content', agent_name: 'spammer', replyCount: 0 },
              { id: 't5', title: 'Normal', content: 'Content', agent_name: 'normal_user', replyCount: 5 }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_digest', {});
        const text = getText(result);
        assert.match(text, /flood author/i);
        assert.match(text, /spammer/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('defaults to singularity board', async () => {
      const originalFetch = global.fetch;
      let capturedUrl;
      global.fetch = async (url) => {
        capturedUrl = url;
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({ threads: [] })
        };
      };

      try {
        await server.callTool('fourclaw_digest', {});
        assert.match(capturedUrl, /boards\/singularity/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('spam detection', () => {
    test('detects ETH addresses and filters spam', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            threads: [
              { id: 't1', title: 'Send to 0x1234567890abcdef1234567890abcdef12345678 now!', content: '$CLAWIRC', replyCount: 0 },
              { id: 't2', title: 'Normal thread', content: 'This is a legitimate post', replyCount: 3 }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_digest', { mode: 'signal' });
        const text = getText(result);
        // Normal thread should appear, spam should be filtered
        assert.match(text, /Normal thread/);
        assert.match(text, /1 spam filtered/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('requires 2+ patterns for spam classification', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            threads: [
              { id: 't1', title: 'Normal post mentioning protocol', content: 'Just talking about protocol design', replyCount: 5 }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_digest', { mode: 'signal' });
        const text = getText(result);
        // Should NOT be filtered (only 1 pattern match)
        assert.match(text, /Normal post/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('thread scoring', () => {
    test('questions score higher', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            threads: [
              { id: 't1', title: 'Statement', content: 'Content', replyCount: 0 },
              { id: 't2', title: 'Question?', content: 'Content', replyCount: 0 }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_digest', {});
        const text = getText(result);
        // Question should appear first (higher score)
        const qPos = text.indexOf('Question?');
        const sPos = text.indexOf('Statement');
        assert.ok(qPos < sPos, 'Question should rank higher than statement');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('replies boost score', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          headers: { get: () => 'application/json' },
          json: async () => ({
            threads: [
              { id: 't1', title: 'Low engagement', content: 'Content', replyCount: 0 },
              { id: 't2', title: 'Popular', content: 'Content', replyCount: 15 }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('fourclaw_digest', {});
        const text = getText(result);
        const popPos = text.indexOf('Popular');
        const lowPos = text.indexOf('Low engagement');
        assert.ok(popPos < lowPos, 'Popular thread should rank higher');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});

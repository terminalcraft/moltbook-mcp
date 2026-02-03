#!/usr/bin/env node
// colony.test.mjs — Tests for colony.js component (wq-154)
// Run with: node --test components/colony.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'fs';

const KEY_PATH = "/home/moltbot/.colony-key";
const BACKUP_PATH = "/home/moltbot/.colony-key.test-backup";

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

describe('colony.js component', () => {
  let server;
  let originalKey = null;

  before(async () => {
    // Backup original key if it exists
    if (existsSync(KEY_PATH)) {
      originalKey = readFileSync(KEY_PATH, 'utf8');
      writeFileSync(BACKUP_PATH, originalKey);
    }

    // Start with test key
    writeFileSync(KEY_PATH, 'test-api-key');

    // Import and register
    const mod = await import('./colony.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    // Restore original key
    if (originalKey) {
      writeFileSync(KEY_PATH, originalKey);
    }
    if (existsSync(BACKUP_PATH)) {
      unlinkSync(BACKUP_PATH);
    }
    mock.reset();
  });

  test('registers 5 tools', () => {
    const tools = server.getTools();
    assert.ok(tools.colony_feed, 'colony_feed should be registered');
    assert.ok(tools.colony_post_read, 'colony_post_read should be registered');
    assert.ok(tools.colony_post_create, 'colony_post_create should be registered');
    assert.ok(tools.colony_comment, 'colony_comment should be registered');
    assert.ok(tools.colony_status, 'colony_status should be registered');
    assert.equal(Object.keys(tools).length, 5, 'Should register exactly 5 tools');
  });

  describe('colony_feed with mocked fetch', () => {
    test('lists posts successfully', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        // Auth endpoint
        if (url.includes('/auth/token')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' })
          };
        }
        // Posts endpoint
        return {
          ok: true,
          json: async () => ({
            posts: [
              { id: 'p1', title: 'Test Post', author: { username: 'testuser' }, score: 5, comment_count: 3, post_type: 'discussion', created_at: '2026-01-01T12:00:00Z' },
              { id: 'p2', title: 'Another Post', username: 'agent2', score: 2, comment_count: 0, post_type: 'finding', created_at: '2026-01-02T12:00:00Z' }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('colony_feed', { limit: 15, sort: 'new' });
        const text = getText(result);
        assert.match(text, /Colony feed/);
        assert.match(text, /Test Post/);
        assert.match(text, /testuser/);
        assert.match(text, /5↑/);
        assert.match(text, /3💬/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles API error', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        return { ok: false, status: 500 };
      };

      try {
        const result = await server.callTool('colony_feed', {});
        const text = getText(result);
        assert.match(text, /Colony API error: 500/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles empty results', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        return { ok: true, json: async () => ({ posts: [] }) };
      };

      try {
        const result = await server.callTool('colony_feed', {});
        const text = getText(result);
        assert.match(text, /No posts found/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('passes colony filter', async () => {
      const originalFetch = global.fetch;
      let capturedUrl;
      global.fetch = async (url) => {
        capturedUrl = url;
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        return { ok: true, json: async () => ({ posts: [] }) };
      };

      try {
        await server.callTool('colony_feed', { colony: 'findings' });
        assert.match(capturedUrl, /colony=findings/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('colony_post_read with mocked fetch', () => {
    test('reads post with comments', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        return {
          ok: true,
          json: async () => ({
            id: 'p1',
            title: 'Test Post',
            author: { username: 'author1' },
            post_type: 'discussion',
            score: 10,
            comment_count: 2,
            body: 'This is the post body.',
            comments: [
              { author: { username: 'commenter1' }, body: 'First comment' },
              { author: { username: 'commenter2' }, content: 'Second comment' }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('colony_post_read', { post_id: 'p1' });
        const text = getText(result);
        assert.match(text, /# Test Post/);
        assert.match(text, /by author1/);
        assert.match(text, /This is the post body/);
        assert.match(text, /commenter1.*First comment/);
        assert.match(text, /commenter2.*Second comment/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles post not found', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        return { ok: false, status: 404 };
      };

      try {
        const result = await server.callTool('colony_post_read', { post_id: 'invalid' });
        const text = getText(result);
        assert.match(text, /Colony API error: 404/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('colony_post_create with mocked fetch', () => {
    test('creates post successfully', async () => {
      const originalFetch = global.fetch;
      let capturedBody;
      global.fetch = async (url, opts) => {
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        if (opts?.method === 'POST') {
          capturedBody = JSON.parse(opts.body);
        }
        return { ok: true, json: async () => ({ id: 'new-post-123' }) };
      };

      try {
        const result = await server.callTool('colony_post_create', {
          content: 'Post body here',
          title: 'New Post',
          post_type: 'finding'
        });
        const text = getText(result);
        assert.match(text, /Posted.*new-post-123/);
        assert.equal(capturedBody.body, 'Post body here');
        assert.equal(capturedBody.title, 'New Post');
        assert.equal(capturedBody.post_type, 'finding');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles post failure', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        // Post request fails
        return { ok: false, status: 400, json: async () => ({ error: 'Bad request' }) };
      };

      try {
        const result = await server.callTool('colony_post_create', { content: 'Test' });
        const text = getText(result);
        assert.match(text, /Colony post failed.*400/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles expired token', async () => {
      const originalFetch = global.fetch;
      let authCalls = 0;
      global.fetch = async (url, opts) => {
        if (url.includes('/auth/token')) {
          authCalls++;
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        if (opts?.method === 'POST') {
          return { ok: false, status: 401 };
        }
        return { ok: false };
      };

      try {
        const result = await server.callTool('colony_post_create', { content: 'Test' });
        const text = getText(result);
        assert.match(text, /auth expired/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('defaults to general colony', async () => {
      const originalFetch = global.fetch;
      let capturedBody;
      global.fetch = async (url, opts) => {
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        if (opts?.method === 'POST') {
          capturedBody = JSON.parse(opts.body);
        }
        return { ok: true, json: async () => ({ id: 'post-1' }) };
      };

      try {
        await server.callTool('colony_post_create', { content: 'Test' });
        assert.equal(capturedBody.colony_id, '2e549d01-99f2-459f-8924-48b2690b2170');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('colony_comment with mocked fetch', () => {
    test('posts comment successfully', async () => {
      const originalFetch = global.fetch;
      let capturedBody;
      let capturedUrl;
      global.fetch = async (url, opts) => {
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        if (opts?.method === 'POST') {
          capturedUrl = url;
          capturedBody = JSON.parse(opts.body);
        }
        return { ok: true, json: async () => ({ id: 'comment-456' }) };
      };

      try {
        const result = await server.callTool('colony_comment', {
          post_id: 'p1',
          content: 'My comment'
        });
        const text = getText(result);
        assert.match(text, /Comment posted.*comment-456/);
        assert.match(capturedUrl, /posts\/p1\/comments/);
        assert.equal(capturedBody.body, 'My comment');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles comment failure', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        // Comment request fails
        return { ok: false, status: 404, json: async () => ({ error: 'Post not found' }) };
      };

      try {
        const result = await server.callTool('colony_comment', { post_id: 'p1', content: 'Test' });
        const text = getText(result);
        assert.match(text, /Comment failed.*404/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('colony_status with mocked fetch', () => {
    test('returns auth status and colonies', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        if (url.includes('/colonies')) {
          return {
            ok: true,
            json: async () => [
              { name: 'general', member_count: 100, id: 'colony-1' },
              { name: 'findings', member_count: 50, id: 'colony-2' }
            ]
          };
        }
        return { ok: false };
      };

      try {
        const result = await server.callTool('colony_status', {});
        const text = getText(result);
        assert.match(text, /Token TTL/);
        assert.match(text, /general.*100 members/);
        assert.match(text, /findings.*50 members/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles colonies API failure', async () => {
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        if (url.includes('/auth/token')) {
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        // Colonies endpoint fails
        return { ok: false, status: 503, json: async () => ({}) };
      };

      try {
        const result = await server.callTool('colony_status', {});
        const text = getText(result);
        assert.match(text, /Colony API error: 503/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('JWT handling', () => {
    test('caches JWT and reuses it', async () => {
      const originalFetch = global.fetch;
      let authCalls = 0;
      global.fetch = async (url) => {
        if (url.includes('/auth/token')) {
          authCalls++;
          return { ok: true, json: async () => ({ access_token: 'test.eyJleHAiOjk5OTk5OTk5OTl9.sig' }) };
        }
        return { ok: true, json: async () => ({ posts: [] }) };
      };

      try {
        // First call should fetch JWT
        await server.callTool('colony_feed', {});
        const firstCalls = authCalls;

        // Second call should reuse cached JWT
        await server.callTool('colony_feed', {});
        assert.equal(authCalls, firstCalls, 'Should reuse cached JWT');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('error handling', () => {
    test('handles network error', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        throw new Error('Network error');
      };

      try {
        const result = await server.callTool('colony_feed', {});
        const text = getText(result);
        assert.match(text, /Colony error.*Network error/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles timeout', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => {
        throw new Error('The operation was aborted');
      };

      try {
        const result = await server.callTool('colony_feed', {});
        const text = getText(result);
        assert.match(text, /Colony error.*aborted/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});

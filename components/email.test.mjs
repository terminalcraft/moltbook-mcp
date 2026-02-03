#!/usr/bin/env node
// email.test.mjs — Tests for email.js component (wq-150)
// Run with: node --test components/email.test.mjs

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';

const CREDS_PATH = "/home/moltbot/.agentmail-creds.json";
const BACKUP_PATH = "/home/moltbot/.agentmail-creds.json.test-backup";

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

describe('email.js component', () => {
  let server;
  let originalCreds = null;
  let fetchMock;

  before(async () => {
    // Backup original creds if they exist
    if (existsSync(CREDS_PATH)) {
      originalCreds = readFileSync(CREDS_PATH, 'utf8');
      writeFileSync(BACKUP_PATH, originalCreds);
    }

    // Start with no creds
    if (existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);

    // Import and register
    const mod = await import('./email.js');
    server = createMockServer();
    mod.register(server);
  });

  after(() => {
    // Restore original creds
    if (originalCreds) {
      writeFileSync(CREDS_PATH, originalCreds);
    } else if (existsSync(CREDS_PATH)) {
      unlinkSync(CREDS_PATH);
    }
    if (existsSync(BACKUP_PATH)) {
      unlinkSync(BACKUP_PATH);
    }
    mock.reset();
  });

  test('registers 7 tools', () => {
    const tools = server.getTools();
    assert.ok(tools.email_status, 'email_status should be registered');
    assert.ok(tools.email_setup, 'email_setup should be registered');
    assert.ok(tools.email_create_inbox, 'email_create_inbox should be registered');
    assert.ok(tools.email_list, 'email_list should be registered');
    assert.ok(tools.email_read, 'email_read should be registered');
    assert.ok(tools.email_send, 'email_send should be registered');
    assert.ok(tools.email_reply, 'email_reply should be registered');
    assert.equal(Object.keys(tools).length, 7, 'Should register exactly 7 tools');
  });

  describe('email_status', () => {
    test('shows not configured when no creds', async () => {
      if (existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);
      const result = await server.callTool('email_status', {});
      const text = getText(result);
      assert.match(text, /not configured/i);
      assert.match(text, /email_setup/);
    });

    test('shows configured with api key', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({
        api_key: 'test-key-12345678',
        inbox_id: 'inbox-123',
        email_address: 'test@agentmail.to'
      }));
      const result = await server.callTool('email_status', {});
      const text = getText(result);
      assert.match(text, /AgentMail Status/);
      assert.match(text, /test-key/);  // Key prefix shown with ... suffix
      assert.match(text, /inbox-123/);
      assert.match(text, /test@agentmail.to/);
    });

    test('shows inbox not created when no inbox_id', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({
        api_key: 'test-key-12345678'
      }));
      const result = await server.callTool('email_status', {});
      const text = getText(result);
      assert.match(text, /not created yet/);
    });
  });

  describe('email_list', () => {
    test('returns error when no inbox configured', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({ api_key: 'test-key' }));
      const result = await server.callTool('email_list', {});
      const text = getText(result);
      assert.match(text, /No inbox configured/);
    });
  });

  describe('email_read', () => {
    test('returns error when no inbox configured', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({ api_key: 'test-key' }));
      const result = await server.callTool('email_read', { message_id: 'msg-123' });
      const text = getText(result);
      assert.match(text, /No inbox configured/);
    });
  });

  describe('email_send', () => {
    test('returns error when no inbox configured', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({ api_key: 'test-key' }));
      const result = await server.callTool('email_send', {
        to: 'test@example.com',
        subject: 'Test',
        text: 'Hello'
      });
      const text = getText(result);
      assert.match(text, /No inbox configured/);
    });
  });

  describe('email_reply', () => {
    test('returns error when no inbox configured', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({ api_key: 'test-key' }));
      const result = await server.callTool('email_reply', {
        message_id: 'msg-123',
        text: 'Reply text'
      });
      const text = getText(result);
      assert.match(text, /No inbox configured/);
    });
  });

  describe('email_setup with mocked fetch', () => {
    test('validates API key and finds existing inbox', async () => {
      // Clear creds first
      if (existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);

      // Mock global fetch
      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        if (url.includes('/inboxes') && !url.includes('/messages')) {
          return {
            ok: true,
            text: async () => JSON.stringify({
              inboxes: [{ id: 'inbox-abc', username: 'testuser', email: 'testuser@agentmail.to' }]
            })
          };
        }
        return { ok: false, text: async () => 'Not found' };
      };

      try {
        const result = await server.callTool('email_setup', { api_key: 'valid-test-key' });
        const text = getText(result);
        assert.match(text, /validated/i);
        assert.match(text, /inbox-abc/);

        // Check creds were saved
        const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
        assert.equal(creds.api_key, 'valid-test-key');
        assert.equal(creds.inbox_id, 'inbox-abc');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles invalid API key', async () => {
      if (existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);

      const originalFetch = global.fetch;
      global.fetch = async () => {
        return { ok: false, status: 401, text: async () => 'Unauthorized' };
      };

      try {
        const result = await server.callTool('email_setup', { api_key: 'invalid-key' });
        const text = getText(result);
        assert.match(text, /validation failed/i);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles no existing inboxes', async () => {
      if (existsSync(CREDS_PATH)) unlinkSync(CREDS_PATH);

      const originalFetch = global.fetch;
      global.fetch = async () => {
        return { ok: true, text: async () => JSON.stringify({ inboxes: [] }) };
      };

      try {
        const result = await server.callTool('email_setup', { api_key: 'valid-key' });
        const text = getText(result);
        assert.match(text, /validated/i);
        assert.match(text, /email_create_inbox/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('email_create_inbox with mocked fetch', () => {
    test('creates inbox successfully', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({ api_key: 'test-key' }));

      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        if (opts?.method === 'POST' && url.includes('/inboxes')) {
          return {
            ok: true,
            text: async () => JSON.stringify({ id: 'new-inbox-123', email: 'newuser@agentmail.to' })
          };
        }
        return { ok: false, text: async () => 'Not found' };
      };

      try {
        const result = await server.callTool('email_create_inbox', { username: 'newuser' });
        const text = getText(result);
        assert.match(text, /Inbox created/);
        assert.match(text, /new-inbox-123/);

        // Check creds were updated
        const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
        assert.equal(creds.inbox_id, 'new-inbox-123');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('email_list with mocked fetch', () => {
    test('lists emails successfully', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({
        api_key: 'test-key',
        inbox_id: 'inbox-123',
        email_address: 'test@agentmail.to'
      }));

      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          ok: true,
          text: async () => JSON.stringify({
            messages: [
              { id: 'msg-1', subject: 'Hello', from: { email: 'sender@example.com' }, created_at: '2024-01-01T00:00:00Z' },
              { id: 'msg-2', subject: 'Test', from: 'other@example.com', created_at: '2024-01-02T00:00:00Z' }
            ]
          })
        };
      };

      try {
        const result = await server.callTool('email_list', { limit: 10 });
        const text = getText(result);
        assert.match(text, /2 email\(s\)/);
        assert.match(text, /Hello/);
        assert.match(text, /sender@example.com/);
        assert.match(text, /msg-1/);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('shows empty inbox message', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({
        api_key: 'test-key',
        inbox_id: 'inbox-123',
        email_address: 'test@agentmail.to'
      }));

      const originalFetch = global.fetch;
      global.fetch = async () => {
        return { ok: true, text: async () => JSON.stringify({ messages: [] }) };
      };

      try {
        const result = await server.callTool('email_list', {});
        const text = getText(result);
        assert.match(text, /No emails/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('email_read with mocked fetch', () => {
    test('reads email successfully', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({
        api_key: 'test-key',
        inbox_id: 'inbox-123',
        email_address: 'test@agentmail.to'
      }));

      const originalFetch = global.fetch;
      global.fetch = async () => {
        return {
          ok: true,
          text: async () => JSON.stringify({
            id: 'msg-1',
            subject: 'Test Subject',
            from: { email: 'sender@example.com' },
            to: [{ email: 'test@agentmail.to' }],
            created_at: '2024-01-01T00:00:00Z',
            text: 'This is the email body.',
            attachments: [{ filename: 'doc.pdf', content_type: 'application/pdf' }]
          })
        };
      };

      try {
        const result = await server.callTool('email_read', { message_id: 'msg-1' });
        const text = getText(result);
        assert.match(text, /Test Subject/);
        assert.match(text, /sender@example.com/);
        assert.match(text, /This is the email body/);
        assert.match(text, /doc\.pdf/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('email_send with mocked fetch', () => {
    test('sends email successfully', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({
        api_key: 'test-key',
        inbox_id: 'inbox-123',
        email_address: 'test@agentmail.to'
      }));

      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        if (opts?.method === 'POST' && url.includes('/send')) {
          return {
            ok: true,
            text: async () => JSON.stringify({ id: 'sent-msg-123' })
          };
        }
        return { ok: false, text: async () => 'Not found' };
      };

      try {
        const result = await server.callTool('email_send', {
          to: 'recipient@example.com',
          subject: 'Test Subject',
          text: 'Hello World'
        });
        const text = getText(result);
        assert.match(text, /Email sent/);
        assert.match(text, /recipient@example.com/);
        assert.match(text, /sent-msg-123/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('email_reply with mocked fetch', () => {
    test('sends reply successfully', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({
        api_key: 'test-key',
        inbox_id: 'inbox-123',
        email_address: 'test@agentmail.to'
      }));

      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        if (opts?.method === 'POST' && url.includes('/reply')) {
          return {
            ok: true,
            text: async () => JSON.stringify({ id: 'reply-msg-456' })
          };
        }
        return { ok: false, text: async () => 'Not found' };
      };

      try {
        const result = await server.callTool('email_reply', {
          message_id: 'original-msg-123',
          text: 'This is my reply'
        });
        const text = getText(result);
        assert.match(text, /Reply sent/);
        assert.match(text, /original-msg-123/);
        assert.match(text, /reply-msg-456/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('error handling', () => {
    test('handles timeout errors', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({
        api_key: 'test-key',
        inbox_id: 'inbox-123',
        email_address: 'test@agentmail.to'
      }));

      const originalFetch = global.fetch;
      global.fetch = async (url, opts) => {
        // Simulate abort
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
      };

      try {
        const result = await server.callTool('email_list', {});
        const text = getText(result);
        assert.match(text, /timeout/i);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('handles HTTP errors', async () => {
      writeFileSync(CREDS_PATH, JSON.stringify({
        api_key: 'test-key',
        inbox_id: 'inbox-123',
        email_address: 'test@agentmail.to'
      }));

      const originalFetch = global.fetch;
      global.fetch = async () => {
        return { ok: false, status: 500, text: async () => 'Internal Server Error' };
      };

      try {
        const result = await server.callTool('email_list', {});
        const text = getText(result);
        assert.match(text, /Failed/);
        assert.match(text, /500/);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});

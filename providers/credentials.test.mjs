// Tests for providers/credentials.js — auth credential loading (wq-771, d071)
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_HOME = '/tmp/cred-test-' + Date.now();
const MCP_DIR = join(TEST_HOME, 'moltbook-mcp');

// Set HOME before import
process.env.HOME = TEST_HOME;
mkdirSync(MCP_DIR, { recursive: true });

// Clear any env vars that could interfere
delete process.env.CTXLY_API_KEY;
delete process.env.MOLTBOTDEN_API_KEY;

const {
  getCtxlyKey, getChatrCredentials, CHATR_API,
  getFourclawCredentials, FOURCLAW_API,
  getLobchanKey, LOBCHAN_API,
  getMoltbotdenKey, MOLTBOTDEN_API,
  getMoltchanKey, MOLTCHAN_API
} = await import('./credentials.js');

describe('providers/credentials.js', () => {
  afterEach(() => {
    // Clean up env vars
    delete process.env.CTXLY_API_KEY;
    delete process.env.MOLTBOTDEN_API_KEY;
  });

  describe('API constants', () => {
    it('exports correct CHATR_API', () => {
      assert.strictEqual(CHATR_API, 'https://chatr.ai/api');
    });

    it('exports correct FOURCLAW_API', () => {
      assert.strictEqual(FOURCLAW_API, 'https://www.4claw.org/api/v1');
    });

    it('exports correct LOBCHAN_API', () => {
      assert.strictEqual(LOBCHAN_API, 'https://lobchan.ai/api');
    });

    it('exports correct MOLTBOTDEN_API', () => {
      assert.strictEqual(MOLTBOTDEN_API, 'https://api.moltbotden.com');
    });

    it('exports correct MOLTCHAN_API', () => {
      assert.strictEqual(MOLTCHAN_API, 'https://www.moltchan.org/api/v1');
    });
  });

  describe('getCtxlyKey', () => {
    it('returns env var when CTXLY_API_KEY is set', () => {
      process.env.CTXLY_API_KEY = 'test-key-123';
      assert.strictEqual(getCtxlyKey(), 'test-key-123');
    });

    it('reads from ctxly.json when env var not set', () => {
      delete process.env.CTXLY_API_KEY;
      writeFileSync(join(MCP_DIR, 'ctxly.json'), JSON.stringify({ api_key: 'file-key-456' }));
      assert.strictEqual(getCtxlyKey(), 'file-key-456');
    });

    it('returns null when neither env nor file exists', () => {
      delete process.env.CTXLY_API_KEY;
      try { rmSync(join(MCP_DIR, 'ctxly.json')); } catch {}
      assert.strictEqual(getCtxlyKey(), null);
    });

    it('returns null on malformed JSON', () => {
      delete process.env.CTXLY_API_KEY;
      writeFileSync(join(MCP_DIR, 'ctxly.json'), 'not-json');
      assert.strictEqual(getCtxlyKey(), null);
    });
  });

  describe('getChatrCredentials', () => {
    it('reads credentials from file', () => {
      const creds = { agent_id: 'bot-1', token: 'tok-abc' };
      writeFileSync(join(MCP_DIR, 'chatr-credentials.json'), JSON.stringify(creds));
      const result = getChatrCredentials();
      assert.deepStrictEqual(result, creds);
    });

    it('returns null when file missing', () => {
      try { rmSync(join(MCP_DIR, 'chatr-credentials.json')); } catch {}
      assert.strictEqual(getChatrCredentials(), null);
    });

    it('returns null on malformed JSON', () => {
      writeFileSync(join(MCP_DIR, 'chatr-credentials.json'), '{broken');
      assert.strictEqual(getChatrCredentials(), null);
    });
  });

  describe('getFourclawCredentials', () => {
    it('reads credentials from file', () => {
      const creds = { username: 'bot', password: 'pass' };
      writeFileSync(join(MCP_DIR, 'fourclaw-credentials.json'), JSON.stringify(creds));
      const result = getFourclawCredentials();
      assert.deepStrictEqual(result, creds);
    });

    it('returns null when file missing', () => {
      try { rmSync(join(MCP_DIR, 'fourclaw-credentials.json')); } catch {}
      assert.strictEqual(getFourclawCredentials(), null);
    });
  });

  describe('getLobchanKey', () => {
    it('reads key from .lobchan-key file', () => {
      writeFileSync(join(MCP_DIR, '.lobchan-key'), 'lobkey-789\n');
      assert.strictEqual(getLobchanKey(), 'lobkey-789');
    });

    it('trims whitespace', () => {
      writeFileSync(join(MCP_DIR, '.lobchan-key'), '  key-with-spaces  \n');
      assert.strictEqual(getLobchanKey(), 'key-with-spaces');
    });

    it('returns null when file missing', () => {
      try { rmSync(join(MCP_DIR, '.lobchan-key')); } catch {}
      assert.strictEqual(getLobchanKey(), null);
    });
  });

  describe('getMoltbotdenKey', () => {
    it('returns env var when MOLTBOTDEN_API_KEY is set', () => {
      process.env.MOLTBOTDEN_API_KEY = 'env-mbd-key';
      assert.strictEqual(getMoltbotdenKey(), 'env-mbd-key');
    });

    it('reads from .moltbotden-key file when env not set', () => {
      delete process.env.MOLTBOTDEN_API_KEY;
      writeFileSync(join(MCP_DIR, '.moltbotden-key'), 'file-mbd-key\n');
      assert.strictEqual(getMoltbotdenKey(), 'file-mbd-key');
    });

    it('returns null when neither env nor file exists', () => {
      delete process.env.MOLTBOTDEN_API_KEY;
      try { rmSync(join(MCP_DIR, '.moltbotden-key')); } catch {}
      assert.strictEqual(getMoltbotdenKey(), null);
    });
  });

  describe('getMoltchanKey', () => {
    it('reads key from .moltchan-key file', () => {
      writeFileSync(join(MCP_DIR, '.moltchan-key'), 'mc-key-abc\n');
      assert.strictEqual(getMoltchanKey(), 'mc-key-abc');
    });

    it('returns null when file missing', () => {
      try { rmSync(join(MCP_DIR, '.moltchan-key')); } catch {}
      assert.strictEqual(getMoltchanKey(), null);
    });
  });
});

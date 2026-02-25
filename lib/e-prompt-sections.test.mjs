/**
 * Tests for lib/e-prompt-sections.mjs (wq-650)
 * Uses dependency injection (deps param) to mock execSync/fs calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEPromptBlock } from './e-prompt-sections.mjs';

// Default mock deps — orchestrator succeeds, no email, no covenants
function makeDeps(overrides = {}) {
  return {
    execSync: overrides.execSync || ((cmd) => {
      if (cmd === 'node engage-orchestrator.mjs') {
        return 'Platform picker output with enough content to pass length check';
      }
      if (cmd === 'node covenant-tracker.mjs digest') {
        return 'No covenants';
      }
      return '';
    }),
    existsSync: overrides.existsSync || (() => false),
    readFileSync: overrides.readFileSync || (() => ''),
  };
}

// Helper: build a minimal ctx object
function makeCtx(overrides = {}) {
  return {
    fc: {
      text: () => null,
      json: () => null,
      ...overrides.fc,
    },
    PATHS: {
      eCounter: '/tmp/e-counter.txt',
      eContext: '/tmp/e-context.txt',
      ...overrides.PATHS,
    },
    MODE: overrides.MODE || 'E',
    result: overrides.result || {},
    DIR: overrides.DIR || '/home/moltbot/moltbook-mcp',
  };
}

// --- Counter tests ---

describe('E counter', () => {
  it('increments counter in E mode', () => {
    const ctx = makeCtx({
      fc: { text: (p) => p.includes('counter') ? '5' : null },
    });
    const block = buildEPromptBlock(ctx, makeDeps());
    assert.match(block, /## E Session: #6/);
    assert.match(block, /engagement session #6/);
  });

  it('uses raw counter in non-E mode (no increment)', () => {
    const ctx = makeCtx({
      fc: { text: (p) => p.includes('counter') ? '10' : null },
      MODE: 'B',
    });
    const block = buildEPromptBlock(ctx, makeDeps());
    assert.match(block, /#10/);
  });

  it('defaults to 1 when counter file missing (E mode)', () => {
    const ctx = makeCtx({ fc: { text: () => null }, MODE: 'E' });
    const block = buildEPromptBlock(ctx, makeDeps());
    assert.match(block, /#1/);
  });

  it('defaults to ? when counter file missing (non-E mode)', () => {
    const ctx = makeCtx({ fc: { text: () => null }, MODE: 'B' });
    const block = buildEPromptBlock(ctx, makeDeps());
    assert.match(block, /#\?/);
  });

  it('handles non-numeric counter gracefully (E mode)', () => {
    const ctx = makeCtx({
      fc: { text: () => 'garbage' },
      MODE: 'E',
    });
    const block = buildEPromptBlock(ctx, makeDeps());
    assert.match(block, /#1/);
  });
});

// --- Orchestrator tests ---

describe('Orchestrator section', () => {
  it('includes orchestrator output when successful', () => {
    const block = buildEPromptBlock(makeCtx(), makeDeps());
    assert.match(block, /Orchestrator output/);
    assert.match(block, /Platform picker output/);
    assert.match(block, /ROI order/);
  });

  it('includes error message on orchestrator failure', () => {
    const deps = makeDeps({
      execSync: (cmd) => {
        if (cmd === 'node engage-orchestrator.mjs') throw new Error('orchestrator crashed');
        if (cmd === 'node covenant-tracker.mjs digest') return 'No covenants';
        return '';
      },
    });
    const block = buildEPromptBlock(makeCtx(), deps);
    assert.match(block, /Orchestrator failed/);
    assert.match(block, /orchestrator crashed/);
  });

  it('skips orchestrator output if too short', () => {
    const deps = makeDeps({
      execSync: (cmd) => {
        if (cmd === 'node engage-orchestrator.mjs') return 'short';
        if (cmd === 'node covenant-tracker.mjs digest') return 'No covenants';
        return '';
      },
    });
    const ctx = makeCtx();
    const block = buildEPromptBlock(ctx, deps);
    assert.doesNotMatch(block, /Orchestrator output/);
    assert.equal(ctx.result.e_orchestrator_output, undefined);
  });

  it('sets e_orchestrator_output on result object', () => {
    const ctx = makeCtx();
    buildEPromptBlock(ctx, makeDeps());
    assert.equal(ctx.result.e_orchestrator_output, 'Platform picker output with enough content to pass length check');
  });

  it('sets e_orchestrator_error on result object when orchestrator fails', () => {
    const deps = makeDeps({
      execSync: (cmd) => {
        if (cmd === 'node engage-orchestrator.mjs') throw new Error('boom');
        if (cmd === 'node covenant-tracker.mjs digest') return 'No covenants';
        return '';
      },
    });
    const ctx = makeCtx();
    buildEPromptBlock(ctx, deps);
    assert.equal(ctx.result.e_orchestrator_error, 'boom');
  });

  it('truncates long error messages to 200 chars', () => {
    const deps = makeDeps({
      execSync: (cmd) => {
        if (cmd === 'node engage-orchestrator.mjs') throw new Error('x'.repeat(300));
        if (cmd === 'node covenant-tracker.mjs digest') return 'No covenants';
        return '';
      },
    });
    const ctx = makeCtx();
    buildEPromptBlock(ctx, deps);
    assert.equal(ctx.result.e_orchestrator_error.length, 200);
  });
});

// --- Previous engagement context ---

describe('Previous engagement context', () => {
  it('includes context when available', () => {
    const ctx = makeCtx({
      fc: {
        text: (p) => {
          if (p.includes('Context') || p.includes('context')) return 'Last session engaged Chatr and 4claw';
          if (p.includes('counter') || p.includes('Counter')) return '3';
          return null;
        },
      },
    });
    const block = buildEPromptBlock(ctx, makeDeps());
    assert.match(block, /Previous engagement context/);
    assert.match(block, /Last session engaged Chatr/);
  });

  it('omits context when empty', () => {
    const block = buildEPromptBlock(makeCtx(), makeDeps());
    assert.doesNotMatch(block, /Previous engagement context/);
  });
});

// --- Eval target ---

describe('Eval target block', () => {
  it('includes eval target when present', () => {
    const ctx = makeCtx({
      result: { eval_target: 'ServiceX — agent marketplace at example.com' },
    });
    const block = buildEPromptBlock(ctx, makeDeps());
    assert.match(block, /DEEP-DIVE TARGET/);
    assert.match(block, /ServiceX/);
  });

  it('omits eval target when absent', () => {
    const block = buildEPromptBlock(makeCtx(), makeDeps());
    assert.doesNotMatch(block, /DEEP-DIVE TARGET/);
  });
});

// --- Email block ---

describe('Email block', () => {
  function emailDeps(inboxResponse) {
    return makeDeps({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({
        api_key: 'test-key',
        inbox_id: 'inbox-123',
        email_address: 'bot@test.com',
      }),
      execSync: (cmd) => {
        if (cmd === 'node engage-orchestrator.mjs') {
          return 'Platform picker output with enough content to pass length check';
        }
        if (cmd === 'node covenant-tracker.mjs digest') return 'No covenants';
        if (typeof cmd === 'string' && cmd.includes('agentmail')) {
          return JSON.stringify(inboxResponse);
        }
        return '';
      },
    });
  }

  it('shows messages when inbox has mail', () => {
    const deps = emailDeps({
      count: 2,
      messages: [
        { from: { email: 'alice@test.com' }, subject: 'Hello agent' },
        { from: { email: 'bob@test.com' }, subject: 'Collaboration' },
      ],
    });
    const ctx = makeCtx();
    const block = buildEPromptBlock(ctx, deps);
    assert.match(block, /Email \(2 messages/);
    assert.match(block, /Hello agent/);
    assert.match(block, /alice@test\.com/);
    assert.equal(ctx.result.email_configured, true);
    assert.equal(ctx.result.email_count, 2);
  });

  it('shows empty inbox message', () => {
    const deps = emailDeps({ count: 0, messages: [] });
    const block = buildEPromptBlock(makeCtx(), deps);
    assert.match(block, /Email: 0 messages in bot@test\.com/);
  });

  it('handles email check failure', () => {
    const deps = makeDeps({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ api_key: 'k', inbox_id: 'i' }),
      execSync: (cmd) => {
        if (cmd === 'node engage-orchestrator.mjs') {
          return 'Platform picker output with enough content to pass length check';
        }
        if (cmd === 'node covenant-tracker.mjs digest') return 'No covenants';
        if (typeof cmd === 'string' && cmd.includes('agentmail')) {
          throw new Error('network timeout');
        }
        return '';
      },
    });
    const ctx = makeCtx();
    const block = buildEPromptBlock(ctx, deps);
    assert.match(block, /Email: configured but check failed/);
    assert.ok(ctx.result.email_error);
  });

  it('skips email when no creds file', () => {
    const block = buildEPromptBlock(makeCtx(), makeDeps());
    assert.doesNotMatch(block, /Email/);
  });
});

// --- Covenant block ---

describe('Covenant block', () => {
  it('includes covenant block when covenants exist', () => {
    const deps = makeDeps({
      execSync: (cmd) => {
        if (cmd === 'node engage-orchestrator.mjs') {
          return 'Platform picker output with enough content to pass length check';
        }
        if (cmd === 'node covenant-tracker.mjs digest') {
          return '@AgentX: knowledge exchange (due in 3 days)';
        }
        return '';
      },
    });
    const block = buildEPromptBlock(makeCtx(), deps);
    assert.match(block, /Agent covenants/);
    assert.match(block, /@AgentX/);
  });

  it('omits covenant block when no covenants', () => {
    const block = buildEPromptBlock(makeCtx(), makeDeps());
    assert.doesNotMatch(block, /Agent covenants/);
  });

  it('omits covenant block on tracker failure', () => {
    const deps = makeDeps({
      execSync: (cmd) => {
        if (cmd === 'node engage-orchestrator.mjs') {
          return 'Platform picker output with enough content to pass length check';
        }
        if (cmd === 'node covenant-tracker.mjs digest') throw new Error('file not found');
        return '';
      },
    });
    const block = buildEPromptBlock(makeCtx(), deps);
    assert.doesNotMatch(block, /Agent covenants/);
  });
});

// --- Capability summary ---

describe('Capability summary', () => {
  it('includes capability summary when present', () => {
    const ctx = makeCtx({
      result: {
        capability_summary: '23 live, 2 defunct',
        live_platforms: 'Moltbook, Chatr',
      },
    });
    const block = buildEPromptBlock(ctx, makeDeps());
    assert.match(block, /Capabilities: 23 live/);
    assert.match(block, /Live: Moltbook, Chatr/);
  });

  it('includes cred_missing warning', () => {
    const ctx = makeCtx({
      result: {
        capability_summary: '23 live',
        live_platforms: 'Moltbook',
        cred_missing: 'chatr-credentials.json',
      },
    });
    const block = buildEPromptBlock(ctx, makeDeps());
    assert.match(block, /WARN: Missing credential files/);
    assert.match(block, /chatr-credentials/);
  });

  it('shows "none" when live_platforms absent', () => {
    const ctx = makeCtx({
      result: { capability_summary: '0 live, 5 defunct' },
    });
    const block = buildEPromptBlock(ctx, makeDeps());
    assert.match(block, /Live: none/);
  });

  it('omits capability block when no summary', () => {
    const block = buildEPromptBlock(makeCtx(), makeDeps());
    assert.doesNotMatch(block, /Capabilities:/);
  });
});

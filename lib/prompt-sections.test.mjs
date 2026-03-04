/**
 * Tests for lib/a-prompt-sections.mjs, lib/b-prompt-sections.mjs, lib/r-prompt-sections.mjs (wq-800)
 * Covers the remaining 3 prompt-section lib_modules for d071 combined coverage.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAPromptBlock } from './a-prompt-sections.mjs';
import { buildBPromptBlock } from './b-prompt-sections.mjs';
import { buildRPromptBlock } from './r-prompt-sections.mjs';

// ========== A PROMPT SECTIONS ==========

describe('buildAPromptBlock', () => {
  function makeCtx(overrides = {}) {
    return {
      fc: {
        text: () => null,
        json: () => null,
        ...overrides.fc,
      },
      PATHS: {
        aCounter: '/tmp/a-counter.txt',
        auditReport: '/tmp/audit-report.json',
        history: '/tmp/session-history.txt',
        ...overrides.PATHS,
      },
      MODE: overrides.MODE || 'A',
      COUNTER: overrides.COUNTER || 100,
      result: overrides.result || {},
      queue: overrides.queue || [],
      DIR: overrides.DIR || '/home/moltbot/moltbook-mcp',
    };
  }

  // We need to mock execSync for audit-stats.mjs. Since a-prompt-sections uses
  // bare import of execSync (no DI), we test the parts that don't depend on it
  // by accepting that auditStatsOutput may show a failure message.

  describe('A counter', () => {
    it('increments counter from file', () => {
      const ctx = makeCtx({
        fc: {
          text: (p) => p.includes('counter') ? '5' : null,
          json: () => null,
        },
      });
      const block = buildAPromptBlock(ctx);
      assert.match(block, /## A Session: #6/);
      assert.match(block, /audit session #6/);
    });

    it('defaults to 1 when counter missing', () => {
      const block = buildAPromptBlock(makeCtx());
      assert.match(block, /## A Session: #1/);
    });

    it('defaults to 1 for non-numeric counter', () => {
      const ctx = makeCtx({
        fc: { text: () => 'garbage', json: () => null },
      });
      const block = buildAPromptBlock(ctx);
      assert.match(block, /## A Session: #1/);
    });
  });

  describe('Previous audit summary', () => {
    it('includes previous audit data when report exists', () => {
      const ctx = makeCtx({
        fc: {
          text: () => null,
          json: (p) => {
            if (p.includes('audit')) {
              return {
                session: 1500,
                audit_number: 180,
                critical_issues: [],
                recommended_actions: [
                  { id: 'rec-1', description: 'Fix thing', priority: 'high' },
                ],
              };
            }
            return null;
          },
        },
      });
      const block = buildAPromptBlock(ctx);
      assert.match(block, /Previous audit: s1500/);
      assert.match(block, /A#180/);
      assert.match(block, /0 critical issues/);
      assert.match(block, /1 recommendations/);
    });

    it('shows critical issues when present', () => {
      const ctx = makeCtx({
        fc: {
          text: () => null,
          json: (p) => {
            if (p.includes('audit')) {
              return {
                session: 1500,
                audit_number: 180,
                critical_issues: [{ description: 'Coverage gap' }],
                recommended_actions: [],
              };
            }
            return null;
          },
        },
      });
      const block = buildAPromptBlock(ctx);
      assert.match(block, /1 critical issues/);
      assert.match(block, /Coverage gap/);
    });

    it('shows "No previous audit" when report missing', () => {
      const block = buildAPromptBlock(makeCtx());
      assert.match(block, /No previous audit report found/);
    });
  });

  describe('Recommendation lifecycle', () => {
    it('formats recommendations with deadline', () => {
      const ctx = makeCtx({
        fc: {
          text: () => null,
          json: (p) => {
            if (p.includes('audit')) {
              return {
                session: 1500,
                audit_number: 180,
                critical_issues: [],
                recommended_actions: [
                  { id: 'rec-1', description: 'Fix coverage gap', priority: 'high', deadline_session: 1520 },
                ],
              };
            }
            return null;
          },
        },
      });
      const block = buildAPromptBlock(ctx);
      assert.match(block, /Previous recommendations \(MUST track status\)/);
      assert.match(block, /rec-1 \[high\]: Fix coverage gap/);
      assert.match(block, /deadline: s1520/);
    });

    it('shows clean slate when no recommendations', () => {
      const ctx = makeCtx({
        fc: {
          text: () => null,
          json: (p) => {
            if (p.includes('audit')) {
              return {
                session: 1500,
                critical_issues: [],
                recommended_actions: [],
              };
            }
            return null;
          },
        },
      });
      const block = buildAPromptBlock(ctx);
      assert.match(block, /Previous recommendations: none/);
    });
  });

  describe('Audit-tagged queue items', () => {
    it('counts audit-tagged items by status', () => {
      const ctx = makeCtx({
        queue: [
          { tags: ['audit'], status: 'pending' },
          { tags: ['audit'], status: 'done' },
          { tags: ['audit'], status: 'pending' },
          { tags: [], status: 'pending' },
        ],
      });
      const block = buildAPromptBlock(ctx);
      assert.match(block, /2 pending, 1 done \(of 3 total\)/);
    });
  });

  describe('Cost trend', () => {
    it('includes cost trend when history available', () => {
      const historyLines = [];
      for (let i = 0; i < 10; i++) {
        historyLines.push(`2026-03-01 mode=B s=${1600 + i} cost=$1.50`);
      }
      const ctx = makeCtx({
        fc: {
          text: (p) => {
            if (p.includes('history')) return historyLines.join('\n');
            return null;
          },
          json: () => null,
        },
      });
      const block = buildAPromptBlock(ctx);
      assert.match(block, /Cost trend/);
      assert.match(block, /\$1\.50/);
      assert.match(block, /stable/);
    });
  });

  it('includes mandatory section reminder', () => {
    const block = buildAPromptBlock(makeCtx());
    assert.match(block, /All 5 sections are mandatory/);
  });
});

// ========== B PROMPT SECTIONS ==========

describe('buildBPromptBlock', () => {
  function makeCtx(overrides = {}) {
    return {
      fc: {
        text: () => null,
        json: () => null,
        ...overrides.fc,
      },
      PATHS: {
        bCounter: '/tmp/b-counter.txt',
        ...overrides.PATHS,
      },
      result: overrides.result || {},
    };
  }

  describe('B counter', () => {
    it('increments counter from file', () => {
      const ctx = makeCtx({
        fc: { text: (p) => p.includes('counter') ? '10' : null, json: () => null },
      });
      const block = buildBPromptBlock(ctx);
      assert.match(block, /## B Session: #11/);
    });

    it('defaults to 1 when counter missing', () => {
      const block = buildBPromptBlock(makeCtx());
      assert.match(block, /## B Session: #1/);
    });

    it('defaults to 1 for non-numeric counter', () => {
      const ctx = makeCtx({
        fc: { text: () => 'abc', json: () => null },
      });
      const block = buildBPromptBlock(ctx);
      assert.match(block, /## B Session: #1/);
    });
  });

  describe('Capability line', () => {
    it('includes capabilities when present in result', () => {
      const ctx = makeCtx({
        result: {
          capability_summary: '22 live, 0 defunct',
          live_platforms: 'Moltbook, Chatr',
        },
      });
      const block = buildBPromptBlock(ctx);
      assert.match(block, /Capabilities: 22 live/);
      assert.match(block, /Live: Moltbook, Chatr/);
    });

    it('shows "none" when no live_platforms', () => {
      const ctx = makeCtx({
        result: { capability_summary: '0 live, 5 defunct' },
      });
      const block = buildBPromptBlock(ctx);
      assert.match(block, /Live: none/);
    });

    it('includes cred_missing warning', () => {
      const ctx = makeCtx({
        result: {
          capability_summary: '20 live',
          live_platforms: 'Moltbook',
          cred_missing: 'chatr-credentials.json',
        },
      });
      const block = buildBPromptBlock(ctx);
      assert.match(block, /WARN: Missing credential files/);
      assert.match(block, /chatr-credentials/);
    });

    it('omits capability line when no summary', () => {
      const block = buildBPromptBlock(makeCtx());
      assert.doesNotMatch(block, /Capabilities:/);
    });
  });

  describe('EVM wallet line', () => {
    it('includes balance summary when present', () => {
      const ctx = makeCtx({
        result: {
          evm_balance_summary: '40 USDC on Base',
          onchain_items: 'wq-500',
        },
      });
      const block = buildBPromptBlock(ctx);
      assert.match(block, /EVM wallet \(Base\): 40 USDC/);
      assert.match(block, /Onchain tasks: wq-500/);
    });

    it('includes balance error when check fails', () => {
      const ctx = makeCtx({
        result: { evm_balance_error: 'RPC timeout' },
      });
      const block = buildBPromptBlock(ctx);
      assert.match(block, /EVM balance check failed: RPC timeout/);
    });

    it('omits wallet line when no balance data', () => {
      const block = buildBPromptBlock(makeCtx());
      assert.doesNotMatch(block, /EVM/);
    });
  });

  describe('Task assignment block', () => {
    it('includes assigned task from work queue', () => {
      const ctx = makeCtx({
        result: {
          wq_item: 'wq-800: Add tests for lib_modules',
          pending_count: 5,
        },
      });
      const block = buildBPromptBlock(ctx);
      assert.match(block, /YOUR ASSIGNED TASK \(from work queue\)/);
      assert.match(block, /wq-800/);
      assert.match(block, /primary task/);
    });

    it('includes brainstorming fallback label', () => {
      const ctx = makeCtx({
        result: {
          wq_item: 'Some brainstorm idea',
          wq_fallback: true,
          pending_count: 0,
        },
      });
      const block = buildBPromptBlock(ctx);
      assert.match(block, /brainstorming fallback/);
      assert.match(block, /work queue is empty/);
    });

    it('shows low queue warning when 1 item', () => {
      const ctx = makeCtx({
        result: {
          wq_item: 'wq-100: Something',
          pending_count: 1,
        },
      });
      const block = buildBPromptBlock(ctx);
      assert.match(block, /WARNING: Work queue is nearly empty/);
    });

    it('no queue warning when sufficient items', () => {
      const ctx = makeCtx({
        result: {
          wq_item: 'wq-100: Something',
          pending_count: 5,
        },
      });
      const block = buildBPromptBlock(ctx);
      assert.doesNotMatch(block, /WARNING: Work queue/);
    });

    it('omits task block when no wq_item', () => {
      const block = buildBPromptBlock(makeCtx());
      assert.doesNotMatch(block, /YOUR ASSIGNED TASK/);
    });
  });
});

// ========== R PROMPT SECTIONS ==========

describe('buildRPromptBlock', () => {
  function makeCtx(overrides = {}) {
    return {
      safeSection: (label, fn) => { try { return fn(); } catch { return ''; } },
      fc: {
        text: () => null,
        json: () => null,
        ...overrides.fc,
      },
      PATHS: {
        rCounter: '/tmp/r-counter.txt',
        humanReview: '/tmp/human-review.json',
        rImpact: '/tmp/r-impact.json',
        intel: '/tmp/intel.json',
        intelArchive: '/tmp/intel-archive.json',
        trace: '/tmp/trace.json',
        traceArchive: '/tmp/trace-archive.json',
        ...overrides.PATHS,
      },
      MODE: overrides.MODE || 'R',
      COUNTER: overrides.COUNTER || 100,
      result: overrides.result || {},
      queue: overrides.queue || [],
    };
  }

  describe('R counter', () => {
    it('increments counter in R mode', () => {
      const ctx = makeCtx({
        fc: { text: (p) => p.includes('counter') ? '5' : null, json: () => null },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /## R Session: #6/);
      assert.match(block, /R session #6/);
    });

    it('uses raw counter in non-R mode', () => {
      const ctx = makeCtx({
        fc: { text: (p) => p.includes('counter') ? '10' : null, json: () => null },
        MODE: 'B',
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /#10/);
    });

    it('defaults to 1 when counter missing (R mode)', () => {
      const ctx = makeCtx({ MODE: 'R' });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /#1/);
    });

    it('defaults to ? when counter missing (non-R mode)', () => {
      const ctx = makeCtx({ MODE: 'B' });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /#\?/);
    });
  });

  describe('Pipeline health snapshot', () => {
    it('shows queue and brainstorming counts', () => {
      const ctx = makeCtx({
        result: {
          pending_count: 8,
          blocked_count: 2,
          brainstorm_count: 5,
          intel_count: 3,
          intake_status: 'no-op',
        },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /Queue: 8 pending, 2 blocked/);
      assert.match(block, /Brainstorming: 5 ideas/);
      assert.match(block, /Intel inbox: 3 entries/);
    });

    it('includes retired count when present', () => {
      const ctx = makeCtx({
        result: {
          pending_count: 3,
          blocked_count: 0,
          retired_count: 5,
          brainstorm_count: 2,
          intel_count: 0,
          intake_status: 'no-op',
        },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /5 retired/);
    });

    it('includes human review count when present', () => {
      const ctx = makeCtx({
        fc: {
          text: () => null,
          json: (p) => {
            if (p.includes('human-review')) {
              return { items: [{ status: 'open' }, { status: 'resolved' }, { status: 'open' }] };
            }
            return null;
          },
        },
        result: {
          pending_count: 3,
          blocked_count: 0,
          brainstorm_count: 2,
          intel_count: 0,
          intake_status: 'no-op',
        },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /Human review: 2 open/);
    });
  });

  describe('Directive intake', () => {
    it('skips intake when no-op', () => {
      const ctx = makeCtx({
        result: { intake_status: 'no-op: nothing new', pending_count: 5 },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /Directive intake: no-op/);
      assert.match(block, /Skip directive intake/);
    });

    it('shows pending directives when detected', () => {
      const ctx = makeCtx({
        result: {
          intake_status: 'new directives',
          pending_directives: 'd075: Build something cool',
          pending_count: 5,
        },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /NEW directives detected/);
      assert.match(block, /PENDING DIRECTIVES/);
      assert.match(block, /d075/);
    });

    it('shows generic new directive message when no pending_directives text', () => {
      const ctx = makeCtx({
        result: { intake_status: 'new directives', pending_count: 5 },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /NEW directives detected/);
      assert.match(block, /directives.mjs pending/);
    });
  });

  describe('Urgent warnings', () => {
    it('warns when queue has <5 pending', () => {
      const ctx = makeCtx({
        result: { pending_count: 3, intake_status: 'no-op' },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /URGENT: Queue has <5 pending/);
    });

    it('warns when brainstorming has <3 ideas', () => {
      const ctx = makeCtx({
        result: { pending_count: 10, brainstorm_count: 1, intake_status: 'no-op' },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /WARN: Brainstorming has <3 ideas/);
    });

    it('includes intel digest when present', () => {
      const ctx = makeCtx({
        result: {
          pending_count: 10,
          intake_status: 'no-op',
          intel_digest: '**Queue candidates**:\n  - [s1700] Some intel',
        },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /Intel digest/);
      assert.match(block, /Queue candidates/);
    });
  });

  describe('Impact history', () => {
    it('includes impact data when analysis exists', () => {
      const ctx = makeCtx({
        fc: {
          text: () => null,
          json: (p) => {
            if (p.includes('impact')) {
              return {
                analysis: [
                  { category: 'tooling', impact: 'positive' },
                  { category: 'tooling', impact: 'positive' },
                  { category: 'engagement', impact: 'negative' },
                ],
                changes: [],
              };
            }
            return null;
          },
        },
        result: { pending_count: 10, intake_status: 'no-op' },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /Impact history/);
      assert.match(block, /tooling: PREFER/);
    });

    it('omits impact when no data', () => {
      const ctx = makeCtx({
        result: { pending_count: 10, intake_status: 'no-op' },
      });
      const block = buildRPromptBlock(ctx);
      assert.doesNotMatch(block, /Impact history/);
    });
  });

  describe('Intel promotion summary', () => {
    it('shows intel-auto items by status', () => {
      const ctx = makeCtx({
        queue: [
          { source: 'intel-auto', status: 'pending', id: 'wq-600', title: 'Add thing from intel' },
          { source: 'intel-auto', status: 'done', id: 'wq-601', title: 'Done item' },
          { source: 'manual', status: 'pending', id: 'wq-602', title: 'Regular item' },
        ],
        result: { pending_count: 10, intake_status: 'no-op' },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /Intel→Queue pipeline/);
      assert.match(block, /2 items auto-promoted/);
      assert.match(block, /1 pending/);
      assert.match(block, /1 done/);
      assert.match(block, /50%/); // conversion rate
    });

    it('shows capacity gated message when applicable', () => {
      const ctx = makeCtx({
        fc: {
          text: () => null,
          json: (p) => {
            if (p.includes('intel') && !p.includes('archive')) {
              return [{ type: 'integration_target', actionable: 'A long actionable string that passes threshold' }];
            }
            return null;
          },
        },
        result: { pending_count: 7, intake_status: 'no-op' },
      });
      const block = buildRPromptBlock(ctx);
      assert.match(block, /CAPACITY GATED/);
    });
  });
});

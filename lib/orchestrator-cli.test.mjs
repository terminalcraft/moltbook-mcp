/**
 * Tests for lib/orchestrator-cli.mjs (wq-800)
 * Covers: handleHistory, handleDiversity, handleDiversityTrends, handleQualityCheck
 * Note: handleDiversity and handleQualityCheck depend on external modules/execSync
 * so we test handleHistory (pure logic with DI) and handleDiversityTrends (file reads) most thoroughly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleHistory, handleDiversityTrends } from './orchestrator-cli.mjs';
import { join } from 'path';

// ========== handleHistory ==========

describe('handleHistory', () => {
  function makeDeps(circuits = {}) {
    return {
      loadCircuits: () => circuits,
      getCircuitState: (circs, platform) => {
        const entry = circs[platform];
        if (!entry) return 'closed';
        if ((entry.consecutive_failures || 0) >= 3) return 'open';
        return 'closed';
      },
      CIRCUIT_COOLDOWN_MS: 6 * 3600 * 1000, // 6 hours
    };
  }

  it('outputs JSON format with --json flag', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      const circuits = {
        'Moltbook': {
          last_success: new Date(Date.now() - 3600000).toISOString(),
          consecutive_failures: 0,
          total_successes: 10,
          total_failures: 2,
        },
      };
      handleHistory(['--json'], makeDeps(circuits));

      const output = JSON.parse(logs.join(''));
      assert.ok(output.diagnostics);
      assert.ok(output.timestamp);
      assert.equal(output.diagnostics.length, 1);
      assert.equal(output.diagnostics[0].platform, 'Moltbook');
      assert.equal(output.diagnostics[0].state, 'closed');
      assert.ok(output.diagnostics[0].successRate > 0);
    } finally {
      console.log = origLog;
    }
  });

  it('outputs table format without --json', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      const circuits = {
        'Chatr': {
          last_success: new Date(Date.now() - 7200000).toISOString(),
          consecutive_failures: 0,
          total_successes: 5,
          total_failures: 1,
        },
      };
      handleHistory([], makeDeps(circuits));

      const output = logs.join('\n');
      assert.match(output, /Circuit Breaker History/);
      assert.match(output, /Chatr/);
      assert.match(output, /Summary:/);
    } finally {
      console.log = origLog;
    }
  });

  it('sorts open circuits before closed', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      const circuits = {
        'HealthyPlatform': {
          consecutive_failures: 0,
          total_successes: 10,
          total_failures: 0,
          last_success: new Date().toISOString(),
        },
        'BrokenPlatform': {
          consecutive_failures: 5,
          total_successes: 1,
          total_failures: 5,
          last_failure: new Date().toISOString(),
        },
      };
      handleHistory(['--json'], makeDeps(circuits));

      const output = JSON.parse(logs.join(''));
      assert.equal(output.diagnostics[0].platform, 'BrokenPlatform');
      assert.equal(output.diagnostics[0].state, 'open');
      assert.equal(output.diagnostics[1].platform, 'HealthyPlatform');
    } finally {
      console.log = origLog;
    }
  });

  it('computes streak trends correctly', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      const circuits = {
        'Degrading': {
          consecutive_failures: 2,
          total_successes: 5,
          total_failures: 3,
        },
        'Healthy': {
          consecutive_failures: 0,
          total_successes: 10,
          total_failures: 1,
        },
      };
      handleHistory(['--json'], makeDeps(circuits));

      const output = JSON.parse(logs.join(''));
      const degrading = output.diagnostics.find(d => d.platform === 'Degrading');
      const healthy = output.diagnostics.find(d => d.platform === 'Healthy');
      assert.equal(degrading.streakTrend, 'degrading');
      assert.equal(healthy.streakTrend, 'healthy');
    } finally {
      console.log = origLog;
    }
  });

  it('computes retry info for open circuits', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      const circuits = {
        'Down': {
          consecutive_failures: 5,
          total_successes: 1,
          total_failures: 5,
          last_failure: new Date(Date.now() - 3600000).toISOString(), // 1h ago
        },
      };
      const deps = makeDeps(circuits);
      // Override to return 'open' for this platform
      deps.getCircuitState = () => 'open';
      handleHistory(['--json'], deps);

      const output = JSON.parse(logs.join(''));
      assert.ok(output.diagnostics[0].retryInfo);
      assert.match(output.diagnostics[0].retryInfo, /until half-open/);
    } finally {
      console.log = origLog;
    }
  });

  it('handles empty circuits object', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      handleHistory(['--json'], makeDeps({}));
      const output = JSON.parse(logs.join(''));
      assert.equal(output.diagnostics.length, 0);
    } finally {
      console.log = origLog;
    }
  });

  it('handles null success rate (no attempts)', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      const circuits = {
        'New': {
          consecutive_failures: 0,
          total_successes: 0,
          total_failures: 0,
        },
      };
      handleHistory(['--json'], makeDeps(circuits));
      const output = JSON.parse(logs.join(''));
      assert.equal(output.diagnostics[0].successRate, null);
    } finally {
      console.log = origLog;
    }
  });
});

// ========== handleDiversityTrends ==========

describe('handleDiversityTrends', () => {
  // STATE_DIR is evaluated at module load time from process.env.HOME,
  // so we can't override it after import. We test against real state.

  it('is exported and callable', () => {
    assert.ok(typeof handleDiversityTrends === 'function');
  });

  it('produces output without crashing (text mode)', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      handleDiversityTrends([]);
      const output = logs.join('\n');
      // Should output either "No diversity history" or trend data
      assert.ok(
        output.includes('diversity') || output.includes('Diversity') || output.includes('No diversity'),
        'Expected diversity-related output'
      );
    } finally {
      console.log = origLog;
    }
  });

  it('produces valid JSON in --json mode', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      handleDiversityTrends(['--json']);
      const output = JSON.parse(logs.join(''));
      // Should have either error+entries or trends+entries
      assert.ok(output.entries !== undefined || output.trends !== undefined);
    } finally {
      console.log = origLog;
    }
  });

  it('returns trends structure with correct shape in --json mode', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      handleDiversityTrends(['--json']);
      const output = JSON.parse(logs.join(''));
      if (output.trends) {
        // If history exists, verify structure
        assert.ok(typeof output.trends.total_entries === 'number');
        assert.ok(output.trends.latest);
        assert.ok(output.trends.last_10_avg);
        assert.ok(output.trends.trend_direction);
        assert.ok(['improving', 'worsening', 'stable'].includes(output.trends.trend_direction.hhi));
      }
    } finally {
      console.log = origLog;
    }
  });
});

// ========== handleQualityCheck ==========

describe('handleQualityCheck', () => {
  // handleQualityCheck calls process.exit and execSync, so we can only test
  // that it's exported and has the right shape.
  it('is exported and callable', async () => {
    const mod = await import('./orchestrator-cli.mjs');
    assert.ok(typeof mod.handleQualityCheck === 'function');
  });
});

// ========== handleDiversity ==========

describe('handleDiversity', () => {
  // handleDiversity depends on analyzeEngagement() which reads from disk.
  // We verify it's exported.
  it('is exported and callable', async () => {
    const mod = await import('./orchestrator-cli.mjs');
    assert.ok(typeof mod.handleDiversity === 'function');
  });
});

/**
 * Tests for lib/orchestrator-cli.mjs (wq-800, wq-804)
 * Covers: handleHistory, handleDiversity, handleDiversityTrends, handleQualityCheck
 * All handlers use DI for testability — handleDiversity via deps.analyzeEngagement,
 * handleDiversityTrends via deps.historyFile, handleQualityCheck via deps.execSync/exit.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleHistory, handleDiversity, handleDiversityTrends, handleQualityCheck } from './orchestrator-cli.mjs';

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

// ========== handleDiversityTrends (with DI) ==========

describe('handleDiversityTrends', () => {
  function captureLogs(fn) {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try { fn(); } finally { console.log = origLog; }
    return logs;
  }

  it('handles missing history file (text mode)', () => {
    const logs = captureLogs(() => {
      handleDiversityTrends([], { historyFile: '/tmp/nonexistent-diversity-test.json' });
    });
    assert.ok(logs.join('\n').includes('No diversity history'));
  });

  it('handles missing history file (JSON mode)', () => {
    const logs = captureLogs(() => {
      handleDiversityTrends(['--json'], { historyFile: '/tmp/nonexistent-diversity-test.json' });
    });
    const output = JSON.parse(logs.join(''));
    assert.equal(output.error, 'No diversity history yet');
    assert.deepEqual(output.entries, []);
  });

  it('handles empty history file', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
    const tmpFile = join(tmpDir, 'diversity.json');
    writeFileSync(tmpFile, '\n');
    try {
      const logs = captureLogs(() => {
        handleDiversityTrends(['--json'], { historyFile: tmpFile });
      });
      const output = JSON.parse(logs.join(''));
      assert.equal(output.error, 'Empty history');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('computes trends from NDJSON history', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
    const tmpFile = join(tmpDir, 'diversity.json');
    // Create 12 entries to test trend comparison
    const entries = [];
    for (let i = 0; i < 12; i++) {
      entries.push(JSON.stringify({
        session: 1000 + i,
        hhi: i < 6 ? 3000 : 1500, // older entries high HHI, recent low
        top1_pct: i < 6 ? 60 : 30,
        effective_platforms: i < 6 ? 3 : 6,
      }));
    }
    writeFileSync(tmpFile, entries.join('\n'));
    try {
      const logs = captureLogs(() => {
        handleDiversityTrends(['--json'], { historyFile: tmpFile });
      });
      const output = JSON.parse(logs.join(''));
      assert.equal(output.trends.total_entries, 12);
      assert.equal(output.trends.latest.session, 1011);
      assert.ok(output.trends.last_10_avg.hhi < output.trends.prev_10_avg.hhi);
      assert.equal(output.trends.trend_direction.hhi, 'improving');
      assert.equal(output.trends.trend_direction.concentration, 'diversifying');
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it('produces text format output', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
    const tmpFile = join(tmpDir, 'diversity.json');
    writeFileSync(tmpFile, JSON.stringify({ session: 1000, hhi: 2000, top1_pct: 40, effective_platforms: 5 }));
    try {
      const logs = captureLogs(() => {
        handleDiversityTrends([], { historyFile: tmpFile });
      });
      const output = logs.join('\n');
      assert.match(output, /Diversity Trends/);
      assert.match(output, /session 1000/);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

// ========== handleQualityCheck (with DI — wq-810) ==========

describe('handleQualityCheck', () => {
  function captureLogs(fn) {
    const logs = [];
    const errors = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => errors.push(args.join(' '));
    let result;
    try { result = fn(); } finally { console.log = origLog; console.error = origErr; }
    return { logs, errors, result };
  }

  it('returns 0 and logs output when quality check passes', () => {
    const exitCodes = [];
    const deps = {
      execSync: () => 'PASS: Post looks good\n',
      exit: (code) => exitCodes.push(code),
    };
    const { logs, result } = captureLogs(() =>
      handleQualityCheck(['--quality-check', 'Hello world'], '/tmp', deps)
    );
    assert.equal(result, 0);
    assert.deepEqual(exitCodes, [0]);
    assert.ok(logs.join('\n').includes('PASS: Post looks good'));
  });

  it('returns 1 and logs output when quality check fails with stdout', () => {
    const exitCodes = [];
    const deps = {
      execSync: () => { const e = new Error('exit 1'); e.stdout = 'BLOCKED: formulaic\n'; throw e; },
      exit: (code) => exitCodes.push(code),
    };
    const { logs, result } = captureLogs(() =>
      handleQualityCheck(['--quality-check', 'bad post'], '/tmp', deps)
    );
    assert.equal(result, 1);
    assert.deepEqual(exitCodes, [1]);
    assert.ok(logs.join('\n').includes('BLOCKED: formulaic'));
  });

  it('returns 1 with default message when quality check fails without stdout', () => {
    const exitCodes = [];
    const deps = {
      execSync: () => { throw new Error('exit 1'); },
      exit: (code) => exitCodes.push(code),
    };
    const { logs, result } = captureLogs(() =>
      handleQualityCheck(['--quality-check', 'bad post'], '/tmp', deps)
    );
    assert.equal(result, 1);
    assert.deepEqual(exitCodes, [1]);
    assert.ok(logs.join('\n').includes('BLOCKED: Post failed quality gate'));
  });

  it('returns 1 when no text argument provided', () => {
    const exitCodes = [];
    const deps = {
      execSync: () => { throw new Error('should not be called'); },
      exit: (code) => exitCodes.push(code),
    };
    const { errors, result } = captureLogs(() =>
      handleQualityCheck(['--quality-check'], '/tmp', deps)
    );
    assert.equal(result, 1);
    assert.deepEqual(exitCodes, [1]);
    assert.ok(errors.join('\n').includes('Usage:'));
  });

  it('passes correct cwd and command to execSync', () => {
    let capturedCmd, capturedOpts;
    const deps = {
      execSync: (cmd, opts) => { capturedCmd = cmd; capturedOpts = opts; return 'PASS\n'; },
      exit: () => {},
    };
    captureLogs(() =>
      handleQualityCheck(['--quality-check', 'test text'], '/my/dir', deps)
    );
    assert.ok(capturedCmd.includes('post-quality-review.mjs'));
    assert.ok(capturedCmd.includes('test text'));
    assert.equal(capturedOpts.cwd, '/my/dir');
    assert.equal(capturedOpts.timeout, 10000);
    assert.equal(capturedOpts.encoding, 'utf8');
  });

  it('works with --quality-check not at argv start', () => {
    const exitCodes = [];
    const deps = {
      execSync: () => 'PASS\n',
      exit: (code) => exitCodes.push(code),
    };
    const { result } = captureLogs(() =>
      handleQualityCheck(['--other', '--quality-check', 'my text'], '/tmp', deps)
    );
    assert.equal(result, 0);
    assert.deepEqual(exitCodes, [0]);
  });
});

// ========== handleDiversity (with DI) ==========

describe('handleDiversity', () => {
  function mockAnalytics() {
    return {
      diversity: {
        platform_count: 5,
        effective_platforms_writes: 4,
        effective_platforms_calls: 3,
        hhi_writes: 2200,
        top1_pct: 35,
        top3_pct: 80,
        warning: null,
      },
      platforms: [
        { platform: 'Moltbook', writes: 10, pct_of_writes: 35, total_calls: 15, pct_of_calls: 30, e_sessions: 8 },
        { platform: 'Chatr', writes: 8, pct_of_writes: 28, total_calls: 12, pct_of_calls: 24, e_sessions: 6 },
        { platform: 'Colony', writes: 5, pct_of_writes: 17, total_calls: 8, pct_of_calls: 16, e_sessions: 4 },
      ],
    };
  }

  function captureLogs(fn) {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try { fn(); } finally { console.log = origLog; }
    return logs;
  }

  it('outputs JSON format with --json flag', () => {
    const logs = captureLogs(() => {
      handleDiversity(['--json'], { analyzeEngagement: mockAnalytics });
    });
    const output = JSON.parse(logs.join(''));
    assert.ok(output.diversity);
    assert.ok(output.platforms);
    assert.equal(output.diversity.platform_count, 5);
    assert.equal(output.platforms.length, 3);
  });

  it('outputs text format without --json', () => {
    const logs = captureLogs(() => {
      handleDiversity([], { analyzeEngagement: mockAnalytics });
    });
    const output = logs.join('\n');
    assert.match(output, /Engagement Diversity Metrics/);
    assert.match(output, /Platform count: 5/);
    assert.match(output, /HHI \(writes\): 2200/);
    assert.match(output, /Moltbook/);
  });

  it('shows warning when present', () => {
    const analytics = mockAnalytics();
    analytics.diversity.warning = 'High concentration on Moltbook';
    const logs = captureLogs(() => {
      handleDiversity([], { analyzeEngagement: () => analytics });
    });
    const output = logs.join('\n');
    assert.match(output, /High concentration on Moltbook/);
  });

  it('shows HIGH concentration label for HHI > 2500', () => {
    const analytics = mockAnalytics();
    analytics.diversity.hhi_writes = 3000;
    const logs = captureLogs(() => {
      handleDiversity([], { analyzeEngagement: () => analytics });
    });
    assert.ok(logs.join('\n').includes('HIGH concentration'));
  });

  it('shows low concentration label for HHI < 1500', () => {
    const analytics = mockAnalytics();
    analytics.diversity.hhi_writes = 1000;
    const logs = captureLogs(() => {
      handleDiversity([], { analyzeEngagement: () => analytics });
    });
    assert.ok(logs.join('\n').includes('(low)'));
  });
});

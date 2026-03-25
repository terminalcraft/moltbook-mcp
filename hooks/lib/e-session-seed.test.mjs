#!/usr/bin/env node
// e-session-seed.test.mjs — Unit tests for e-session-seed.mjs (d077, wq-947)
//
// Tests generateSeed() with dependency-injected fs operations.
// Covers: all 6 seed sections, malformed input, empty state, combined output.
//
// Usage: node --test hooks/lib/e-session-seed.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { generateSeed } from './e-session-seed.mjs';

function makeDeps(files = {}) {
  return {
    readFileSync(path, enc) {
      if (files[path] !== undefined) return files[path];
      throw new Error('ENOENT: ' + path);
    },
    existsSync(path) {
      return files[path] !== undefined;
    },
  };
}

// ---- Section 1: Last E sessions ----
describe('last E sessions', () => {
  test('extracts up to 3 most recent E session lines', () => {
    const history = [
      '2026-03-01 mode=B s=500 note: build stuff',
      '2026-03-02 mode=E s=510 note: engaged platform A',
      '2026-03-03 mode=E s=520 note: engaged platform B',
      '2026-03-04 mode=R s=530 note: reflect',
      '2026-03-05 mode=E s=540 note: engaged platform C',
      '2026-03-06 mode=E s=550 note: engaged platform D',
    ].join('\n');

    const deps = makeDeps({ '/h.txt': history });
    const result = generateSeed({ historyFile: '/h.txt', intelFile: '/none', nudgeFile: '/none', deps });

    assert.ok(result.sections.includes('last_e_sessions'));
    assert.ok(result.text.includes('## Last E sessions'));
    // Should only include last 3 E sessions (s520, s540, s550)
    assert.ok(result.text.includes('s=520'));
    assert.ok(result.text.includes('s=540'));
    assert.ok(result.text.includes('s=550'));
    assert.ok(!result.text.includes('s=510'));
  });

  test('skips section when no E sessions in history', () => {
    const history = '2026-03-01 mode=B s=100 note: build\n2026-03-02 mode=R s=101 note: reflect\n';
    const deps = makeDeps({ '/h.txt': history });
    const result = generateSeed({ historyFile: '/h.txt', intelFile: '/none', nudgeFile: '/none', deps });

    assert.ok(!result.sections.includes('last_e_sessions'));
  });
});

// ---- Section 2: Engagement intel ----
describe('engagement intel', () => {
  test('renders up to 8 recent intel entries with actionable items', () => {
    const intel = [];
    for (let i = 0; i < 10; i++) {
      intel.push({ type: 'observation', session: 100 + i, summary: `insight ${i}`, actionable: i === 9 ? 'do this' : undefined });
    }
    const deps = makeDeps({ '/intel.json': JSON.stringify(intel) });
    const result = generateSeed({ historyFile: '/none', intelFile: '/intel.json', nudgeFile: '/none', deps });

    assert.ok(result.sections.includes('intel'));
    assert.ok(result.text.includes('## Engagement intel'));
    // Last 8 means entries 2-9
    assert.ok(!result.text.includes('insight 1'));
    assert.ok(result.text.includes('insight 2'));
    assert.ok(result.text.includes('insight 9'));
    assert.ok(result.text.includes('Action: do this'));
  });

  test('skips intel section for empty array', () => {
    const deps = makeDeps({ '/intel.json': '[]' });
    const result = generateSeed({ historyFile: '/none', intelFile: '/intel.json', nudgeFile: '/none', deps });

    assert.ok(!result.sections.includes('intel'));
  });

  test('skips intel section for malformed JSON', () => {
    const deps = makeDeps({ '/intel.json': '{broken!!!' });
    const result = generateSeed({ historyFile: '/none', intelFile: '/intel.json', nudgeFile: '/none', deps });

    assert.ok(!result.sections.includes('intel'));
  });
});

// ---- Section 3: Platform rotation hint ----
describe('platform rotation hint', () => {
  test('extracts note from last E session as rotation hint', () => {
    const history = [
      '2026-03-01 mode=E s=100 note: Engaged Chatr, 4claw, Moltchan',
      '2026-03-02 mode=B s=101 note: build stuff',
      '2026-03-03 mode=E s=102 note: Engaged MoltStack, MoltCities, DevAIntArt',
    ].join('\n');

    const deps = makeDeps({ '/h.txt': history });
    const result = generateSeed({ historyFile: '/h.txt', intelFile: '/none', nudgeFile: '/none', deps });

    assert.ok(result.sections.includes('rotation_hint'));
    assert.ok(result.text.includes('MoltStack, MoltCities, DevAIntArt'));
    assert.ok(result.text.includes('Prioritize platforms NOT mentioned'));
  });
});

// ---- Section 4: Cost trend ----
describe('cost trend and budget', () => {
  test('calculates avg cost and flags over-budget sessions', () => {
    const history = [
      '2026-03-01 mode=E s=100 dur=5m30s cost=$1.50 note: e1',
      '2026-03-02 mode=E s=102 dur=7m00s cost=$2.10 note: e2',
      '2026-03-03 mode=E s=104 dur=4m15s cost=$0.90 note: e3',
    ].join('\n');

    const deps = makeDeps({ '/h.txt': history });
    const result = generateSeed({ historyFile: '/h.txt', intelFile: '/none', nudgeFile: '/none', deps });

    assert.ok(result.sections.includes('budget'));
    assert.ok(result.text.includes('## E session cost trend'));
    assert.ok(result.text.includes('$1.50'));
    assert.ok(result.text.includes('$2.10'));
    assert.ok(result.text.includes('$0.90'));
    assert.ok(result.text.includes('violations (>$1.80): 1/3'));
  });

  test('injects COST PRESSURE warning when avg > $1.80', () => {
    const history = [
      '2026-03-01 mode=E s=100 dur=8m00s cost=$2.00 note: e1',
      '2026-03-02 mode=E s=102 dur=9m00s cost=$2.20 note: e2',
    ].join('\n');

    const deps = makeDeps({ '/h.txt': history });
    const result = generateSeed({ historyFile: '/h.txt', intelFile: '/none', nudgeFile: '/none', deps });

    assert.ok(result.text.includes('**COST PRESSURE**'));
    assert.ok(result.text.includes('3 platforms'));
  });

  test('shows on-target message when avg <= $1.50', () => {
    const history = '2026-03-01 mode=E s=100 dur=4m00s cost=$1.00 note: e1\n';
    const deps = makeDeps({ '/h.txt': history });
    const result = generateSeed({ historyFile: '/h.txt', intelFile: '/none', nudgeFile: '/none', deps });

    assert.ok(result.text.includes('on target'));
  });

  test('shows moderate warning when $1.50 < avg <= $1.80', () => {
    const history = [
      '2026-03-01 mode=E s=100 dur=6m00s cost=$1.60 note: e1',
      '2026-03-02 mode=E s=102 dur=6m00s cost=$1.70 note: e2',
    ].join('\n');

    const deps = makeDeps({ '/h.txt': history });
    const result = generateSeed({ historyFile: '/h.txt', intelFile: '/none', nudgeFile: '/none', deps });

    assert.ok(result.text.includes('above $1.50 target but under cap'));
  });

  test('calculates and displays average duration', () => {
    const history = [
      '2026-03-01 mode=E s=100 dur=4m30s cost=$1.00 note: e1',
      '2026-03-02 mode=E s=102 dur=6m10s cost=$1.20 note: e2',
    ].join('\n');

    const deps = makeDeps({ '/h.txt': history });
    const result = generateSeed({ historyFile: '/h.txt', intelFile: '/none', nudgeFile: '/none', deps });

    assert.ok(result.text.includes('Avg duration:'));
  });
});

// ---- Section 5: Circuit-broken platforms ----
describe('circuit-broken platforms', () => {
  test('lists platforms with 3+ consecutive failures within cooldown', () => {
    const circuits = {
      ThingHerder: { consecutive_failures: 5, last_failure: new Date().toISOString(), status: 'active' },
      Chatr: { consecutive_failures: 1, last_failure: new Date().toISOString(), status: 'active' },
    };
    const deps = makeDeps({ '/circuits.json': JSON.stringify(circuits) });
    const result = generateSeed({
      historyFile: '/none', intelFile: '/none', nudgeFile: '/none',
      deps: { ...deps, circuitsFile: '/circuits.json' },
    });

    assert.ok(result.sections.includes('circuit_break'));
    assert.ok(result.text.includes('ThingHerder'));
    assert.ok(result.text.includes('5 consecutive failures'));
    assert.ok(!result.text.includes('Chatr'));
  });

  test('excludes defunct platforms from circuit-break list', () => {
    const circuits = {
      DeadPlatform: { consecutive_failures: 10, last_failure: new Date().toISOString(), status: 'defunct' },
    };
    const deps = makeDeps({ '/circuits.json': JSON.stringify(circuits) });
    const result = generateSeed({
      historyFile: '/none', intelFile: '/none', nudgeFile: '/none',
      deps: { ...deps, circuitsFile: '/circuits.json' },
    });

    assert.ok(!result.sections.includes('circuit_break'));
  });

  test('excludes platforms past 24h cooldown', () => {
    const oldDate = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48h ago
    const circuits = {
      OldFail: { consecutive_failures: 5, last_failure: oldDate, status: 'active' },
    };
    const deps = makeDeps({ '/circuits.json': JSON.stringify(circuits) });
    const result = generateSeed({
      historyFile: '/none', intelFile: '/none', nudgeFile: '/none',
      deps: { ...deps, circuitsFile: '/circuits.json' },
    });

    assert.ok(!result.sections.includes('circuit_break'));
  });

  test('handles malformed circuits JSON gracefully', () => {
    const deps = makeDeps({ '/circuits.json': '{bad json!!' });
    const result = generateSeed({
      historyFile: '/none', intelFile: '/none', nudgeFile: '/none',
      deps: { ...deps, circuitsFile: '/circuits.json' },
    });

    assert.ok(!result.sections.includes('circuit_break'));
  });
});

// ---- Section 6: d049 nudge ----
describe('d049 nudge', () => {
  test('includes nudge content when file exists and is non-empty', () => {
    const deps = makeDeps({ '/nudge.txt': '## d049 compliance\nYou missed artifact creation last session.' });
    const result = generateSeed({ historyFile: '/none', intelFile: '/none', nudgeFile: '/nudge.txt', deps });

    assert.ok(result.sections.includes('d049_nudge'));
    assert.ok(result.text.includes('d049 compliance'));
    assert.ok(result.text.includes('missed artifact'));
  });

  test('skips nudge when file is empty', () => {
    const deps = makeDeps({ '/nudge.txt': '   ' });
    const result = generateSeed({ historyFile: '/none', intelFile: '/none', nudgeFile: '/nudge.txt', deps });

    assert.ok(!result.sections.includes('d049_nudge'));
  });
});

// ---- Missing / nonexistent files ----
describe('missing files', () => {
  test('returns empty output when no files exist', () => {
    const deps = makeDeps({});
    const result = generateSeed({ historyFile: '/none', intelFile: '/none', nudgeFile: '/none', deps });

    assert.strictEqual(result.lines, 0);
    assert.strictEqual(result.text, '');
    assert.deepStrictEqual(result.sections, []);
  });

  test('produces partial output when only some files exist', () => {
    const deps = makeDeps({
      '/nudge.txt': '## Nudge\nDo better.',
    });
    const result = generateSeed({ historyFile: '/none', intelFile: '/none', nudgeFile: '/nudge.txt', deps });

    assert.ok(result.sections.includes('d049_nudge'));
    assert.ok(!result.sections.includes('last_e_sessions'));
    assert.ok(!result.sections.includes('intel'));
    assert.strictEqual(result.sections.length, 1);
  });
});

// ---- Combined output ----
describe('combined output', () => {
  test('produces all 6 sections when all data is present', () => {
    const history = [
      '2026-03-01 mode=E s=100 dur=5m00s cost=$1.20 note: Engaged Chatr, 4claw',
      '2026-03-02 mode=B s=101 note: build',
      '2026-03-03 mode=E s=102 dur=4m30s cost=$1.10 note: Engaged MoltStack',
      '2026-03-04 mode=E s=103 dur=6m00s cost=$1.50 note: Engaged Moltchan, MoltCities',
    ].join('\n');

    const intel = [
      { type: 'trend', session: 100, summary: 'decay signal growing' },
      { type: 'gap', session: 102, summary: 'missing MoltbotDen', actionable: 'try next session' },
    ];

    const circuits = {
      AICQ: { consecutive_failures: 4, last_failure: new Date().toISOString(), status: 'active' },
    };

    const files = {
      '/h.txt': history,
      '/intel.json': JSON.stringify(intel),
      '/nudge.txt': '## d049 warning\nCreate artifacts!',
      '/circuits.json': JSON.stringify(circuits),
    };
    const deps = makeDeps(files);

    const result = generateSeed({
      historyFile: '/h.txt', intelFile: '/intel.json', nudgeFile: '/nudge.txt',
      deps: { ...deps, circuitsFile: '/circuits.json' },
    });

    assert.strictEqual(result.sections.length, 6);
    assert.ok(result.sections.includes('last_e_sessions'));
    assert.ok(result.sections.includes('intel'));
    assert.ok(result.sections.includes('rotation_hint'));
    assert.ok(result.sections.includes('budget'));
    assert.ok(result.sections.includes('circuit_break'));
    assert.ok(result.sections.includes('d049_nudge'));
    assert.ok(result.lines > 10);
  });
});

#!/usr/bin/env node
// e-cost-cap.test.mjs — Unit tests for e-cost-cap.mjs (wq-900)
//
// Covers: threshold defaults ($1.80), cost extraction from history,
// cost cap violations, registration keyword detection, regCount logic,
// audit file appending, edge cases.
//
// Usage: node --test hooks/lib/e-cost-cap.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { checkCostCap } from './e-cost-cap.mjs';

const silentLog = () => {};

function mockDeps({ historyContent = null, traceContent = null, auditWrites = [] } = {}) {
  return {
    readFileSync(path) {
      if (historyContent !== null && path.includes('history')) return historyContent;
      if (traceContent !== null && path.includes('trace')) return traceContent;
      throw new Error('ENOENT: no such file');
    },
    appendFileSync(path, data) {
      auditWrites.push({ path, data });
    },
    log: silentLog,
  };
}

function historyLine(session, cost) {
  return `2026-03-08 mode=E s=${session} dur=4m cost=$${cost.toFixed(4)} build=(none)\n`;
}

function traceJson(session, extras = {}) {
  return JSON.stringify([{
    session,
    platforms_engaged: extras.platforms || ['moltbook', 'chatr'],
    ...extras,
  }]);
}

// ---- COST THRESHOLD ----

describe('e-cost-cap: cost threshold', () => {
  test('default threshold is $1.80', () => {
    const deps = mockDeps({ historyContent: historyLine(100, 1.81) });
    const r = checkCostCap({ session: 100, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.strictEqual(r.costOk, false);
    assert.strictEqual(r.cost, 1.81);
  });

  test('cost exactly at threshold passes', () => {
    const deps = mockDeps({ historyContent: historyLine(101, 1.80) });
    const r = checkCostCap({ session: 101, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.strictEqual(r.costOk, true);
    assert.strictEqual(r.cost, 1.80);
  });

  test('cost below threshold passes', () => {
    const deps = mockDeps({ historyContent: historyLine(102, 0.95) });
    const r = checkCostCap({ session: 102, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.strictEqual(r.costOk, true);
  });

  test('cost above threshold fails', () => {
    const deps = mockDeps({ historyContent: historyLine(103, 2.50) });
    const r = checkCostCap({ session: 103, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.strictEqual(r.costOk, false);
    assert.strictEqual(r.cost, 2.50);
  });

  test('custom threshold overrides default', () => {
    const deps = mockDeps({ historyContent: historyLine(104, 3.00) });
    const r = checkCostCap({ session: 104, historyFile: 'history', traceFile: 'trace', hasTrace: false, threshold: 5.00, deps });
    assert.strictEqual(r.costOk, true);
  });
});

// ---- NO COST DATA ----

describe('e-cost-cap: missing cost data', () => {
  test('returns costOk=true when no cost line matches session', () => {
    const deps = mockDeps({ historyContent: historyLine(999, 1.50) });
    const r = checkCostCap({ session: 200, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.strictEqual(r.costOk, true);
    assert.strictEqual(r.cost, null);
  });

  test('returns costOk=true when history file missing', () => {
    const deps = mockDeps(); // no historyContent → ENOENT
    const r = checkCostCap({ session: 201, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.strictEqual(r.costOk, true);
    assert.strictEqual(r.cost, null);
  });
});

// ---- AUDIT FILE ----

describe('e-cost-cap: audit file', () => {
  test('appends WARN to audit file when cost exceeds threshold', () => {
    const auditWrites = [];
    const deps = mockDeps({ historyContent: historyLine(300, 2.10), auditWrites });
    checkCostCap({ session: 300, historyFile: 'history', traceFile: 'trace', hasTrace: false, auditFile: '/tmp/audit.txt', deps });
    assert.strictEqual(auditWrites.length, 1);
    assert.ok(auditWrites[0].data.includes('WARN'));
    assert.ok(auditWrites[0].data.includes('s300'));
    assert.ok(auditWrites[0].data.includes('2.1'));
  });

  test('does not append to audit file when cost is OK', () => {
    const auditWrites = [];
    const deps = mockDeps({ historyContent: historyLine(301, 1.00), auditWrites });
    checkCostCap({ session: 301, historyFile: 'history', traceFile: 'trace', hasTrace: false, auditFile: '/tmp/audit.txt', deps });
    assert.strictEqual(auditWrites.length, 0);
  });

  test('does not crash when auditFile not provided and cost exceeds', () => {
    const deps = mockDeps({ historyContent: historyLine(302, 5.00) });
    const r = checkCostCap({ session: 302, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.strictEqual(r.costOk, false);
  });
});

// ---- REGISTRATION KEYWORD DETECTION ----

describe('e-cost-cap: registration detection', () => {
  test('no registration keywords → regCount=0, regOk=true', () => {
    const trace = traceJson(400, { note: 'replied to thread about code review' });
    const deps = mockDeps({ historyContent: historyLine(400, 1.00), traceContent: trace });
    const r = checkCostCap({ session: 400, historyFile: 'history', traceFile: 'trace', hasTrace: true, deps });
    assert.strictEqual(r.regCount, 0);
    assert.strictEqual(r.regOk, true);
  });

  test('1 registration keyword with matching platform → regCount=1, regOk=true', () => {
    const trace = traceJson(401, {
      note: 'signup on moltbook and posted',
      platforms: ['moltbook'],
    });
    const deps = mockDeps({ historyContent: historyLine(401, 1.00), traceContent: trace });
    const r = checkCostCap({ session: 401, historyFile: 'history', traceFile: 'trace', hasTrace: true, deps });
    assert.strictEqual(r.regCount, 1);
    assert.strictEqual(r.regOk, true);
  });

  test('registration keywords with multiple platforms → regCount>1, regOk=false', () => {
    const trace = traceJson(402, {
      note: 'Registration on moltbook and signup on chatr',
      platforms: ['moltbook', 'chatr'],
    });
    const deps = mockDeps({ historyContent: historyLine(402, 1.00), traceContent: trace });
    const r = checkCostCap({ session: 402, historyFile: 'history', traceFile: 'trace', hasTrace: true, deps });
    assert.ok(r.regCount > 1);
    assert.strictEqual(r.regOk, false);
  });

  test('regCount capped at 5', () => {
    const trace = traceJson(403, {
      note: 'register register register register register register register signup signup signup',
      platforms: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    });
    const deps = mockDeps({ historyContent: historyLine(403, 1.00), traceContent: trace });
    const r = checkCostCap({ session: 403, historyFile: 'history', traceFile: 'trace', hasTrace: true, deps });
    assert.ok(r.regCount <= 5, `regCount should be capped at 5, got ${r.regCount}`);
  });

  test('all REG_KEYWORDS are detected', () => {
    const keywords = ['register', 'signup', 'sign up', 'create account', 'new account', 'registration'];
    for (const kw of keywords) {
      const trace = traceJson(410, {
        note: `${kw} on moltbook`,
        platforms: ['moltbook'],
      });
      const deps = mockDeps({ historyContent: historyLine(410, 1.00), traceContent: trace });
      const r = checkCostCap({ session: 410, historyFile: 'history', traceFile: 'trace', hasTrace: true, deps });
      assert.ok(r.regCount >= 1, `keyword "${kw}" should be detected, regCount=${r.regCount}`);
    }
  });

  test('appends audit WARN when regCount > 1', () => {
    const auditWrites = [];
    const trace = traceJson(404, {
      note: 'Registration on moltbook and signup on chatr',
      platforms: ['moltbook', 'chatr'],
    });
    const deps = mockDeps({ historyContent: historyLine(404, 1.00), traceContent: trace, auditWrites });
    checkCostCap({ session: 404, historyFile: 'history', traceFile: 'trace', hasTrace: true, auditFile: '/tmp/audit.txt', deps });
    assert.ok(auditWrites.length > 0, 'should write audit warning for multi-registration');
    assert.ok(auditWrites.some(w => w.data.includes('registration')));
  });
});

// ---- TRACE EDGE CASES ----

describe('e-cost-cap: trace edge cases', () => {
  test('hasTrace=false skips registration check entirely', () => {
    const deps = mockDeps({ historyContent: historyLine(500, 1.00) });
    const r = checkCostCap({ session: 500, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.strictEqual(r.regCount, 0);
    assert.strictEqual(r.regOk, null);
  });

  test('trace with no matching session → regOk stays null', () => {
    const trace = traceJson(999, { note: 'register on everything' });
    const deps = mockDeps({ historyContent: historyLine(501, 1.00), traceContent: trace });
    const r = checkCostCap({ session: 501, historyFile: 'history', traceFile: 'trace', hasTrace: true, deps });
    assert.strictEqual(r.regOk, null);
  });

  test('trace as single object (not array) is handled', () => {
    const trace = JSON.stringify({
      session: 502,
      platforms_engaged: ['moltbook'],
      note: 'register on moltbook',
    });
    const deps = mockDeps({ historyContent: historyLine(502, 1.00), traceContent: trace });
    const r = checkCostCap({ session: 502, historyFile: 'history', traceFile: 'trace', hasTrace: true, deps });
    assert.strictEqual(r.regCount, 1);
    assert.strictEqual(r.regOk, true);
  });

  test('malformed trace JSON is handled gracefully', () => {
    const deps = mockDeps({ historyContent: historyLine(503, 1.00), traceContent: '{invalid json' });
    const r = checkCostCap({ session: 503, historyFile: 'history', traceFile: 'trace', hasTrace: true, deps });
    assert.strictEqual(r.regOk, null);
    assert.strictEqual(r.regCount, 0);
  });
});

// ---- RETURN STRUCTURE ----

describe('e-cost-cap: return structure', () => {
  test('returns all expected fields', () => {
    const deps = mockDeps({ historyContent: historyLine(600, 1.50) });
    const r = checkCostCap({ session: 600, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.ok('costOk' in r);
    assert.ok('regOk' in r);
    assert.ok('cost' in r);
    assert.ok('regCount' in r);
  });
});

// ---- LOG OUTPUT ----

describe('e-cost-cap: log output', () => {
  test('logs OK message when cost is within threshold', () => {
    const logs = [];
    const deps = { ...mockDeps({ historyContent: historyLine(700, 1.00) }), log: msg => logs.push(msg) };
    checkCostCap({ session: 700, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.ok(logs.some(l => l.includes('OK') && l.includes('s700')));
  });

  test('logs WARN message when cost exceeds threshold', () => {
    const logs = [];
    const deps = { ...mockDeps({ historyContent: historyLine(701, 2.00) }), log: msg => logs.push(msg) };
    checkCostCap({ session: 701, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.ok(logs.some(l => l.includes('WARN') && l.includes('s701')));
  });

  test('logs skip message when no cost data', () => {
    const logs = [];
    const deps = { ...mockDeps(), log: msg => logs.push(msg) };
    checkCostCap({ session: 702, historyFile: 'history', traceFile: 'trace', hasTrace: false, deps });
    assert.ok(logs.some(l => l.includes('skip') && l.includes('s702')));
  });
});

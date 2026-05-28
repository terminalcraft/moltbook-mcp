#!/usr/bin/env node
// test-runner-utils.test.mjs — Tests for shared test runner utilities
//
// Covers: parseJsonFromOutput edge cases, createScratch lifecycle,
// execRunner with zero/non-zero exit and no-JSON output.
//
// Usage: node --test test-runner-utils.test.mjs
// Created: wq-1042

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseJsonFromOutput, execRunner, createScratch } from './test-runner-utils.mjs';

// --- parseJsonFromOutput ---

describe('parseJsonFromOutput', () => {
  it('parses clean JSON line', () => {
    const result = parseJsonFromOutput('{"key":"value"}');
    assert.deepStrictEqual(result, { key: 'value' });
  });

  it('finds JSON after stderr noise', () => {
    const output = 'Warning: something\nDebug: info\n{"status":"ok","count":3}';
    const result = parseJsonFromOutput(output);
    assert.deepStrictEqual(result, { status: 'ok', count: 3 });
  });

  it('finds JSON when followed by trailing newlines', () => {
    const result = parseJsonFromOutput('{"a":1}\n\n\n');
    assert.deepStrictEqual(result, { a: 1 });
  });

  it('prefers last JSON line when multiple exist', () => {
    const output = '{"first":true}\n{"second":true}';
    const result = parseJsonFromOutput(output);
    assert.deepStrictEqual(result, { second: true });
  });

  it('parses JSON array', () => {
    const result = parseJsonFromOutput('[1,2,3]');
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('throws on no valid JSON', () => {
    assert.throws(() => parseJsonFromOutput('no json here\njust text'), {
      message: /No valid JSON in runner output/,
    });
  });

  it('throws on empty string', () => {
    assert.throws(() => parseJsonFromOutput(''), {
      message: /No valid JSON in runner output/,
    });
  });

  it('truncates long output in error message', () => {
    const longLine = 'x'.repeat(300);
    try {
      parseJsonFromOutput(longLine);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e.message.length < 300, 'error message should be truncated');
    }
  });
});

// --- createScratch ---

describe('createScratch', () => {
  it('creates and cleans up scratch directory', () => {
    const scratch = createScratch('utils-test');
    scratch.setup();
    assert.ok(existsSync(scratch.dir));
    scratch.cleanup();
    assert.ok(!existsSync(scratch.dir));
  });

  it('writeJSON round-trips data correctly', () => {
    const scratch = createScratch('utils-json');
    scratch.setup();
    const data = { items: [1, 2], nested: { ok: true } };
    const path = scratch.writeJSON('test.json', data);
    assert.ok(existsSync(path));
    const read = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepStrictEqual(read, data);
    scratch.cleanup();
  });

  it('writeFile writes plain text', () => {
    const scratch = createScratch('utils-text');
    scratch.setup();
    const path = scratch.writeFile('notes.txt', 'hello world');
    assert.strictEqual(readFileSync(path, 'utf8'), 'hello world');
    scratch.cleanup();
  });

  it('cleanup is idempotent', () => {
    const scratch = createScratch('utils-idem');
    scratch.setup();
    scratch.cleanup();
    assert.doesNotThrow(() => scratch.cleanup());
  });

  it('writeJSON returns correct path', () => {
    const scratch = createScratch('utils-path');
    scratch.setup();
    const path = scratch.writeJSON('sub.json', {});
    assert.strictEqual(path, join(scratch.dir, 'sub.json'));
    scratch.cleanup();
  });
});

// --- execRunner ---

describe('execRunner', () => {
  it('parses JSON from successful command', () => {
    const result = execRunner('node -e "console.log(JSON.stringify({ok:true}))"');
    assert.deepStrictEqual(result, { ok: true });
  });

  it('parses JSON from command with stderr noise', () => {
    const result = execRunner('node -e "console.error(\'warn\'); console.log(JSON.stringify({v:42}))"');
    assert.deepStrictEqual(result, { v: 42 });
  });

  it('parses JSON from non-zero exit via e.stdout fallback', () => {
    const result = execRunner('node -e "console.log(JSON.stringify({partial:true})); process.exit(1)"');
    assert.deepStrictEqual(result, { partial: true });
  });

  it('throws when command produces no JSON and exits non-zero', () => {
    assert.throws(() => execRunner('node -e "process.exit(1)"'));
  });

  it('throws when command produces no output', () => {
    assert.throws(() => execRunner('node -e "console.log(\'not json\')"'), {
      message: /No valid JSON/,
    });
  });

  it('respects timeout option', () => {
    assert.throws(() => execRunner('node -e "setTimeout(()=>{},5000)"', { timeout: 500 }));
  });
});

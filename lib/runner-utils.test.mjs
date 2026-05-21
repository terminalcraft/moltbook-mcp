#!/usr/bin/env node
// runner-utils.test.mjs — Tests for shared safeRun/safeRunAsync utilities
//
// Usage: node --test lib/runner-utils.test.mjs
// Created: wq-1007

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeRun, safeRunAsync } from './runner-utils.mjs';

describe('safeRun', () => {
  it('returns ok:true with result on success', () => {
    const res = safeRun('test', () => 42);
    assert.deepStrictEqual(res, { ok: true, result: 42 });
  });

  it('returns ok:false with error on throw', () => {
    const res = safeRun('myLabel', () => { throw new Error('boom'); });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'myLabel: boom');
  });

  it('truncates error messages to 200 chars', () => {
    const longMsg = 'x'.repeat(300);
    const res = safeRun('trunc', () => { throw new Error(longMsg); });
    assert.equal(res.ok, false);
    assert.equal(res.error, `trunc: ${'x'.repeat(200)}`);
    assert.ok(res.error.length <= 200 + 'trunc: '.length);
  });

  it('handles errors without message property', () => {
    const res = safeRun('noMsg', () => { throw { code: 'ERR' }; });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'noMsg: unknown');
  });

  it('passes through falsy results correctly', () => {
    assert.deepStrictEqual(safeRun('null', () => null), { ok: true, result: null });
    assert.deepStrictEqual(safeRun('undef', () => undefined), { ok: true, result: undefined });
    assert.deepStrictEqual(safeRun('zero', () => 0), { ok: true, result: 0 });
    assert.deepStrictEqual(safeRun('empty', () => ''), { ok: true, result: '' });
  });
});

describe('safeRunAsync', () => {
  it('returns ok:true with result on async success', async () => {
    const res = await safeRunAsync('async', async () => 'hello');
    assert.deepStrictEqual(res, { ok: true, result: 'hello' });
  });

  it('returns ok:false with error on async rejection', async () => {
    const res = await safeRunAsync('asyncErr', async () => { throw new Error('async boom'); });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'asyncErr: async boom');
  });

  it('truncates async error messages to 200 chars', async () => {
    const longMsg = 'y'.repeat(300);
    const res = await safeRunAsync('atrunc', async () => { throw new Error(longMsg); });
    assert.equal(res.ok, false);
    assert.equal(res.error, `atrunc: ${'y'.repeat(200)}`);
  });

  it('awaits promise results', async () => {
    const res = await safeRunAsync('promise', () => Promise.resolve(99));
    assert.deepStrictEqual(res, { ok: true, result: 99 });
  });

  it('catches rejected promises', async () => {
    const res = await safeRunAsync('reject', () => Promise.reject(new Error('nope')));
    assert.equal(res.ok, false);
    assert.equal(res.error, 'reject: nope');
  });
});

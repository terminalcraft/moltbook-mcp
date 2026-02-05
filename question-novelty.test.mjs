#!/usr/bin/env node
/**
 * Tests for question-novelty.mjs
 *
 * Source: wq-268 (creative continuity test)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'question-novelty.mjs');

function run(args) {
  try {
    return execSync(`node ${SCRIPT} ${args}`, { encoding: 'utf8', cwd: __dirname });
  } catch (e) {
    return e.stdout || e.message;
  }
}

describe('question-novelty.mjs', () => {
  test('--help shows usage', () => {
    const output = run('');
    assert.ok(output.includes('question-novelty.mjs'), 'Should show script name');
    assert.ok(output.includes('--analyze'), 'Should document --analyze flag');
    assert.ok(output.includes('--score'), 'Should document --score flag');
    assert.ok(output.includes('--report'), 'Should document --report flag');
  });

  test('--score returns valid JSON', () => {
    const output = run('--score "Test follow up about Chatr API"');
    const result = JSON.parse(output);
    assert.ok('score' in result, 'Should have score field');
    assert.ok('topic_key' in result, 'Should have topic_key field');
    assert.ok('reason' in result, 'Should have reason field');
    assert.ok(result.score >= 0 && result.score <= 100, 'Score should be 0-100');
  });

  test('--score extracts Chatr topic key', () => {
    const output = run('--score "Chatr API still returning error"');
    const result = JSON.parse(output);
    assert.ok(result.topic_key.includes('chatr'), 'Should extract chatr platform');
    assert.ok(result.topic_key.includes('api-error'), 'Should identify api-error issue type');
  });

  test('--score extracts LobChan topic key', () => {
    const output = run('--score "LobChan write API returns 404"');
    const result = JSON.parse(output);
    assert.ok(result.topic_key.includes('lobchan'), 'Should extract lobchan platform');
    assert.ok(result.topic_key.includes('write-api') || result.topic_key.includes('api-error'),
      'Should identify write-api or api-error issue type');
  });

  test('--score extracts agent mentions', () => {
    const output = run('--score "Check @Asuma-Toki response on verification"');
    const result = JSON.parse(output);
    assert.ok(result.topic_key.startsWith('agent:'), 'Should extract agent prefix');
    assert.ok(result.topic_key.includes('asuma'), 'Should include agent handle (lowercase)');
  });

  test('--score returns high novelty for new topic', () => {
    const output = run('--score "Completely unique topic about quantum computing"');
    const result = JSON.parse(output);
    assert.ok(result.score >= 70, `New topic should have high novelty (got ${result.score})`);
    // May be 'new_topic' or 'novel_framing' depending on history size
    assert.ok(['new_topic', 'novel_framing'].includes(result.reason),
      `Should identify as new_topic or novel_framing (got ${result.reason})`);
  });

  test('--analyze runs without error', () => {
    const output = run('--analyze');
    assert.ok(output.includes('FOLLOW_UP TOPIC ANALYSIS') || output.includes('No follow_up history'),
      'Should show analysis or empty message');
  });

  test('--report runs without error', () => {
    const output = run('--report');
    assert.ok(
      output.includes('NOVELTY TREND REPORT') || output.includes('Insufficient history'),
      'Should show report or insufficient data message'
    );
  });

  test('topic key normalization is consistent', () => {
    // Same topic in different phrasings should get same key
    const output1 = run('--score "Chatr API error"');
    const output2 = run('--score "chatr api returning error"');
    const result1 = JSON.parse(output1);
    const result2 = JSON.parse(output2);
    assert.strictEqual(result1.topic_key, result2.topic_key, 'Same topic should get same key');
  });

  test('similarity detection works', () => {
    // LobChan API issues appear many times in history
    const output = run('--score "LobChan API returning empty response"');
    const result = JSON.parse(output);
    // Should find similar entries in history
    assert.ok(result.topic_appearances > 0 || result.reason === 'new_topic',
      'Should either find topic appearances or mark as new');
    if (result.topic_appearances > 0) {
      assert.ok(result.score < 100, 'Repeated topic should have <100 novelty');
    }
  });
});

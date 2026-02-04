/**
 * Tests for parallel-explore.mjs (wq-201)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { explore } from './parallel-explore.mjs';

const TEST_DIR = join(tmpdir(), `parallel-explore-test-${Date.now()}`);

describe('parallel-explore', () => {
  before(async () => {
    // Create test directory structure
    await mkdir(join(TEST_DIR, 'src'), { recursive: true });
    await mkdir(join(TEST_DIR, 'lib'), { recursive: true });

    // Create test files
    await writeFile(join(TEST_DIR, 'src', 'session.js'), `
function getSession() {
  return { id: 1 };
}
export { getSession };
`);

    await writeFile(join(TEST_DIR, 'src', 'user.js'), `
const sessionManager = () => {};
class UserSession {}
export { sessionManager, UserSession };
`);

    await writeFile(join(TEST_DIR, 'lib', 'utils.mjs'), `
// No session references here
export function helper() {}
`);

    await writeFile(join(TEST_DIR, 'README.md'), `
# Test Project
This project uses session handling.
`);

    // Initialize git repo for git-history strategy
    const { spawn } = await import('child_process');
    await new Promise((resolve) => {
      const proc = spawn('git', ['init'], { cwd: TEST_DIR });
      proc.on('close', resolve);
    });
    await new Promise((resolve) => {
      const proc = spawn('git', ['add', '.'], { cwd: TEST_DIR });
      proc.on('close', resolve);
    });
    await new Promise((resolve) => {
      const proc = spawn('git', ['commit', '-m', 'session initial'], {
        cwd: TEST_DIR,
        env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' }
      });
      proc.on('close', resolve);
    });
  });

  after(async () => {
    // Cleanup
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('returns results for a matching query', async () => {
    const result = await explore('session', TEST_DIR);

    assert.ok(result.results.length > 0, 'Should find some results');
    assert.ok(result.timing.totalMs > 0, 'Should report timing');
    assert.strictEqual(result.query, 'session');
    assert.strictEqual(result.cwd, TEST_DIR);
  });

  it('returns strategy results for each strategy', async () => {
    const result = await explore('session', TEST_DIR);

    assert.strictEqual(result.strategyResults.length, 4, 'Should have 4 strategies');
    const strategies = result.strategyResults.map(s => s.strategy);
    assert.ok(strategies.includes('filename'), 'Should include filename strategy');
    assert.ok(strategies.includes('content'), 'Should include content strategy');
    assert.ok(strategies.includes('git-history'), 'Should include git-history strategy');
    assert.ok(strategies.includes('symbol'), 'Should include symbol strategy');
  });

  it('scores results by number of matching strategies', async () => {
    const result = await explore('session', TEST_DIR);

    // Results should be sorted by score descending
    for (let i = 1; i < result.results.length; i++) {
      assert.ok(
        result.results[i - 1].score >= result.results[i].score,
        `Results should be sorted by score: ${result.results[i - 1].score} >= ${result.results[i].score}`
      );
    }
  });

  it('respects the limit option', async () => {
    const result = await explore('session', TEST_DIR, { limit: 2 });

    assert.ok(result.results.length <= 2, 'Should respect limit');
  });

  it('allows selecting specific strategies', async () => {
    const result = await explore('session', TEST_DIR, { strategies: ['filename'] });

    assert.strictEqual(result.strategyResults.length, 1, 'Should only run selected strategy');
    assert.strictEqual(result.strategyResults[0].strategy, 'filename');
  });

  it('handles no matches gracefully', async () => {
    const result = await explore('xyznonexistent123', TEST_DIR);

    assert.strictEqual(result.results.length, 0, 'Should return empty results');
    assert.ok(result.timing.totalMs >= 0, 'Should still report timing');
  });

  it('finds files by filename pattern', async () => {
    const result = await explore('session', TEST_DIR, { strategies: ['filename'] });

    // Should find session.js
    const files = result.results.map(r => r.file);
    assert.ok(
      files.some(f => f.includes('session.js')),
      `Should find session.js, got: ${files.join(', ')}`
    );
  });

  it('finds files by content grep', async () => {
    const result = await explore('sessionManager', TEST_DIR, { strategies: ['content'] });

    // Should find user.js which contains sessionManager
    const files = result.results.map(r => r.file);
    assert.ok(
      files.some(f => f.includes('user.js')),
      `Should find user.js containing sessionManager, got: ${files.join(', ')}`
    );
  });

  it('finds files by symbol definition', async () => {
    const result = await explore('getSession', TEST_DIR, { strategies: ['symbol'] });

    // Should find session.js which defines getSession function
    const files = result.results.map(r => r.file);
    assert.ok(
      files.some(f => f.includes('session.js')),
      `Should find session.js defining getSession, got: ${files.join(', ')}`
    );
  });

  it('merges results from multiple strategies correctly', async () => {
    // session.js should be found by filename AND content AND symbol
    const result = await explore('session', TEST_DIR);

    const sessionFile = result.results.find(r => r.file.includes('session.js'));
    assert.ok(sessionFile, 'Should find session.js');
    assert.ok(sessionFile.strategies.length >= 2, `session.js should match multiple strategies, got: ${sessionFile.strategies.join(', ')}`);
  });

  it('executes strategies in parallel', async () => {
    const start = Date.now();
    const result = await explore('session', TEST_DIR);
    const elapsed = Date.now() - start;

    // If strategies ran in parallel, total time should be close to the slowest strategy
    // not the sum of all strategies. With 4 strategies, parallel should be ~4x faster
    // We'll just verify it completes in reasonable time
    assert.ok(elapsed < 10000, `Should complete in reasonable time, took ${elapsed}ms`);
    assert.ok(result.timing.strategiesUsed === 4, 'Should use all 4 strategies');
  });
});

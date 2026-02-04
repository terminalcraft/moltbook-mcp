/**
 * Parallel Exploration Pattern (wq-201)
 *
 * Implements fan-out search from knowledge base pattern p014:
 * - N parallel search strategies with diverse approaches
 * - Coordinator filters and merges results
 *
 * This is a library, not a component. Can be used by scripts or future tools.
 *
 * Search strategies:
 * 1. Filename pattern matching (glob)
 * 2. Content grep (ripgrep)
 * 3. Git log (recent changes)
 */

import { spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, stat } from 'fs/promises';
import { join, relative } from 'path';

/**
 * Run a shell command and return stdout
 * @param {string} cmd - Command to run
 * @param {string[]} args - Arguments
 * @param {string} cwd - Working directory
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<string>}
 */
function runCmd(cmd, args, cwd, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024  // 1MB
    });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', d => { stdout += d; });
    proc.stderr?.on('data', d => { stderr += d; });

    proc.on('error', reject);
    proc.on('close', code => {
      // Some tools return non-zero for "no matches" - that's ok
      resolve(stdout);
    });
  });
}

/**
 * Search strategy: Filename matching via find/fd
 * @param {string} query - Search query (converted to glob pattern)
 * @param {string} cwd - Working directory
 * @returns {Promise<{strategy: string, results: string[], error?: string}>}
 */
async function searchByFilename(query, cwd) {
  const strategy = 'filename';
  try {
    // Convert query to glob-like pattern
    const pattern = `*${query}*`;

    // Try fd first (faster), fall back to find
    let output;
    try {
      output = await runCmd('fd', ['-t', 'f', '-i', query], cwd, 5000);
    } catch {
      output = await runCmd('find', ['.', '-type', 'f', '-iname', pattern, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'], cwd, 5000);
    }

    const results = output.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.includes('node_modules') && !l.includes('.git'))
      .slice(0, 50);  // Limit results

    return { strategy, results };
  } catch (err) {
    return { strategy, results: [], error: err.message };
  }
}

/**
 * Search strategy: Content grep via ripgrep
 * @param {string} query - Search pattern
 * @param {string} cwd - Working directory
 * @returns {Promise<{strategy: string, results: string[], error?: string}>}
 */
async function searchByContent(query, cwd) {
  const strategy = 'content';
  try {
    let output;
    try {
      // Try ripgrep first (faster)
      output = await runCmd('rg', [
        '-i',           // case insensitive
        '-l',           // files only
        '--max-count', '1',  // stop after first match per file
        '-g', '!node_modules',
        '-g', '!.git',
        '-g', '!*.min.js',
        query
      ], cwd, 10000);
    } catch {
      // Fallback to GNU grep
      output = await runCmd('grep', [
        '-r',           // recursive
        '-i',           // case insensitive
        '-l',           // files only
        '--include=*.js',
        '--include=*.mjs',
        '--include=*.ts',
        '--include=*.json',
        '--include=*.md',
        '--exclude-dir=node_modules',
        '--exclude-dir=.git',
        query,
        '.'
      ], cwd, 15000);
    }

    const results = output.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.includes('node_modules') && !l.includes('.git'))
      .slice(0, 50);

    return { strategy, results };
  } catch (err) {
    return { strategy, results: [], error: err.message };
  }
}

/**
 * Search strategy: Git log for recent changes
 * @param {string} query - Search pattern
 * @param {string} cwd - Working directory
 * @returns {Promise<{strategy: string, results: string[], error?: string}>}
 */
async function searchByGitHistory(query, cwd) {
  const strategy = 'git-history';
  try {
    // Search commit messages and diffs
    const output = await runCmd('git', [
      'log',
      '--all',
      '-p',
      '--grep', query,
      '-S', query,  // Also search for code changes
      '--name-only',
      '--pretty=format:',
      '-50'  // Last 50 commits
    ], cwd, 10000);

    const files = new Set();
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('commit ') && !trimmed.includes(' ') && trimmed.includes('.')) {
        files.add(trimmed);
      }
    }

    return { strategy, results: Array.from(files).slice(0, 50) };
  } catch (err) {
    return { strategy, results: [], error: err.message };
  }
}

/**
 * Search strategy: Symbol search (function/class names)
 * @param {string} query - Symbol name pattern
 * @param {string} cwd - Working directory
 * @returns {Promise<{strategy: string, results: string[], error?: string}>}
 */
async function searchBySymbol(query, cwd) {
  const strategy = 'symbol';
  try {
    // Build extended regex pattern for symbol definitions
    // GNU grep -E supports: ?, +, |, (), {}
    const pattern = `(function|class|const|let|var)\\s+${query}|${query}\\s*=\\s*(async\\s+)?\\(`;

    let output;
    try {
      // Try ripgrep first
      output = await runCmd('rg', [
        '-i',
        '-l',
        '-g', '!node_modules',
        '-g', '!.git',
        '-g', '*.{js,mjs,ts,jsx,tsx}',
        '-e', pattern
      ], cwd, 10000);
    } catch {
      // Fallback to GNU grep with extended regex
      output = await runCmd('grep', [
        '-r',
        '-i',
        '-l',
        '-E',
        '--include=*.js',
        '--include=*.mjs',
        '--include=*.ts',
        '--exclude-dir=node_modules',
        '--exclude-dir=.git',
        pattern,
        '.'
      ], cwd, 15000);
    }

    const results = output.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.includes('node_modules') && !l.includes('.git'))
      .slice(0, 50);

    return { strategy, results };
  } catch (err) {
    return { strategy, results: [], error: err.message };
  }
}

/**
 * Merge and score results from multiple strategies
 * @param {Array<{strategy: string, results: string[]}>} strategyResults
 * @returns {Array<{file: string, score: number, strategies: string[]}>}
 */
function mergeResults(strategyResults) {
  const fileScores = new Map();

  // Weight by strategy (content matches are stronger signals)
  const weights = {
    'content': 3,
    'symbol': 3,
    'filename': 2,
    'git-history': 1
  };

  for (const { strategy, results } of strategyResults) {
    const weight = weights[strategy] || 1;
    for (const file of results) {
      const normalized = file.startsWith('./') ? file.slice(2) : file;
      if (!fileScores.has(normalized)) {
        fileScores.set(normalized, { file: normalized, score: 0, strategies: [] });
      }
      const entry = fileScores.get(normalized);
      entry.score += weight;
      if (!entry.strategies.includes(strategy)) {
        entry.strategies.push(strategy);
      }
    }
  }

  // Sort by score descending, then by number of strategies
  return Array.from(fileScores.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.strategies.length - a.strategies.length;
    });
}

/**
 * Main parallel exploration function
 * @param {string} query - What to search for
 * @param {string} cwd - Working directory to search in
 * @param {Object} options - Options
 * @param {number} options.limit - Max results to return (default 20)
 * @param {string[]} options.strategies - Which strategies to use (default all)
 * @returns {Promise<{query: string, results: Array, strategyResults: Array, timing: Object}>}
 */
export async function explore(query, cwd, options = {}) {
  const { limit = 20, strategies = ['filename', 'content', 'git-history', 'symbol'] } = options;

  const start = Date.now();

  // Map strategy names to functions
  const strategyFns = {
    'filename': searchByFilename,
    'content': searchByContent,
    'git-history': searchByGitHistory,
    'symbol': searchBySymbol
  };

  // Run selected strategies in parallel
  const selectedStrategies = strategies
    .filter(s => strategyFns[s])
    .map(s => strategyFns[s](query, cwd));

  const strategyResults = await Promise.all(selectedStrategies);

  // Merge and rank results
  const merged = mergeResults(strategyResults);
  const results = merged.slice(0, limit);

  const timing = {
    totalMs: Date.now() - start,
    strategiesUsed: strategies.length
  };

  return {
    query,
    cwd,
    results,
    strategyResults: strategyResults.map(r => ({
      strategy: r.strategy,
      count: r.results.length,
      error: r.error
    })),
    timing
  };
}

/**
 * CLI interface for testing
 */
if (process.argv[1]?.endsWith('parallel-explore.mjs')) {
  const query = process.argv[2];
  const cwd = process.argv[3] || process.cwd();

  if (!query) {
    console.log('Usage: node parallel-explore.mjs <query> [cwd]');
    console.log('Example: node parallel-explore.mjs "session" /home/moltbot/moltbook-mcp');
    process.exit(1);
  }

  console.log(`Searching for "${query}" in ${cwd}...`);
  const result = await explore(query, cwd);

  console.log(`\nCompleted in ${result.timing.totalMs}ms\n`);
  console.log('Strategy results:');
  for (const s of result.strategyResults) {
    console.log(`  ${s.strategy}: ${s.count} files${s.error ? ` (error: ${s.error})` : ''}`);
  }

  console.log(`\nTop ${result.results.length} merged results:`);
  for (const r of result.results) {
    console.log(`  [${r.score}] ${r.file} (${r.strategies.join(', ')})`);
  }
}

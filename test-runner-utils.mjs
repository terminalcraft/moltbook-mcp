// test-runner-utils.mjs — Shared test helpers for prehook runner test files
//
// Centralizes subprocess execution, JSON-from-stdout extraction, error
// recovery, and scratch directory lifecycle used by all 4 runner tests.
//
// Created: wq-1039

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Parse JSON from subprocess output by scanning lines from the end.
 * Handles stderr noise that may precede the JSON line.
 */
function parseJsonFromOutput(out) {
  const lines = out.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error('No valid JSON in runner output: ' + out.trim().slice(0, 200));
}

/**
 * Execute a runner script and extract JSON from its stdout.
 * Falls back to parsing e.stdout on non-zero exit codes.
 *
 * @param {string} cmd - Full command to execute
 * @param {object} opts
 * @param {number} opts.timeout - Subprocess timeout in ms (default 15000)
 * @returns {object} Parsed JSON from runner output
 */
export function execRunner(cmd, { timeout = 15000 } = {}) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout });
    return parseJsonFromOutput(out);
  } catch (e) {
    if (e.stdout) {
      return parseJsonFromOutput(e.stdout);
    }
    throw e;
  }
}

/**
 * Create a scratch directory with lifecycle helpers.
 *
 * @param {string} prefix - Directory name prefix
 * @returns {{ dir: string, setup: Function, cleanup: Function, writeJSON: Function, writeFile: Function }}
 */
export function createScratch(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}`);
  return {
    dir,
    setup() { mkdirSync(dir, { recursive: true }); },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
    writeJSON(filename, data) {
      const p = join(dir, filename);
      writeFileSync(p, JSON.stringify(data, null, 2));
      return p;
    },
    writeFile(filename, text) {
      const p = join(dir, filename);
      writeFileSync(p, text);
      return p;
    },
  };
}

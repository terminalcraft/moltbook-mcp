#!/usr/bin/env node
/**
 * skill-verify.mjs — Fetch and verify skill.md files by content hash
 *
 * Fetches a skill.md from a URL, computes SHA-256, and optionally verifies
 * against an expected hash. Useful for trust verification before installing
 * skills from arbitrary URLs.
 *
 * Usage:
 *   node skill-verify.mjs <url>                    # fetch and print hash
 *   node skill-verify.mjs <url> --expect <sha256>  # verify against expected hash
 *   node skill-verify.mjs <url> --json             # JSON output
 *   node skill-verify.mjs --check <registry.json>  # batch verify from registry file
 *
 * Registry format (for --check):
 *   [{ "url": "https://example.com/skill.md", "sha256": "abc123..." }, ...]
 *
 * Exit codes:
 *   0 = success (hash matches or no --expect given)
 *   1 = hash mismatch
 *   2 = fetch error
 *
 * Created: B#335 (wq-384)
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';

const args = process.argv.slice(2);

function usage() {
  console.error('Usage: node skill-verify.mjs <url> [--expect <sha256>] [--json]');
  console.error('       node skill-verify.mjs --check <registry.json> [--json]');
  process.exit(2);
}

async function fetchSkill(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'skill-verify/1.0 (moltbook-mcp)' }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function computeHash(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function verifySingle(url, expectedHash, jsonMode) {
  try {
    const content = await fetchSkill(url);
    const hash = computeHash(content);
    const lines = content.split('\n').length;
    const bytes = Buffer.byteLength(content, 'utf8');

    const result = {
      url,
      sha256: hash,
      size_bytes: bytes,
      lines,
      verified: expectedHash ? hash === expectedHash : null,
      expected: expectedHash || null,
    };

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`URL:    ${url}`);
      console.log(`SHA256: ${hash}`);
      console.log(`Size:   ${bytes} bytes (${lines} lines)`);
      if (expectedHash) {
        if (hash === expectedHash) {
          console.log(`Verify: PASS (matches expected hash)`);
        } else {
          console.log(`Verify: FAIL`);
          console.log(`  Expected: ${expectedHash}`);
          console.log(`  Got:      ${hash}`);
        }
      }
    }

    return result;
  } catch (err) {
    const result = {
      url,
      error: err.message,
      verified: false,
    };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`ERROR: ${url} — ${err.message}`);
    }
    return result;
  }
}

async function batchCheck(registryPath, jsonMode) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to read registry: ${err.message}`);
    process.exit(2);
  }

  if (!Array.isArray(entries)) {
    console.error('Registry must be a JSON array of {url, sha256} objects');
    process.exit(2);
  }

  const results = [];
  let pass = 0, fail = 0, errors = 0;

  for (const entry of entries) {
    const result = await verifySingle(entry.url, entry.sha256, false);
    results.push(result);
    if (result.error) errors++;
    else if (result.verified === true) pass++;
    else if (result.verified === false) fail++;
    // Small delay between requests
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n--- Batch results: ${pass} pass, ${fail} fail, ${errors} error (${entries.length} total) ---`);

  if (jsonMode) {
    console.log(JSON.stringify({ results, summary: { pass, fail, errors, total: entries.length } }, null, 2));
  }

  process.exit(fail > 0 || errors > 0 ? 1 : 0);
}

// Parse args
const jsonMode = args.includes('--json');
const cleanArgs = args.filter(a => a !== '--json');

if (cleanArgs.length === 0) usage();

if (cleanArgs[0] === '--check') {
  if (!cleanArgs[1]) usage();
  await batchCheck(cleanArgs[1], jsonMode);
} else {
  const url = cleanArgs[0];
  const expectIdx = cleanArgs.indexOf('--expect');
  const expectedHash = expectIdx >= 0 ? cleanArgs[expectIdx + 1] : null;

  if (expectIdx >= 0 && !expectedHash) usage();

  const result = await verifySingle(url, expectedHash, jsonMode);
  if (result.error) process.exit(2);
  if (result.verified === false) process.exit(1);
}

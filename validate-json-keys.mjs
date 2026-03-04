#!/usr/bin/env node
// validate-json-keys.mjs — Check JSON files for duplicate keys at any nesting level
// Created: B#520 (wq-805)
//
// JSON.parse silently uses the last value for duplicate keys, making these bugs
// invisible. This linter detects them by parsing raw JSON text.
//
// Usage: node validate-json-keys.mjs [file1 file2 ...]
//   Default: checks directives.json, work-queue.json, human-review.json, account-registry.json
//   Exit 0 = all clean, Exit 1 = duplicates found

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const BASE = process.env.HOME ? join(process.env.HOME, 'moltbook-mcp') : '.';

const DEFAULT_FILES = [
  'directives.json',
  'work-queue.json',
  'human-review.json',
  'account-registry.json',
  'knowledge/patterns.json',
  'picker-demotions.json',
];

// --- Duplicate key detection via custom JSON tokenizer ---

function findDuplicateKeys(text) {
  const dupes = [];
  let pos = 0;
  const len = text.length;

  function skipWhitespace() {
    while (pos < len && /\s/.test(text[pos])) pos++;
  }

  function lineAt(p) {
    let line = 1;
    for (let i = 0; i < p && i < len; i++) {
      if (text[i] === '\n') line++;
    }
    return line;
  }

  function readString() {
    if (text[pos] !== '"') return null;
    let result = '';
    pos++;
    while (pos < len) {
      if (text[pos] === '\\') {
        result += text[pos] + text[pos + 1];
        pos += 2;
      } else if (text[pos] === '"') {
        pos++;
        return result;
      } else {
        result += text[pos];
        pos++;
      }
    }
    return result;
  }

  function skipValue() {
    skipWhitespace();
    if (pos >= len) return;

    if (text[pos] === '"') {
      readString();
    } else if (text[pos] === '{') {
      parseObject();
    } else if (text[pos] === '[') {
      parseArray();
    } else {
      while (pos < len && !/[,\]\}\s]/.test(text[pos])) pos++;
    }
  }

  function parseObject() {
    pos++;
    const keys = new Map();
    skipWhitespace();

    while (pos < len && text[pos] !== '}') {
      skipWhitespace();
      if (text[pos] === '}') break;
      if (text[pos] === ',') { pos++; skipWhitespace(); continue; }

      const keyPos = pos;
      const key = readString();
      if (key === null) { pos++; continue; }

      if (keys.has(key)) {
        dupes.push({
          key,
          firstLine: keys.get(key),
          dupeLine: lineAt(keyPos),
        });
      } else {
        keys.set(key, lineAt(keyPos));
      }

      skipWhitespace();
      if (text[pos] === ':') pos++;
      skipWhitespace();
      skipValue();
      skipWhitespace();
    }

    if (pos < len) pos++;
  }

  function parseArray() {
    pos++;
    skipWhitespace();

    while (pos < len && text[pos] !== ']') {
      skipWhitespace();
      if (text[pos] === ']') break;
      if (text[pos] === ',') { pos++; skipWhitespace(); continue; }
      skipValue();
      skipWhitespace();
    }

    if (pos < len) pos++;
  }

  skipWhitespace();
  if (text[pos] === '{') parseObject();
  else if (text[pos] === '[') parseArray();

  return dupes;
}

// --- Main ---

const args = process.argv.slice(2);
const files = args.length > 0
  ? args
  : DEFAULT_FILES.map(f => join(BASE, f));

let totalIssues = 0;
let filesChecked = 0;

for (const filePath of files) {
  if (!existsSync(filePath)) continue;

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    continue;
  }

  filesChecked++;
  const dupes = findDuplicateKeys(text);

  if (dupes.length > 0) {
    const name = filePath.replace(BASE + '/', '');
    for (const d of dupes) {
      console.log(`[json-keys] DUPLICATE in ${name}: "${d.key}" at line ${d.dupeLine} (first seen line ${d.firstLine})`);
    }
    totalIssues += dupes.length;
  }
}

if (totalIssues === 0) {
  console.log(`[json-keys] OK: ${filesChecked} file(s) checked, no duplicate keys`);
  process.exit(0);
} else {
  console.log(`[json-keys] ${totalIssues} duplicate key(s) found across ${filesChecked} file(s)`);
  process.exit(1);
}

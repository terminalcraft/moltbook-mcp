#!/usr/bin/env node
// validate-human-review.mjs — Lint human-review.json for duplicate keys and schema issues
// Created: B#516 (wq-796)
//
// Motivation: hr-a173-1 had a duplicate 'updated' key (lines 13 and 23) that went
// undetected for multiple audits because JSON.parse silently uses the last value.
//
// This linter:
// 1. Detects duplicate keys at any nesting level by parsing raw JSON text
// 2. Validates required fields on each item
// 3. Validates field types and enum values
//
// Usage: node validate-human-review.mjs [path]
//   Default path: ~/moltbook-mcp/human-review.json
//   Exit 0 = valid, Exit 1 = issues found

import { readFileSync } from 'fs';
import { join } from 'path';

const filePath = process.argv[2] || join(process.env.HOME, 'moltbook-mcp/human-review.json');
const issues = [];

// --- Phase 1: Duplicate key detection via custom JSON parse ---

function findDuplicateKeys(text) {
  // Strategy: Use a reviver-like approach with a state machine.
  // We tokenize the JSON and track keys per object scope.
  const dupes = [];
  const scopeStack = []; // stack of { type: 'object'|'array', keys: Set }
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
    pos++; // skip opening quote
    while (pos < len) {
      if (text[pos] === '\\') {
        result += text[pos] + text[pos + 1];
        pos += 2;
      } else if (text[pos] === '"') {
        pos++; // skip closing quote
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
      // number, boolean, null — consume until delimiter
      while (pos < len && !/[,\]\}\s]/.test(text[pos])) pos++;
    }
  }

  function parseObject() {
    pos++; // skip {
    const keys = new Map(); // key -> first-seen line
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
      if (text[pos] === ':') pos++; // skip colon
      skipWhitespace();
      skipValue();
      skipWhitespace();
    }

    if (pos < len) pos++; // skip }
  }

  function parseArray() {
    pos++; // skip [
    skipWhitespace();

    while (pos < len && text[pos] !== ']') {
      skipWhitespace();
      if (text[pos] === ']') break;
      if (text[pos] === ',') { pos++; skipWhitespace(); continue; }
      skipValue();
      skipWhitespace();
    }

    if (pos < len) pos++; // skip ]
  }

  skipWhitespace();
  if (text[pos] === '{') parseObject();
  else if (text[pos] === '[') parseArray();

  return dupes;
}

// --- Phase 2: Schema validation ---

const VALID_STATUSES = ['open', 'in-progress', 'resolved', 'escalated', 'acknowledged'];
const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];

const REQUIRED_ITEM_FIELDS = [
  { name: 'id', type: 'string' },
  { name: 'title', type: 'string' },
  { name: 'status', type: 'string', enum: VALID_STATUSES },
  { name: 'created', type: 'string' },
];

const OPTIONAL_ITEM_FIELDS = [
  { name: 'body', type: 'string' },
  { name: 'source', type: 'string' },
  { name: 'priority', type: 'string', enum: VALID_PRIORITIES },
  { name: 'updated', type: 'string' },
  { name: 'resolved', type: 'string' },
  { name: 'original_filed', type: 'string' },
  { name: 'escalation_history', type: 'array' },
  { name: 'audit_note', type: 'string' },
];

// --- Main ---

let rawText;
try {
  rawText = readFileSync(filePath, 'utf8');
} catch (e) {
  console.log(`[hr-validate] SKIP: ${filePath} not found`);
  process.exit(0);
}

// Phase 1: duplicate keys
const dupes = findDuplicateKeys(rawText);
for (const d of dupes) {
  issues.push(`DUPLICATE KEY: "${d.key}" at line ${d.dupeLine} (first seen line ${d.firstLine})`);
}

// Phase 2: schema
let data;
try {
  data = JSON.parse(rawText);
} catch (e) {
  issues.push(`PARSE ERROR: ${e.message}`);
  console.log(`[hr-validate] ${issues.length} issue(s):`);
  issues.forEach(i => console.log(`  - ${i}`));
  process.exit(1);
}

// Top-level structure
if (typeof data !== 'object' || data === null || Array.isArray(data)) {
  issues.push('Top-level must be an object');
} else {
  if (!Array.isArray(data.items)) {
    issues.push('Missing or non-array "items" field');
  } else {
    // Validate each item
    const ids = new Set();
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      const prefix = `items[${i}]`;

      if (typeof item !== 'object' || item === null) {
        issues.push(`${prefix}: not an object`);
        continue;
      }

      // Required fields
      for (const field of REQUIRED_ITEM_FIELDS) {
        if (!(field.name in item)) {
          issues.push(`${prefix}: missing required field "${field.name}"`);
        } else if (typeof item[field.name] !== field.type) {
          issues.push(`${prefix}.${field.name}: expected ${field.type}, got ${typeof item[field.name]}`);
        } else if (field.enum && !field.enum.includes(item[field.name])) {
          issues.push(`${prefix}.${field.name}: invalid value "${item[field.name]}" (expected: ${field.enum.join(', ')})`);
        }
      }

      // Optional fields type check
      for (const field of OPTIONAL_ITEM_FIELDS) {
        if (field.name in item) {
          const val = item[field.name];
          if (field.type === 'array') {
            if (!Array.isArray(val)) {
              issues.push(`${prefix}.${field.name}: expected array, got ${typeof val}`);
            }
          } else if (typeof val !== field.type) {
            issues.push(`${prefix}.${field.name}: expected ${field.type}, got ${typeof val}`);
          }
          if (field.enum && typeof val === 'string' && !field.enum.includes(val)) {
            issues.push(`${prefix}.${field.name}: invalid value "${val}" (expected: ${field.enum.join(', ')})`);
          }
        }
      }

      // Duplicate ID check
      if (item.id) {
        if (ids.has(item.id)) {
          issues.push(`${prefix}: duplicate item id "${item.id}"`);
        }
        ids.add(item.id);
      }

      // Date format validation (ISO 8601-ish)
      for (const dateField of ['created', 'updated', 'resolved']) {
        if (item[dateField] && typeof item[dateField] === 'string') {
          if (!/^\d{4}-\d{2}-\d{2}/.test(item[dateField])) {
            issues.push(`${prefix}.${dateField}: not a valid date format "${item[dateField]}"`);
          }
        }
      }
    }
  }
}

// Output
if (issues.length === 0) {
  console.log(`[hr-validate] OK: ${data?.items?.length ?? 0} item(s), no issues`);
  process.exit(0);
} else {
  console.log(`[hr-validate] ${issues.length} issue(s):`);
  issues.forEach(i => console.log(`  - ${i}`));
  process.exit(1);
}

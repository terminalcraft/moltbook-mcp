#!/usr/bin/env node
// schema-check.mjs — Validate and auto-migrate JSON state files
// Created: B#372 (wq-454)
//
// Checks critical state files against expected schemas.
// Auto-migrates missing fields with sensible defaults.
// Intended to run as a pre-session hook or on-demand.
//
// Usage: node schema-check.mjs [--fix] [--quiet]
//   --fix   Apply migrations (default: dry-run)
//   --quiet Only print errors/migrations

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const REPO_DIR = join(process.env.HOME, 'moltbook-mcp');
const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const QUIET = args.includes('--quiet');

// Schema definitions: { file, type, fields (for objects), itemFields (for array items) }
// Each field: { name, type, default, required }
const SCHEMAS = [
  {
    file: join(REPO_DIR, 'directive-outcomes.json'),
    type: 'object',
    fields: [
      { name: 'version', type: 'number', required: true },
      { name: 'outcomes', type: 'array', required: true },
    ],
    itemFields: {
      path: 'outcomes',
      fields: [
        { name: 'sessionNum', type: 'number', required: true },
        { name: 'sessionType', type: 'string', required: false },
        { name: 'mode', type: 'string', required: true, default: 'unknown' },
        { name: 'session', type: 'number', required: false, default: 0 },
        { name: 'outcome', type: 'string', required: false },
      ],
    },
  },
  {
    file: join(STATE_DIR, 'session-outcomes.json'),
    type: 'array',
    itemFields: {
      fields: [
        { name: 'session', type: 'number', required: true },
        { name: 'mode', type: 'string', required: true, default: 'unknown' },
        { name: 'outcome', type: 'string', required: true, default: 'unknown' },
        { name: 'timestamp', type: 'string', required: false },
        { name: 'cost_usd', type: 'number', required: false },
      ],
    },
  },
  {
    file: join(STATE_DIR, 'engagement-intel.json'),
    type: 'array',
    itemFields: {
      fields: [
        { name: 'session', type: 'number', required: true },
        { name: 'platform', type: 'string', required: false },
        { name: 'type', type: 'string', required: false },
      ],
    },
  },
  {
    file: join(REPO_DIR, 'work-queue.json'),
    type: 'object',
    fields: [
      { name: 'version', type: 'number', required: true },
      { name: 'queue', type: 'array', required: true },
    ],
    itemFields: {
      path: 'queue',
      fields: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string', required: true },
        { name: 'status', type: 'string', required: true, default: 'pending' },
        { name: 'priority', type: 'number', required: false },
        { name: 'added', type: 'string', required: false },
      ],
    },
  },
  {
    file: join(STATE_DIR, 'engagement-state.json'),
    type: 'object',
    fields: [
      { name: 'seen', type: 'object', required: false, default: {} },
      { name: 'commented', type: 'object', required: false, default: {} },
      { name: 'myPosts', type: 'object', required: false, default: {} },
      { name: 'myComments', type: 'object', required: false, default: {} },
    ],
  },
  {
    file: join(STATE_DIR, 'rotation-state.json'),
    type: 'object',
    fields: [
      { name: 'session_counter', type: 'number', required: true },
      { name: 'rotation_index', type: 'number', required: true },
    ],
  },
];

let totalIssues = 0;
let totalMigrations = 0;

function log(msg) {
  if (!QUIET) console.log(msg);
}

function warn(msg) {
  console.log(`  ⚠ ${msg}`);
  totalIssues++;
}

function migrate(msg) {
  console.log(`  → ${msg}`);
  totalMigrations++;
}

for (const schema of SCHEMAS) {
  const shortName = schema.file.replace(process.env.HOME, '~');

  if (!existsSync(schema.file)) {
    log(`${shortName}: SKIP (not found)`);
    continue;
  }

  let data;
  try {
    data = JSON.parse(readFileSync(schema.file, 'utf8'));
  } catch (e) {
    warn(`${shortName}: PARSE ERROR — ${e.message}`);
    continue;
  }

  log(`${shortName}:`);
  let modified = false;

  // Type check
  const actualType = Array.isArray(data) ? 'array' : typeof data;
  if (actualType !== schema.type) {
    warn(`expected ${schema.type}, got ${actualType}`);
    continue;
  }

  // Top-level field checks (for objects)
  if (schema.fields && schema.type === 'object') {
    for (const field of schema.fields) {
      if (!(field.name in data)) {
        if (field.required) {
          warn(`missing required field '${field.name}'`);
        } else if (field.default !== undefined && FIX) {
          data[field.name] = field.default;
          migrate(`added '${field.name}' = ${JSON.stringify(field.default)}`);
          modified = true;
        }
      } else {
        const valType = Array.isArray(data[field.name]) ? 'array' : typeof data[field.name];
        if (valType !== field.type) {
          warn(`'${field.name}' expected ${field.type}, got ${valType}`);
        }
      }
    }
  }

  // Item-level field checks (for arrays or nested arrays)
  if (schema.itemFields) {
    const items = schema.itemFields.path
      ? data[schema.itemFields.path]
      : data;

    if (Array.isArray(items)) {
      let itemIssues = 0;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (typeof item !== 'object' || item === null) continue;

        for (const field of schema.itemFields.fields) {
          if (!(field.name in item)) {
            if (field.required && field.default !== undefined) {
              if (FIX) {
                item[field.name] = field.default;
                modified = true;
                itemIssues++;
              } else {
                itemIssues++;
              }
            } else if (field.required) {
              itemIssues++;
            }
          }
        }
      }
      if (itemIssues > 0) {
        if (FIX) {
          migrate(`fixed ${itemIssues} missing fields across ${items.length} items`);
        } else {
          warn(`${itemIssues} missing fields across ${items.length} items (use --fix to migrate)`);
        }
      } else {
        log('  ✓ all items valid');
      }
    }
  }

  if (!schema.itemFields && !totalIssues) {
    log('  ✓ valid');
  }

  // Write back if modified
  if (modified && FIX) {
    writeFileSync(schema.file, JSON.stringify(data, null, 2) + '\n');
    log(`  ✓ written`);
  }
}

console.log(`\nSchema check: ${totalIssues} issues, ${totalMigrations} migrations${FIX ? ' applied' : ' (dry-run)'}`);
process.exit(totalIssues > 0 && !FIX ? 1 : 0);

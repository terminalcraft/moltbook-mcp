#!/usr/bin/env node
// queue-staleness-check.mjs — Detect stale queue item descriptions
// Checks pending items against current file state to flag already-done work.
// Usage: node queue-staleness-check.mjs [--json]

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const HOME = process.env.HOME || '/home/moltbot';
const QUEUE_PATH = join(HOME, 'moltbook-mcp/work-queue.json');
const MCP_DIR = join(HOME, 'moltbook-mcp');

// Staleness detection rules
const RULES = [
  {
    name: 'test-exists',
    description: 'Claims no tests but test file exists',
    match: (item) => {
      const text = `${item.title} ${item.description || ''}`.toLowerCase();
      // Detect claims like "no test", "zero test", "untested", "add test coverage"
      if (!/(no test|zero test|untested|add test coverage|missing test)/.test(text)) return null;

      // Extract component names mentioned
      const components = extractComponentNames(text);
      const staleComponents = [];

      for (const comp of components) {
        const testPatterns = [
          `${comp}.test.mjs`,
          `${comp}.test.js`,
          `components/${comp}.test.js`,
          `components/${comp}.test.mjs`
        ];
        for (const pattern of testPatterns) {
          if (existsSync(join(MCP_DIR, pattern))) {
            staleComponents.push({ component: comp, testFile: pattern });
          }
        }
      }

      if (staleComponents.length > 0) {
        return {
          rule: 'test-exists',
          detail: `Test files already exist for: ${staleComponents.map(c => c.component).join(', ')}`,
          evidence: staleComponents.map(c => c.testFile)
        };
      }
      return null;
    }
  },
  {
    name: 'file-exists',
    description: 'References building a file that already exists',
    match: (item) => {
      const text = `${item.title} ${item.description || ''}`.toLowerCase();
      // Extract .mjs/.js filenames mentioned in "build X" patterns
      const buildMatch = text.match(/build\s+([\w-]+\.(?:mjs|js|sh))/g);
      if (!buildMatch) return null;

      const staleFiles = [];
      for (const m of buildMatch) {
        const filename = m.replace(/^build\s+/, '');
        if (existsSync(join(MCP_DIR, filename))) {
          staleFiles.push(filename);
        }
      }

      if (staleFiles.length > 0) {
        return {
          rule: 'file-exists',
          detail: `Files already exist: ${staleFiles.join(', ')}`,
          evidence: staleFiles
        };
      }
      return null;
    }
  },
  {
    name: 'done-reference',
    description: 'References a task ID that is already done',
    match: (item) => {
      const text = `${item.title} ${item.description || ''}`.toLowerCase();
      const refMatches = text.match(/wq-(\d+)/g);
      if (!refMatches) return null;

      const queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf8')).queue;
      const doneRefs = [];

      for (const ref of refMatches) {
        const id = ref;
        if (id === item.id) continue; // skip self-reference
        const referenced = queue.find(q => q.id === id);
        if (referenced && referenced.status === 'done') {
          doneRefs.push(id);
        }
      }

      if (doneRefs.length > 0) {
        return {
          rule: 'done-reference',
          detail: `References completed items: ${doneRefs.join(', ')}`,
          evidence: doneRefs
        };
      }
      return null;
    }
  },
  {
    name: 'endpoint-exists',
    description: 'Describes building an endpoint that already exists',
    match: (item) => {
      const text = `${item.title} ${item.description || ''}`.toLowerCase();
      // Look for "endpoint" or "api" in description
      const endpointMatch = text.match(/\/status\/[\w-]+|\/[\w-]+\s+endpoint/g);
      if (!endpointMatch) return null;

      // Check api.mjs for existing routes
      const apiPath = join(MCP_DIR, 'api.mjs');
      if (!existsSync(apiPath)) return null;
      const apiContent = readFileSync(apiPath, 'utf8').toLowerCase();

      const existingEndpoints = [];
      for (const ep of endpointMatch) {
        const path = ep.replace(/\s+endpoint$/, '');
        if (apiContent.includes(path)) {
          existingEndpoints.push(path);
        }
      }

      if (existingEndpoints.length > 0) {
        return {
          rule: 'endpoint-exists',
          detail: `Endpoints already exist: ${existingEndpoints.join(', ')}`,
          evidence: existingEndpoints
        };
      }
      return null;
    }
  }
];

function extractComponentNames(text) {
  // Extract common component name patterns
  const names = new Set();

  // Match explicit component names like "mention-aggregator", "clawball"
  const componentPatterns = readdirSync(join(MCP_DIR, 'components')).map(f =>
    f.replace(/\.js$/, '')
  );

  // Sort by length descending to match longer names first, avoiding partial matches
  componentPatterns.sort((a, b) => b.length - a.length);
  for (const comp of componentPatterns) {
    // Use word boundary-like check to avoid "dev" matching inside "devaintart"
    const re = new RegExp(`(?:^|[\\s,/])${comp.replace(/-/g, '[-\\s]')}(?:$|[\\s,./])`, 'i');
    if (re.test(text)) {
      names.add(comp);
    }
  }

  // Also check for .mjs files mentioned
  const mjsMatch = text.match(/[\w-]+\.mjs/g);
  if (mjsMatch) {
    for (const m of mjsMatch) {
      names.add(m.replace('.mjs', ''));
    }
  }

  return [...names];
}

function checkStaleness() {
  if (!existsSync(QUEUE_PATH)) {
    return { error: 'work-queue.json not found' };
  }

  const queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf8')).queue;
  const pending = queue.filter(i => i.status === 'pending');
  const results = [];

  for (const item of pending) {
    const findings = [];
    for (const rule of RULES) {
      try {
        const result = rule.match(item);
        if (result) {
          findings.push(result);
        }
      } catch (e) {
        // Rule failed — skip silently
      }
    }

    if (findings.length > 0) {
      results.push({
        id: item.id,
        title: item.title.slice(0, 80),
        findings
      });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    checkedCount: pending.length,
    staleCount: results.length,
    items: results
  };
}

// CLI
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const result = checkStaleness();

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`=== Queue Staleness Check ===\n`);
  console.log(`Checked ${result.checkedCount} pending items\n`);

  if (result.staleCount === 0) {
    console.log('No stale items detected.');
  } else {
    console.log(`Found ${result.staleCount} potentially stale item(s):\n`);
    for (const item of result.items) {
      console.log(`  ${item.id}: ${item.title}`);
      for (const f of item.findings) {
        console.log(`    ⚠ [${f.rule}] ${f.detail}`);
      }
      console.log();
    }
  }
}

export { checkStaleness, extractComponentNames, RULES };

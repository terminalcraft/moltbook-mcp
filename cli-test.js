#!/usr/bin/env node
/**
 * MCP CLI Test Harness
 *
 * Invoke MCP tools directly from the command line without a full client.
 *
 * Usage:
 *   node cli-test.js list                          # List all available tools
 *   node cli-test.js call <tool> [--param value]   # Call a tool with params
 *   node cli-test.js call moltbook_state --format compact
 *   node cli-test.js call knowledge_read --format full --category architecture
 *   node cli-test.js describe <tool>               # Show tool schema
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "fs";
import { join } from "path";

import { setApiKey } from "./providers/api.js";
import { wrapServerTool } from "./transforms/scoping.js";

import { register as registerCore } from "./components/moltbook-core.js";
import { register as registerEngagement } from "./components/engagement.js";
import { register as registerKnowledge } from "./components/knowledge.js";
import { register as registerExternal } from "./components/external.js";
import { register as registerBsky } from "./components/bsky.js";

const server = new McpServer({ name: "moltbook", version: "1.4.0" });
wrapServerTool(server);
registerCore(server);
registerEngagement(server);
registerKnowledge(server);
registerExternal(server);
registerBsky(server);

// Load API key
let apiKey = process.env.MOLTBOOK_API_KEY;
if (!apiKey) {
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    apiKey = JSON.parse(readFileSync(join(home, ".config", "moltbook", "credentials.json"), "utf8")).api_key;
  } catch {}
}
if (apiKey) setApiKey(apiKey);

const tools = server._registeredTools;
const args = process.argv.slice(2);
const command = args[0];

function parseArgs(args) {
  const params = {};
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) {
        params[key] = true;
        i++;
      } else {
        // Try to parse as JSON for arrays/objects/numbers/booleans
        try { params[key] = JSON.parse(val); } catch { params[key] = val; }
        i += 2;
      }
    } else {
      i++;
    }
  }
  return params;
}

function printToolList() {
  const names = Object.keys(tools).sort();
  console.log(`${names.length} tools available:\n`);
  for (const name of names) {
    const t = tools[name];
    const desc = t.description || "";
    console.log(`  ${name.padEnd(30)} ${desc.slice(0, 60)}`);
  }
}

function printToolSchema(name) {
  const t = tools[name];
  if (!t) { console.error(`Tool "${name}" not found.`); process.exit(1); }
  console.log(`Tool: ${name}`);
  console.log(`Description: ${t.description || "(none)"}`);
  if (t.inputSchema) {
    console.log(`\nInput schema:`);
    console.log(JSON.stringify(t.inputSchema, null, 2));
  }
  if (t.annotations) {
    console.log(`\nAnnotations: ${JSON.stringify(t.annotations)}`);
  }
}

async function callTool(name, params) {
  const t = tools[name];
  if (!t) { console.error(`Tool "${name}" not found.`); process.exit(1); }

  try {
    // The handler expects (extra: {}) with the params merged in
    // Based on MCP SDK internals, the handler receives the parsed params object
    const result = await t.handler(params, {});

    if (result && result.content) {
      for (const item of result.content) {
        if (item.type === "text") console.log(item.text);
        else console.log(JSON.stringify(item, null, 2));
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

if (!command || command === "help" || command === "-h" || command === "--help") {
  console.log(`MCP CLI Test Harness

Usage:
  node cli-test.js list                          List all tools
  node cli-test.js describe <tool>               Show tool schema
  node cli-test.js call <tool> [--param value]   Call a tool

Examples:
  node cli-test.js call moltbook_state --format compact
  node cli-test.js call knowledge_read --format digest
  node cli-test.js call chatr_agents`);
} else if (command === "list") {
  printToolList();
} else if (command === "describe") {
  printToolSchema(args[1]);
} else if (command === "call") {
  const toolName = args[1];
  if (!toolName) { console.error("Usage: node cli-test.js call <tool> [--param value]"); process.exit(1); }
  const params = parseArgs(args.slice(2));
  callTool(toolName, params).catch(e => { console.error(e); process.exit(1); });
} else {
  console.error(`Unknown command: ${command}. Use "help" for usage.`);
  process.exit(1);
}

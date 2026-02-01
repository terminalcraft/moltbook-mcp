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
 *   node cli-test.js repl                           # Interactive REPL mode
 *   node cli-test.js call <tool> --json [--params]  # JSON output for scripting
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
  let jsonOutput = false;
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--json") {
      jsonOutput = true;
      i++;
    } else if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) {
        params[key] = true;
        i++;
      } else {
        try { params[key] = JSON.parse(val); } catch { params[key] = val; }
        i += 2;
      }
    } else {
      i++;
    }
  }
  return { params, jsonOutput };
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

async function callTool(name, params, jsonOutput = false) {
  const t = tools[name];
  if (!t) { console.error(`Tool "${name}" not found.`); return false; }

  try {
    const result = await t.handler(params, {});

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result && result.content) {
      for (const item of result.content) {
        if (item.type === "text") console.log(item.text);
        else console.log(JSON.stringify(item, null, 2));
      }
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return true;
  } catch (e) {
    console.error(`Error: ${e.message}`);
    return false;
  }
}

async function repl() {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => new Promise(resolve => rl.question("mcp> ", resolve));

  console.log("MCP REPL — type tool names with params, or 'list', 'help', 'exit'");
  while (true) {
    const line = (await prompt()).trim();
    if (!line) continue;
    if (line === "exit" || line === "quit" || line === ".exit") { rl.close(); break; }
    if (line === "list") { printToolList(); continue; }
    if (line === "help") {
      console.log("Commands: list, exit, help, <tool> [--param value ...], describe <tool>");
      continue;
    }
    if (line.startsWith("describe ")) { printToolSchema(line.slice(9).trim()); continue; }

    const parts = line.split(/\s+/);
    const toolName = parts[0];
    const { params, jsonOutput } = parseArgs(parts.slice(1));
    await callTool(toolName, params, jsonOutput);
  }
}

if (!command || command === "help" || command === "-h" || command === "--help") {
  console.log(`MCP CLI Test Harness

Usage:
  node cli-test.js list                          List all tools
  node cli-test.js describe <tool>               Show tool schema
  node cli-test.js call <tool> [--param value]   Call a tool
  node cli-test.js repl                          Interactive REPL

Flags:
  --json    Output raw JSON (for scripting)

Examples:
  node cli-test.js call moltbook_state --format compact
  node cli-test.js call knowledge_read --format digest --json
  node cli-test.js call chatr_agents`);
} else if (command === "list") {
  printToolList();
} else if (command === "describe") {
  printToolSchema(args[1]);
} else if (command === "repl") {
  repl().catch(e => { console.error(e); process.exit(1); });
} else if (command === "call") {
  const toolName = args[1];
  if (!toolName) { console.error("Usage: node cli-test.js call <tool> [--param value]"); process.exit(1); }
  const { params, jsonOutput } = parseArgs(args.slice(2));
  callTool(toolName, params, jsonOutput).then(ok => { if (!ok) process.exit(1); }).catch(e => { console.error(e); process.exit(1); });
} else {
  console.error(`Unknown command: ${command}. Use "help" for usage.`);
  process.exit(1);
}

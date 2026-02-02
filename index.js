#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { setApiKey, saveApiSession, getApiCallCount } from "./providers/api.js";
import { wrapServerTool, saveToolUsage } from "./transforms/scoping.js";
import { installReplayLog } from "./providers/replay-log.js";

// Install fetch instrumentation before any components load (wq-014)
installReplayLog();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_NUM = parseInt(process.env.SESSION_NUM || "0", 10);
const server = new McpServer({ name: "moltbook", version: "1.95.0" });

// Apply transforms: session scoping + tool usage tracking
wrapServerTool(server);

// Manifest-driven component loader (R#95: replaces 18 manual import/register pairs)
// Add or remove components by editing components.json — no index.js changes needed.
const manifest = JSON.parse(readFileSync(join(__dirname, "components.json"), "utf8"));
const loadErrors = [];

for (const name of manifest.active) {
  try {
    const mod = await import(`./components/${name}.js`);
    if (typeof mod.register === "function") {
      mod.register(server);
    } else {
      loadErrors.push(`${name}: no register() export`);
    }
  } catch (err) {
    loadErrors.push(`${name}: ${err.message}`);
  }
}

if (loadErrors.length > 0) {
  console.error(`[moltbook] Component load errors:\n  ${loadErrors.join("\n  ")}`);
}

// Save API history on exit
process.on("exit", () => { if (getApiCallCount() > 0) saveApiSession(); saveToolUsage(); });
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());

async function main() {
  let apiKey = process.env.MOLTBOOK_API_KEY;
  if (!apiKey) {
    try {
      const home = process.env.HOME || process.env.USERPROFILE;
      apiKey = JSON.parse(readFileSync(join(home, ".config", "moltbook", "credentials.json"), "utf8")).api_key;
    } catch {}
  }
  if (apiKey) setApiKey(apiKey);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);

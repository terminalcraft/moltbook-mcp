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

// Manifest-driven component loader (R#95, R#99: session-type-aware loading)
// Components declare which session types need them via "sessions" field in components.json.
// Omit "sessions" to load always. SESSION_TYPE env var controls filtering.
const manifest = JSON.parse(readFileSync(join(__dirname, "components.json"), "utf8"));
const sessionType = (process.env.SESSION_TYPE || "").toUpperCase();
const loadErrors = [];
let loadedCount = 0;

for (const entry of manifest.active) {
  const name = typeof entry === "string" ? entry : entry.name;
  const sessions = typeof entry === "object" && entry.sessions ? entry.sessions.toUpperCase() : null;
  // Skip if session type is known and component doesn't list it
  if (sessionType && sessions && !sessions.includes(sessionType)) continue;
  try {
    const mod = await import(`./components/${name}.js`);
    if (typeof mod.register === "function") {
      mod.register(server);
      loadedCount++;
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
if (sessionType) {
  console.error(`[moltbook] Session ${sessionType}: loaded ${loadedCount}/${manifest.active.length} components`);
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

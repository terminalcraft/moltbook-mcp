#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { join } from "path";

import { setApiKey, saveApiSession, getApiCallCount } from "./providers/api.js";
import { wrapServerTool, saveToolUsage } from "./transforms/scoping.js";

// Component registrations
import { register as registerCore } from "./components/moltbook-core.js";
import { register as registerEngagement } from "./components/engagement.js";
import { register as registerKnowledge } from "./components/knowledge.js";
import { register as registerExternal } from "./components/external.js";
import { register as registerBsky } from "./components/bsky.js";
import { register as registerFourclaw } from "./components/fourclaw.js";
import { register as registerRegistry } from "./components/registry.js";
import { register as registerLeaderboard } from "./components/leaderboard.js";
import { register as registerIdentity } from "./components/identity.js";

const SESSION_NUM = parseInt(process.env.SESSION_NUM || "0", 10);
const server = new McpServer({ name: "moltbook", version: "1.22.0" });

// Apply transforms: session scoping + tool usage tracking
wrapServerTool(server);

// Register all tool components
registerCore(server);
registerEngagement(server);
registerKnowledge(server);
registerExternal(server);
registerBsky(server);
registerFourclaw(server);
registerRegistry(server);
registerLeaderboard(server);
registerIdentity(server);

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

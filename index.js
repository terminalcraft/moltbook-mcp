#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { join } from "path";

import { setApiKey, saveApiSession, getApiCallCount } from "./providers/api.js";
import { wrapServerTool, saveToolUsage } from "./transforms/scoping.js";

// Active component registrations (zero-usage MCP wrappers removed in s410)
import { register as registerCore } from "./components/moltbook-core.js";
import { register as registerEngagement } from "./components/engagement.js";
import { register as registerKnowledge } from "./components/knowledge.js";
import { register as registerExternal } from "./components/external.js";
import { register as registerFourclaw } from "./components/fourclaw.js";
import { register as registerRegistry } from "./components/registry.js";
import { register as registerLeaderboard } from "./components/leaderboard.js";
import { register as registerKV } from "./components/kv.js";
import { register as registerCron } from "./components/cron.js";
import { register as registerPolls } from "./components/polls.js";
import { register as registerBadges } from "./components/badges.js";
import { register as registerWebhooks } from "./components/webhooks.js";
import { register as registerColony } from "./components/colony.js";
import { register as registerLobchan } from "./components/lobchan.js";
import { register as registerMDI } from "./components/mdi.js";

const SESSION_NUM = parseInt(process.env.SESSION_NUM || "0", 10);
const server = new McpServer({ name: "moltbook", version: "1.83.0" });

// Apply transforms: session scoping + tool usage tracking
wrapServerTool(server);

// Register active tool components
registerCore(server);
registerEngagement(server);
registerKnowledge(server);
registerExternal(server);
registerFourclaw(server);
registerRegistry(server);
registerLeaderboard(server);
registerKV(server);
registerCron(server);
registerPolls(server);
registerBadges(server);
registerWebhooks(server);
registerColony(server);
registerLobchan(server);
registerMDI(server);

// Retired MCP wrappers (s410 dead code audit — 0 calls across 410 sessions):
// bsky, identity, paste, shortener, pubsub, rooms, tasks, monitors,
// notifications, buildlog, digest, snapshots, presence, reputation,
// backups, smoke-tests, handoff, projects
// Note: API routes in api.mjs still serve these features via HTTP.

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

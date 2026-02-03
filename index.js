#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { setApiKey, saveApiSession, getApiCallCount } from "./providers/api.js";
import { wrapServerTool, saveToolUsage } from "./transforms/scoping.js";
import { installReplayLog } from "./providers/replay-log.js";

// Install fetch instrumentation before any components load (wq-014)
installReplayLog();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_NUM = parseInt(process.env.SESSION_NUM || "0", 10);
const SESSION_TYPE = (process.env.SESSION_TYPE || "").toUpperCase();
const server = new McpServer({ name: "moltbook", version: "1.95.0" });

// Apply transforms: session scoping + tool usage tracking
wrapServerTool(server);

// --- Session context object (R#104) ---
// Previously components only received `server` via register(). Now they receive a
// context object with session metadata, enabling context-aware initialization.
// Components can use this for conditional logic without re-reading env vars or files.
// Also supports lifecycle hooks: onLoad(ctx) after registration, onUnload() at shutdown.
const sessionContext = {
  sessionNum: SESSION_NUM,
  sessionType: SESSION_TYPE,
  dir: __dirname,
  stateDir: join(process.env.HOME || '', '.config/moltbook'),
  budgetCap: parseFloat(process.env.BUDGET_CAP || '10'),
  // Lazy-load pre-computed context from session-context.mjs output
  _precomputed: null,
  get precomputed() {
    if (this._precomputed === null) {
      const envPath = join(this.stateDir, 'session-context.env');
      if (existsSync(envPath)) {
        try {
          const raw = readFileSync(envPath, 'utf8');
          this._precomputed = {};
          for (const line of raw.split('\n')) {
            const match = line.match(/^CTX_([A-Z_]+)=(.*)$/);
            if (match) {
              let val = match[2];
              if (val.startsWith("$'") && val.endsWith("'")) {
                val = val.slice(2, -1).replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
              } else if (val.startsWith("'") && val.endsWith("'")) {
                val = val.slice(1, -1).replace(/'\\'''/g, "'");
              }
              this._precomputed[match[1].toLowerCase()] = val;
            }
          }
        } catch { this._precomputed = {}; }
      } else {
        this._precomputed = {};
      }
    }
    return this._precomputed;
  }
};

// Track loaded modules for lifecycle management
const loadedModules = [];
// Track lifecycle hook execution (wq-100)
const lifecycleStatus = {
  hasOnLoad: [],
  onLoadSuccess: [],
  onLoadFailed: [],
  hasOnUnload: [],
  onUnloadSuccess: [],
  onUnloadFailed: []
};

// --- Component-tool ownership tracking (R#113) ---
// Maps component names to the tools they registered. Enables per-component
// health analysis, tool ownership display, and debugging which component
// owns which tool. This is tracked by proxying server.tool() during component
// registration to intercept tool names.
const componentToolMap = {};

// Create a server proxy that tracks which tools a component registers
function createToolTrackingProxy(componentName) {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'tool') {
        return function(name, ...args) {
          // Track this tool as belonging to the component
          if (!componentToolMap[componentName]) {
            componentToolMap[componentName] = [];
          }
          componentToolMap[componentName].push(name);
          // Call the original tool registration
          return target.tool(name, ...args);
        };
      }
      // Pass through all other properties/methods unchanged
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });
}

// Manifest-driven component loader (R#95, R#99: session-type-aware loading)
// R#104: Components now receive context object, can export onLoad/onUnload lifecycle hooks.
const manifest = JSON.parse(readFileSync(join(__dirname, "components.json"), "utf8"));
const loadErrors = [];
let loadedCount = 0;

for (const entry of manifest.active) {
  const name = typeof entry === "string" ? entry : entry.name;
  const sessions = typeof entry === "object" && entry.sessions ? entry.sessions.toUpperCase() : null;
  if (SESSION_TYPE && sessions && !sessions.includes(SESSION_TYPE)) continue;
  try {
    const mod = await import(`./components/${name}.js`);
    if (typeof mod.register === "function") {
      // Pass a tracking proxy that intercepts tool() calls to map tools to components (R#113)
      const trackedServer = createToolTrackingProxy(name);
      mod.register(trackedServer, sessionContext);
      loadedModules.push({ name, mod });
      loadedCount++;
    } else {
      loadErrors.push(`${name}: no register() export`);
    }
  } catch (err) {
    loadErrors.push(`${name}: ${err.message}`);
  }
}

// Call onLoad lifecycle hook for components that export it (wq-100: track status)
for (const { name, mod } of loadedModules) {
  if (typeof mod.onLoad === "function") {
    lifecycleStatus.hasOnLoad.push(name);
    try {
      await mod.onLoad(sessionContext);
      lifecycleStatus.onLoadSuccess.push(name);
    } catch (err) {
      lifecycleStatus.onLoadFailed.push({ name, error: err.message });
      loadErrors.push(`${name}.onLoad: ${err.message}`);
    }
  }
  if (typeof mod.onUnload === "function") {
    lifecycleStatus.hasOnUnload.push(name);
  }
}

if (loadErrors.length > 0) {
  console.error(`[moltbook] Component load errors:\n  ${loadErrors.join("\n  ")}`);
}
if (SESSION_TYPE) {
  console.error(`[moltbook] Session ${SESSION_TYPE}: loaded ${loadedCount}/${manifest.active.length} components`);
}

// Write component status for /status/components endpoint (wq-088, wq-100: lifecycle, R#113: tool ownership)
try {
  const componentStatus = {
    timestamp: new Date().toISOString(),
    sessionNum: SESSION_NUM,
    sessionType: SESSION_TYPE,
    loaded: loadedModules.map(m => m.name),
    loadedCount,
    totalActive: manifest.active.length,
    errors: loadErrors,
    manifest: manifest.active.map(e => typeof e === "string" ? { name: e } : e),
    lifecycle: lifecycleStatus,
    // R#113: Component-tool ownership map for debugging and analytics
    toolOwnership: componentToolMap,
    toolStats: {
      totalTools: Object.values(componentToolMap).flat().length,
      byComponent: Object.fromEntries(
        Object.entries(componentToolMap).map(([c, tools]) => [c, tools.length])
      )
    }
  };
  writeFileSync(join(__dirname, "component-status.json"), JSON.stringify(componentStatus, null, 2));
} catch {}

// Save API history on exit + call component onUnload hooks (wq-100: track status)
process.on("exit", () => {
  if (getApiCallCount() > 0) saveApiSession();
  saveToolUsage();
  // Call onUnload for components that export it
  for (const { name, mod } of loadedModules) {
    if (typeof mod.onUnload === "function") {
      try {
        mod.onUnload();
        lifecycleStatus.onUnloadSuccess.push(name);
      } catch (err) {
        lifecycleStatus.onUnloadFailed.push({ name, error: err.message });
      }
    }
  }
  // Update component-status.json with final lifecycle state
  try {
    const statusPath = join(__dirname, "component-status.json");
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    status.lifecycle = lifecycleStatus;
    status.exitTimestamp = new Date().toISOString();
    writeFileSync(statusPath, JSON.stringify(status, null, 2));
  } catch {}
});
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

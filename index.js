#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { setApiKey, saveApiSession, getApiCallCount } from "./providers/api.js";
import { wrapServerTool, saveToolUsage } from "./transforms/scoping.js";
import { installReplayLog } from "./providers/replay-log.js";
// wq-208: Extracted providers and transforms
import { createSessionContext, computeDirectiveHealth } from "./providers/session-context.js";
import { createDirectiveAssignments, computeDirectiveOutcome, saveDirectiveOutcome } from "./providers/directive-outcome.js";
import { createToolTrackingProxy, componentToolMap, getToolStats } from "./transforms/tool-tracking.js";

// Install fetch instrumentation before any components load (wq-014)
installReplayLog();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_NUM = parseInt(process.env.SESSION_NUM || "0", 10);
const SESSION_TYPE = (process.env.SESSION_TYPE || "").toUpperCase();
const server = new McpServer({ name: "moltbook", version: "1.96.0" });

// Apply transforms: session scoping + tool usage tracking
wrapServerTool(server);

// --- Session context object (R#104, wq-208) ---
// Previously components only received `server` via register(). Now they receive a
// context object with session metadata, enabling context-aware initialization.
// Components can use this for conditional logic without re-reading env vars or files.
// Also supports lifecycle hooks: onLoad(ctx) after registration, onUnload() at shutdown.
// wq-208: Context creation moved to providers/session-context.js
const sessionContext = createSessionContext({
  sessionNum: SESSION_NUM,
  sessionType: SESSION_TYPE,
  baseDir: __dirname,
  budgetCap: parseFloat(process.env.BUDGET_CAP || '10')
});

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

// --- Component-tool ownership tracking (R#113, wq-208) ---
// Maps component names to the tools they registered. Enables per-component
// health analysis, tool ownership display, and debugging which component
// owns which tool. wq-208: Moved to transforms/tool-tracking.js

// R#230: Timeout wrapper for async operations during startup
const IMPORT_TIMEOUT_MS = 5000;
const ONLOAD_TIMEOUT_MS = 3000;
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

// Manifest-driven component loader (R#95, R#99: session-type-aware loading)
// R#104: Components now receive context object, can export onLoad/onUnload lifecycle hooks.
// R#230: Added timeout protection per import and parallel onLoad execution.
const manifest = JSON.parse(readFileSync(join(__dirname, "components.json"), "utf8"));
const loadErrors = [];
let loadedCount = 0;

for (const entry of manifest.active) {
  const name = typeof entry === "string" ? entry : entry.name;
  const sessions = typeof entry === "object" && entry.sessions ? entry.sessions.toUpperCase() : null;
  if (SESSION_TYPE && sessions && !sessions.includes(SESSION_TYPE)) continue;
  try {
    const mod = await withTimeout(import(`./components/${name}.js`), IMPORT_TIMEOUT_MS, `import(${name})`);
    if (typeof mod.register === "function") {
      const trackedServer = createToolTrackingProxy(server, name);
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

// Call onLoad lifecycle hooks in parallel with individual timeouts (R#230)
// onLoad hooks are independent of each other — parallel execution reduces startup latency.
const onLoadEntries = loadedModules.filter(({ mod }) => typeof mod.onLoad === "function");
for (const { name } of onLoadEntries) {
  lifecycleStatus.hasOnLoad.push(name);
}
const onLoadResults = await Promise.allSettled(
  onLoadEntries.map(({ name, mod }) =>
    withTimeout(mod.onLoad(sessionContext), ONLOAD_TIMEOUT_MS, `${name}.onLoad`)
      .then(() => ({ name, ok: true }))
      .catch(err => ({ name, ok: false, error: err.message }))
  )
);
for (const result of onLoadResults) {
  const { name, ok, error } = result.status === "fulfilled" ? result.value : { name: "unknown", ok: false, error: result.reason?.message };
  if (ok) {
    lifecycleStatus.onLoadSuccess.push(name);
  } else {
    lifecycleStatus.onLoadFailed.push({ name, error });
    loadErrors.push(`${name}.onLoad: ${error}`);
  }
}
for (const { name, mod } of loadedModules) {
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
    // R#113, wq-208: Component-tool ownership map for debugging and analytics
    toolOwnership: componentToolMap,
    toolStats: getToolStats()
  };
  writeFileSync(join(__dirname, "component-status.json"), JSON.stringify(componentStatus, null, 2));
} catch {}

// R#119: Write directive health for hooks/prompts to consume
// This enables pre-session hooks and prompt generation to surface directive urgency.
try {
  const health = sessionContext.directiveHealth;
  writeFileSync(join(__dirname, "directive-health.json"), JSON.stringify(health, null, 2));
} catch {}

// --- Directive outcome tracking (R#125, wq-208) ---
// Track which urgent directives were assigned to this session at startup.
// On exit, compare session activity against urgent directives to detect
// systematic non-compliance (e.g., E sessions ignoring d031 for 26+ sessions).
// This creates a feedback loop: A sessions can analyze directive-outcomes.json
// to identify which session types are failing their mandates.
// wq-208: Tracking logic moved to providers/directive-outcome.js
const directiveAssignments = createDirectiveAssignments(
  SESSION_NUM,
  SESSION_TYPE,
  sessionContext.directiveHealth
);

// Save API history on exit + call component onUnload hooks (wq-100: track status)
process.on("exit", () => {
  if (getApiCallCount() > 0) saveApiSession();
  saveToolUsage();
  // R#125, wq-208, wq-459: Compute and save directive outcome for ALL sessions.
  // Previously gated on urgentDirectives.length > 0, which excluded R sessions
  // (whose directives rarely matched R-type keywords). Always recording outcomes
  // gives A sessions complete visibility across all session types.
  try {
    const outcome = computeDirectiveOutcome(directiveAssignments, __dirname);
    saveDirectiveOutcome(directiveAssignments, outcome, __dirname);
  } catch { /* don't block exit */ }
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

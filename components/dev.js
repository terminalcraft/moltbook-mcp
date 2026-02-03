// Development tools for hot-reloading components without MCP server restart (wq-081)
// This component is not session-restricted — available in all session types during dev.

import { readFileSync, existsSync, watch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

// State tracking
let serverRef = null;
let contextRef = null;
let componentToolMap = new Map(); // component name -> Set of tool names
let reloadVersion = new Map();    // component name -> reload count (for cache-busting)

// Track tool registrations by intercepting server.tool()
function trackToolRegistration(componentName, server) {
  const originalTool = server.tool.bind(server);
  const tools = componentToolMap.get(componentName) || new Set();

  return function trackedTool(name, ...args) {
    tools.add(name);
    componentToolMap.set(componentName, tools);
    return originalTool(name, ...args);
  };
}

// Remove all tools registered by a component
function removeComponentTools(componentName, server) {
  const tools = componentToolMap.get(componentName);
  if (!tools) return 0;

  let removed = 0;
  for (const toolName of tools) {
    if (server._registeredTools && server._registeredTools[toolName]) {
      delete server._registeredTools[toolName];
      removed++;
    }
  }
  componentToolMap.delete(componentName);
  return removed;
}

// Hot-reload a component
async function reloadComponent(name) {
  if (!serverRef) {
    return { success: false, error: 'Server not initialized' };
  }

  const componentPath = join(__dirname, `${name}.js`);
  if (!existsSync(componentPath)) {
    return { success: false, error: `Component not found: ${name}` };
  }

  // Get current version for cache-busting
  const version = (reloadVersion.get(name) || 0) + 1;
  reloadVersion.set(name, version);

  // Remove old tools
  const removedCount = removeComponentTools(name, serverRef);

  // Create a proxy server that tracks tool registrations
  const trackedServer = new Proxy(serverRef, {
    get(target, prop) {
      if (prop === 'tool') {
        return trackToolRegistration(name, target);
      }
      return target[prop];
    }
  });

  try {
    // Import with cache-busting query string
    const mod = await import(`${componentPath}?v=${version}`);

    if (typeof mod.register !== 'function') {
      return { success: false, error: `${name}: no register() export` };
    }

    // Re-register component
    mod.register(trackedServer, contextRef);

    // Call onLoad if available
    if (typeof mod.onLoad === 'function') {
      await mod.onLoad(contextRef);
    }

    const newTools = componentToolMap.get(name) || new Set();

    return {
      success: true,
      component: name,
      version,
      removed: removedCount,
      registered: newTools.size,
      tools: [...newTools]
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export function register(server, ctx) {
  serverRef = server;
  contextRef = ctx;

  server.tool(
    'dev_reload',
    'Hot-reload a component without restarting the MCP server. Development only.',
    { component: z.string().describe('Component name (without .js extension)') },
    async ({ component }) => {
      const result = await reloadComponent(component);
      return {
        content: [{
          type: 'text',
          text: result.success
            ? `✓ Reloaded ${result.component} v${result.version}: removed ${result.removed} tools, registered ${result.registered} tools (${result.tools.join(', ')})`
            : `✗ Reload failed: ${result.error}`
        }]
      };
    }
  );

  server.tool(
    'dev_components',
    'List loaded components and their registered tools.',
    {},
    async () => {
      const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'components.json'), 'utf8'));
      const lines = [];

      for (const entry of manifest.active) {
        const name = typeof entry === 'string' ? entry : entry.name;
        const tools = componentToolMap.get(name);
        const sessions = typeof entry === 'object' && entry.sessions ? ` [${entry.sessions}]` : '';

        if (tools && tools.size > 0) {
          lines.push(`${name}${sessions}: ${tools.size} tools`);
        } else {
          lines.push(`${name}${sessions}: (not tracked)`);
        }
      }

      return {
        content: [{
          type: 'text',
          text: `Components:\n${lines.join('\n')}`
        }]
      };
    }
  );
}

export function onLoad(ctx) {
  // Track dev component's own tools
  componentToolMap.set('dev', new Set(['dev_reload', 'dev_components']));
}

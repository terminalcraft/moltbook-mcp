/**
 * Tool Tracking Transform (wq-208)
 *
 * Tracks which component owns which tool during registration.
 * Creates a server proxy that intercepts server.tool() calls to build
 * a component-to-tool ownership map.
 *
 * Enables per-component health analysis, tool ownership display,
 * and debugging which component owns which tool.
 *
 * Extracted from index.js as part of Components/Providers/Transforms refactor.
 */

/**
 * Maps component names to the tools they registered.
 * Populated by createToolTrackingProxy during component registration.
 */
export const componentToolMap = {};

/**
 * Create a server proxy that tracks which tools a component registers.
 * The proxy intercepts tool() calls and records the tool name under the component.
 *
 * @param {Object} server - The MCP server instance
 * @param {string} componentName - Name of the component being registered
 * @returns {Proxy} Proxied server that tracks tool registrations
 */
export function createToolTrackingProxy(server, componentName) {
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

/**
 * Get statistics about registered tools.
 *
 * @returns {Object} Tool statistics
 */
export function getToolStats() {
  return {
    totalTools: Object.values(componentToolMap).flat().length,
    byComponent: Object.fromEntries(
      Object.entries(componentToolMap).map(([c, tools]) => [c, tools.length])
    )
  };
}

/**
 * Reset the tool map (useful for testing).
 */
export function resetToolMap() {
  for (const key of Object.keys(componentToolMap)) {
    delete componentToolMap[key];
  }
}

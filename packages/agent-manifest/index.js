/**
 * agent-manifest — generate agent.json for the knowledge exchange protocol.
 *
 * Protocol spec:
 *   GET /agent.json          → manifest (name, version, capabilities, exchange URLs)
 *   GET /knowledge/patterns  → array of learned patterns
 *   GET /knowledge/digest    → human/agent-readable summary
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

/**
 * Build an agent.json manifest from a project directory.
 *
 * @param {string} dir   — project root (defaults to cwd)
 * @param {object} opts  — overrides: { name, version, github, capabilities, baseUrl }
 * @returns {object}     — the manifest object
 */
export function generateManifest(dir = process.cwd(), opts = {}) {
  dir = resolve(dir);

  // Try to read package.json for defaults
  let pkg = {};
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch {}
  }

  const name = opts.name || pkg.name || "unknown-agent";
  const version = opts.version || pkg.version || "0.0.0";

  // Derive GitHub URL from package.json repository field
  let github = opts.github || "";
  if (!github && pkg.repository) {
    const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url;
    if (repoUrl) {
      github = repoUrl.replace(/\.git$/, "").replace(/^git\+/, "");
    }
  }

  // Detect capabilities from project structure
  const capabilities = opts.capabilities || detectCapabilities(dir);

  const manifest = {
    agent: name,
    version,
    ...(github && { github }),
    capabilities,
    exchange: {
      protocol: "agent-knowledge-exchange-v1",
      patterns_url: "/knowledge/patterns",
      digest_url: "/knowledge/digest",
    },
  };

  return manifest;
}

/**
 * Detect capabilities by scanning common files.
 */
function detectCapabilities(dir) {
  const caps = [];

  // Check for MCP server
  if (existsSync(join(dir, "index.js")) || existsSync(join(dir, "src/index.ts"))) {
    const main = safeRead(join(dir, "index.js")) || safeRead(join(dir, "src/index.ts")) || "";
    if (main.includes("McpServer") || main.includes("@modelcontextprotocol")) {
      caps.push("mcp-server");
    }
  }

  // Check for knowledge directory
  if (existsSync(join(dir, "knowledge")) || existsSync(join(dir, "knowledge/patterns.json"))) {
    caps.push("knowledge-exchange");
  }

  // Check for API server
  const mainFile = safeRead(join(dir, "index.js")) || safeRead(join(dir, "api.js")) || safeRead(join(dir, "server.js")) || "";
  if (mainFile.includes("express") || mainFile.includes("http.createServer") || mainFile.includes("Hono")) {
    caps.push("api-server");
  }

  // Check for Dockerfile
  if (existsSync(join(dir, "Dockerfile")) || existsSync(join(dir, "docker-compose.yml"))) {
    caps.push("containerized");
  }

  if (caps.length === 0) caps.push("general");

  return caps;
}

/**
 * Generate a minimal Express snippet that serves the manifest + knowledge endpoints.
 */
export function generateServerSnippet(manifest) {
  return `// Add these routes to your Express app to enable the knowledge exchange protocol.
// Other agents can then discover and crawl your patterns.

import { readFileSync, existsSync } from "fs";

const manifest = ${JSON.stringify(manifest, null, 2)};

app.get("/agent.json", (req, res) => res.json(manifest));

app.get("/knowledge/patterns", (req, res) => {
  const patternsFile = "./knowledge/patterns.json";
  if (existsSync(patternsFile)) {
    res.json(JSON.parse(readFileSync(patternsFile, "utf8")));
  } else {
    res.json([]);
  }
});

app.get("/knowledge/digest", (req, res) => {
  const digestFile = "./knowledge/digest.md";
  if (existsSync(digestFile)) {
    res.type("text/markdown").send(readFileSync(digestFile, "utf8"));
  } else {
    res.type("text/markdown").send("# Knowledge Digest\\nNo patterns yet.");
  }
});
`;
}

function safeRead(path) {
  try { return existsSync(path) ? readFileSync(path, "utf8") : null; } catch { return null; }
}

# @moltcraft/agent-manifest

Generate `agent.json` manifests for the **agent knowledge exchange protocol** — a simple convention that lets AI agents discover and share learned patterns.

## Quick Start

```bash
npx @moltcraft/agent-manifest          # generate agent.json
npx @moltcraft/agent-manifest --init   # also scaffold knowledge/ dir + server routes
```

## What It Does

Reads your `package.json` and project structure to generate an `agent.json` manifest:

```json
{
  "agent": "your-agent",
  "version": "1.0.0",
  "github": "https://github.com/you/repo",
  "capabilities": ["mcp-server", "knowledge-exchange"],
  "exchange": {
    "protocol": "agent-knowledge-exchange-v1",
    "patterns_url": "/knowledge/patterns",
    "digest_url": "/knowledge/digest"
  }
}
```

With `--init`, it also creates:
- `knowledge/patterns.json` — array of learned patterns
- `knowledge/digest.md` — human/agent-readable summary
- `exchange-routes.js` — Express routes to serve your knowledge endpoints

## Protocol

The agent knowledge exchange protocol defines three endpoints:

| Endpoint | Returns | Purpose |
|----------|---------|---------|
| `GET /agent.json` | JSON manifest | Agent discovery and capability advertisement |
| `GET /knowledge/patterns` | JSON array | Machine-readable learned patterns |
| `GET /knowledge/digest` | Markdown | Human/agent-readable knowledge summary |

Any agent can crawl another's endpoints to discover and merge patterns into their own knowledge base. Patterns carry source attribution, confidence levels, and timestamps for provenance tracking.

## CLI Options

```
--name <name>     Override agent name (default: from package.json)
--version <ver>   Override version
--github <url>    Override GitHub URL
--dir <path>      Specify project directory (default: cwd)
--init            Scaffold knowledge dir and server routes
--help            Show help
```

## Auto-Detection

The CLI detects capabilities from your project:
- `mcp-server` — imports from `@modelcontextprotocol`
- `knowledge-exchange` — has `knowledge/` directory
- `api-server` — uses Express, http, or Hono
- `containerized` — has Dockerfile

## License

MIT

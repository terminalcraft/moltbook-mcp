# @moltcraft/pattern-extractor

Extract documentation files from GitHub repos for agent learning and pattern analysis.

Shallow-clones a repo, reads key documentation files (README.md, CLAUDE.md, AGENTS.md, package.json, etc.), and returns structured content. No code is executed.

## Install

```bash
npm install @moltcraft/pattern-extractor
```

## CLI Usage

```bash
npx @moltcraft/pattern-extractor https://github.com/user/repo
npx @moltcraft/pattern-extractor https://github.com/user/repo --json
```

## Library Usage

```js
import { extractFromRepo, formatExtraction } from "@moltcraft/pattern-extractor";

const result = await extractFromRepo("https://github.com/anthropics/claude-code");
console.log(result.repoSlug);  // "anthropics/claude-code"
console.log(result.commitSha); // "abc1234..."
console.log(result.files);     // [{ name: "README.md", content: "..." }, ...]

// Or get formatted text output
console.log(formatExtraction(result));
```

## API

### `extractFromRepo(githubUrl, options?)`

Clones and extracts documentation from a GitHub repo.

- `githubUrl` — GitHub repo URL
- `options.targets` — Custom list of files/dirs to look for (default: README.md, CLAUDE.md, AGENTS.md, package.json, etc.)
- `options.maxFileSize` — Max bytes per file (default: 50000)
- `options.cloneTimeout` — Git clone timeout in ms (default: 30000)

Returns `{ repoSlug, commitSha, files: [{ name, content }] }`

### `readRepoFiles(dir, options?)`

Read documentation files from an already-cloned repo directory.

### `parseGitHubUrl(url)`

Extract repo slug from a GitHub URL. Returns null if invalid.

### `formatExtraction(result)`

Format extraction result as readable text.

## What It Reads

By default, looks for these files in order:

1. `AGENTS.md` — Agent/LLM development guidelines
2. `CLAUDE.md` — Claude Code project context
3. `.claude/commands/` — Slash command templates
4. `README.md` — Project overview
5. `BRIEFING.md` — Standing directives
6. `CONTRIBUTING.md` — Contribution guidelines
7. `package.json` / `pyproject.toml` / `Cargo.toml` — Project metadata
8. Any other `.md` files in root (up to 5)

Only reads files with allowed extensions (.md, .json, .js, .ts, .py, .sh, .yaml, .yml, .toml, .txt) and under 50KB.

## License

MIT

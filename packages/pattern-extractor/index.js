/**
 * @moltcraft/pattern-extractor
 *
 * Extract documentation files from GitHub repos for pattern analysis.
 * Shallow-clones, reads key files, cleans up. No code execution.
 */

import { execSync } from "child_process";
import { readFileSync, statSync, readdirSync, existsSync } from "fs";
import { join } from "path";

/** Default files to look for in a repo */
const DEFAULT_TARGETS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/commands",
  "README.md",
  "BRIEFING.md",
  "CONTRIBUTING.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
];

/** File extensions we'll read */
const ALLOWED_EXTENSIONS = new Set([
  ".md", ".json", ".js", ".ts", ".py", ".sh",
  ".yaml", ".yml", ".toml", ".txt",
]);

const MAX_FILE_SIZE = 50_000;
const MAX_DIR_ENTRIES = 10;
const MAX_EXTRA_MD = 5;

/**
 * Parse a GitHub URL into a repo slug (e.g. "user/repo").
 * Returns null if invalid.
 */
export function parseGitHubUrl(url) {
  const match = url.match(/github\.com\/([^\/]+\/[^\/\s#?]+)/);
  if (!match) return null;
  return match[1].replace(/\.git$/, "");
}

/**
 * Read files from a cloned repo directory.
 *
 * @param {string} dir - Path to the cloned repo
 * @param {object} [options]
 * @param {string[]} [options.targets] - Files/dirs to look for
 * @param {Set<string>} [options.extensions] - Allowed file extensions
 * @param {number} [options.maxFileSize] - Max bytes per file
 * @returns {{ name: string, content: string }[]}
 */
export function readRepoFiles(dir, options = {}) {
  const targets = options.targets || DEFAULT_TARGETS;
  const extensions = options.extensions || ALLOWED_EXTENSIONS;
  const maxSize = options.maxFileSize || MAX_FILE_SIZE;
  const files = [];

  for (const target of targets) {
    const fullPath = join(dir, target);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        const entries = readdirSync(fullPath);
        for (const entry of entries.slice(0, MAX_DIR_ENTRIES)) {
          const ext = entry.includes(".") ? "." + entry.split(".").pop() : "";
          if (!extensions.has(ext)) continue;
          const entryPath = join(fullPath, entry);
          try {
            const eStat = statSync(entryPath);
            if (eStat.isFile() && eStat.size <= maxSize) {
              files.push({ name: `${target}/${entry}`, content: readFileSync(entryPath, "utf8") });
            }
          } catch {}
        }
      } else if (stat.isFile() && stat.size <= maxSize) {
        files.push({ name: target, content: readFileSync(fullPath, "utf8") });
      }
    } catch {}
  }

  // Extra markdown files in root
  try {
    const rootFiles = readdirSync(dir)
      .filter(f => f.endsWith(".md") && !targets.includes(f));
    for (const f of rootFiles.slice(0, MAX_EXTRA_MD)) {
      const fPath = join(dir, f);
      try {
        const fStat = statSync(fPath);
        if (fStat.isFile() && fStat.size <= maxSize) {
          files.push({ name: f, content: readFileSync(fPath, "utf8") });
        }
      } catch {}
    }
  } catch {}

  return files;
}

/**
 * Get the HEAD commit SHA from a git repo directory.
 */
export function getCommitSha(dir) {
  try {
    return execSync(`git -C "${dir}" rev-parse HEAD`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Extract documentation from a GitHub repo.
 *
 * Shallow-clones the repo, reads documentation files, and cleans up.
 *
 * @param {string} githubUrl - GitHub repo URL
 * @param {object} [options]
 * @param {string[]} [options.targets] - Custom target files
 * @param {number} [options.maxFileSize] - Max bytes per file
 * @param {number} [options.cloneTimeout] - Clone timeout in ms (default 30000)
 * @returns {Promise<{ repoSlug: string, commitSha: string, files: { name: string, content: string }[] }>}
 */
export async function extractFromRepo(githubUrl, options = {}) {
  const repoSlug = parseGitHubUrl(githubUrl);
  if (!repoSlug) {
    throw new Error(`Invalid GitHub URL: ${githubUrl}. Use format: https://github.com/user/repo`);
  }

  const tmpDir = `/tmp/pattern-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timeout = options.cloneTimeout || 30_000;

  try {
    execSync(`git clone --depth 1 https://github.com/${repoSlug}.git "${tmpDir}" 2>&1`, { timeout });

    const files = readRepoFiles(tmpDir, options);
    const commitSha = getCommitSha(tmpDir);

    return { repoSlug, commitSha, files };
  } finally {
    try { execSync(`rm -rf "${tmpDir}"`); } catch {}
  }
}

/**
 * Format extracted files as a readable text block.
 */
export function formatExtraction(result) {
  if (result.files.length === 0) {
    return `Cloned ${result.repoSlug} but found no readable documentation files.`;
  }
  const body = result.files.map(f => `--- ${f.name} ---\n${f.content}`).join("\n\n");
  return `Extracted from ${result.repoSlug} (${result.files.length} files, commit ${result.commitSha.slice(0, 8)}):\n\n${body}`;
}

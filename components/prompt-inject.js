/**
 * prompt-inject.js — MCP tools for managing prompt injection manifest (wq-104)
 *
 * Provides tools to add, remove, update, and list prompt injection rules
 * without editing prompt-inject.json directly.
 */
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, "..", "prompt-inject.json");

function load() {
  if (!existsSync(MANIFEST_PATH)) {
    return { version: 1, description: "Prompt injection manifest", injections: [] };
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

function save(data) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(data, null, 2) + "\n");
}

export function register(server) {
  server.tool("prompt_inject_list", "List all configured prompt injections from the manifest.", {}, async () => {
    try {
      const manifest = load();
      const injections = manifest.injections || [];
      if (injections.length === 0) {
        return { content: [{ type: "text", text: "No prompt injections configured." }] };
      }
      const lines = [`**Prompt Injections** (${injections.length} configured)\n`];
      const sorted = [...injections].sort((a, b) => (a.priority || 999) - (b.priority || 999));
      for (const inj of sorted) {
        const sessions = inj.sessions || "BEBRA";
        const reqStr = inj.requires ? ` [requires: ${Array.isArray(inj.requires) ? inj.requires.join(", ") : inj.requires}]` : "";
        lines.push(`- **${inj.file}** (pri: ${inj.priority || 999}, ${inj.action || "keep"}, sessions: ${sessions})${reqStr}`);
        if (inj.description) lines.push(`  ${inj.description}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });

  server.tool("prompt_inject_add", "Add a new prompt injection rule to the manifest.", {
    file: z.string().describe("Filename for the inject (e.g. 'my-alert.txt')"),
    description: z.string().describe("What this injection does"),
    priority: z.number().optional().describe("Priority (lower = earlier). Default: 100"),
    action: z.enum(["keep", "consume"]).optional().describe("'keep' persists across sessions, 'consume' deletes after use. Default: 'keep'"),
    sessions: z.string().optional().describe("Session types to apply to (e.g. 'BR', 'BEBRA'). Default: 'BEBRA' (all)"),
    requires: z.union([z.string(), z.array(z.string())]).optional().describe("Inject(s) that must be applied first. Only applied if all required injects were applied."),
  }, async ({ file, description, priority = 100, action = "keep", sessions = "BEBRA", requires }) => {
    try {
      const manifest = load();
      if (!manifest.injections) manifest.injections = [];

      // Check for duplicate
      const existing = manifest.injections.find(i => i.file === file);
      if (existing) {
        return { content: [{ type: "text", text: `Injection '${file}' already exists. Use prompt_inject_update to modify.` }] };
      }

      const entry = { file, action, priority, sessions, description };
      if (requires) entry.requires = requires;

      manifest.injections.push(entry);

      save(manifest);
      const reqStr = requires ? ` [requires: ${Array.isArray(requires) ? requires.join(", ") : requires}]` : "";
      return { content: [{ type: "text", text: `Added injection '${file}' (priority ${priority}, ${action}, sessions: ${sessions})${reqStr}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });

  server.tool("prompt_inject_update", "Update an existing prompt injection rule.", {
    file: z.string().describe("Filename of the inject to update"),
    description: z.string().optional().describe("New description"),
    priority: z.number().optional().describe("New priority"),
    action: z.enum(["keep", "consume"]).optional().describe("New action"),
    sessions: z.string().optional().describe("New session types"),
    requires: z.union([z.string(), z.array(z.string()), z.null()]).optional().describe("Inject(s) that must be applied first. Set to null to remove dependency."),
  }, async ({ file, description, priority, action, sessions, requires }) => {
    try {
      const manifest = load();
      if (!manifest.injections) manifest.injections = [];

      const idx = manifest.injections.findIndex(i => i.file === file);
      if (idx === -1) {
        return { content: [{ type: "text", text: `Injection '${file}' not found.` }] };
      }

      const inj = manifest.injections[idx];
      if (description !== undefined) inj.description = description;
      if (priority !== undefined) inj.priority = priority;
      if (action !== undefined) inj.action = action;
      if (sessions !== undefined) inj.sessions = sessions;
      if (requires !== undefined) {
        if (requires === null) {
          delete inj.requires;
        } else {
          inj.requires = requires;
        }
      }

      save(manifest);
      const reqStr = inj.requires ? `, requires=${Array.isArray(inj.requires) ? inj.requires.join(",") : inj.requires}` : "";
      return { content: [{ type: "text", text: `Updated '${file}': priority=${inj.priority}, action=${inj.action}, sessions=${inj.sessions}${reqStr}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });

  server.tool("prompt_inject_remove", "Remove a prompt injection rule from the manifest.", {
    file: z.string().describe("Filename of the inject to remove"),
  }, async ({ file }) => {
    try {
      const manifest = load();
      if (!manifest.injections) manifest.injections = [];

      const idx = manifest.injections.findIndex(i => i.file === file);
      if (idx === -1) {
        return { content: [{ type: "text", text: `Injection '${file}' not found.` }] };
      }

      manifest.injections.splice(idx, 1);
      save(manifest);
      return { content: [{ type: "text", text: `Removed injection '${file}'` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });

  server.tool("prompt_inject_reorder", "Move an injection to a new priority position.", {
    file: z.string().describe("Filename of the inject to move"),
    new_priority: z.number().describe("New priority value (lower = earlier in processing)"),
  }, async ({ file, new_priority }) => {
    try {
      const manifest = load();
      if (!manifest.injections) manifest.injections = [];

      const idx = manifest.injections.findIndex(i => i.file === file);
      if (idx === -1) {
        return { content: [{ type: "text", text: `Injection '${file}' not found.` }] };
      }

      const old_priority = manifest.injections[idx].priority;
      manifest.injections[idx].priority = new_priority;
      save(manifest);
      return { content: [{ type: "text", text: `Changed '${file}' priority: ${old_priority} → ${new_priority}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });
}

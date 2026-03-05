#!/usr/bin/env node
/**
 * stale-tag-remediate.mjs — Auto-remove stale directive tags from queue items.
 *
 * Reads stale-tags-audit.json (produced by 33-stale-tag-check_A.sh) and removes
 * tags referencing completed directives from non-done queue items. Appends a note
 * to each remediated item's description.
 *
 * Usage:
 *   node stale-tag-remediate.mjs              # Dry run — show what would change
 *   node stale-tag-remediate.mjs --apply      # Apply changes to work-queue.json
 *   node stale-tag-remediate.mjs --json       # Dry run, JSON output
 *
 * Created: wq-835 (B#535)
 *
 * @param {object} [deps] - DI overrides for testability
 * @param {string} [deps.queuePath] - Path to work-queue.json
 * @param {string} [deps.auditPath] - Path to stale-tags-audit.json
 * @param {function} [deps.exit] - Override process.exit
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(process.env.HOME, '.config/moltbook');

export function remediate(argv = process.argv, deps = {}) {
  const queuePath = deps.queuePath || join(__dirname, "work-queue.json");
  const auditPath = deps.auditPath || join(STATE_DIR, "stale-tags-audit.json");
  const exit = deps.exit || process.exit;

  const apply = argv.includes("--apply");
  const jsonMode = argv.includes("--json");

  // Load audit results
  if (!existsSync(auditPath)) {
    const msg = "No stale-tags-audit.json found. Run 33-stale-tag-check_A.sh first.";
    if (jsonMode) console.log(JSON.stringify({ error: msg, remediated: [] }));
    else console.log(msg);
    exit(0);
    return { remediated: [], error: msg };
  }

  let audit;
  try {
    audit = JSON.parse(readFileSync(auditPath, "utf8"));
  } catch (e) {
    const msg = `Failed to parse stale-tags-audit.json: ${e.message}`;
    if (jsonMode) console.log(JSON.stringify({ error: msg, remediated: [] }));
    else console.error(msg);
    exit(1);
    return { remediated: [], error: msg };
  }

  if (!audit.stale_items || audit.stale_count === 0) {
    const msg = "No stale tags to remediate.";
    if (jsonMode) console.log(JSON.stringify({ remediated: [], message: msg }));
    else console.log(msg);
    exit(0);
    return { remediated: [] };
  }

  // Load queue
  let queue;
  try {
    queue = JSON.parse(readFileSync(queuePath, "utf8"));
  } catch (e) {
    const msg = `Failed to parse work-queue.json: ${e.message}`;
    if (jsonMode) console.log(JSON.stringify({ error: msg, remediated: [] }));
    else console.error(msg);
    exit(1);
    return { remediated: [], error: msg };
  }

  // Build stale tag map: { wq-id: [stale_tags] }
  const staleMap = {};
  for (const item of audit.stale_items) {
    staleMap[item.id] = item.stale_tags;
  }

  // Remediate
  const remediated = [];
  const session = audit.session || 0;
  for (const qItem of queue.queue) {
    const staleTags = staleMap[qItem.id];
    if (!staleTags || staleTags.length === 0) continue;

    const before = [...(qItem.tags || [])];
    qItem.tags = qItem.tags.filter(t => !staleTags.includes(t));
    const note = `[auto-remediated s${session}] Removed stale directive tag(s): ${staleTags.join(", ")}`;
    qItem.description = qItem.description ? `${qItem.description}\n${note}` : note;

    remediated.push({
      id: qItem.id,
      title: qItem.title,
      removed_tags: staleTags,
      remaining_tags: qItem.tags,
    });
  }

  if (apply && remediated.length > 0) {
    writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
  }

  // Output
  if (jsonMode) {
    console.log(JSON.stringify({ applied: apply, remediated }, null, 2));
  } else if (remediated.length === 0) {
    console.log("No matching queue items found for stale tags.");
  } else {
    console.log(`${apply ? "Applied" : "Would remediate"} ${remediated.length} item(s):`);
    for (const r of remediated) {
      console.log(`  ${r.id}: removed [${r.removed_tags.join(", ")}], remaining [${r.remaining_tags.join(", ")}]`);
    }
    if (!apply) console.log("\nRe-run with --apply to write changes.");
  }

  exit(0);
  return { applied: apply, remediated };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('stale-tag-remediate.mjs')) {
  remediate();
}

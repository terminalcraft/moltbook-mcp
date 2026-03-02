#!/usr/bin/env node
/**
 * Directive enrichment for pre-session hooks.
 *
 * Blocked queue items often reference directives (via queue_item field in directives.json).
 * Hooks like stale-blocker need to know if the linked directive has recent progress,
 * but they only see work-queue.json. This script enriches the hook environment by
 * writing directive-enrichment.json: a map of wq-id -> last directive activity session.
 *
 * Migrated from directive-enrichment.py (R#215) to Node (B#504, d071).
 *
 * Usage: node directive-enrichment.mjs <directives.json> <work-queue.json> <output.json>
 */

import { readFileSync, writeFileSync } from "fs";

/**
 * Compute directive enrichment map for blocked queue items.
 * Returns object mapping wq-id -> {directive_id, directive_status, last_activity_session, has_recent_notes}
 */
export function computeEnrichment(directivesData, queueData) {
  const directives = directivesData.directives || [];
  const queue = queueData.queue || [];

  // Build reverse map: queue_item -> directive
  const qiToDirective = new Map();
  for (const d of directives) {
    if (d.queue_item) {
      qiToDirective.set(d.queue_item, d);
    }
    // Also match items whose title contains the directive id
    const did = d.id || "";
    for (const item of queue) {
      if (item.status === "blocked" && (item.title || "").includes(did)) {
        qiToDirective.set(item.id, d);
      }
    }
  }

  const enrichment = {};
  for (const item of queue) {
    if (item.status !== "blocked") continue;
    const directive = qiToDirective.get(item.id);
    if (!directive) continue;

    const notes = directive.notes || "";
    // Extract session numbers from s### and R### patterns
    const sMatches = [...notes.matchAll(/s(\d{3,4})/g)].map(m => parseInt(m[1]));
    const rMatches = [...notes.matchAll(/R#(\d+)/g)].map(m => parseInt(m[1]));
    const sessions = [...sMatches, ...rMatches];
    const lastActivity = sessions.length > 0
      ? Math.max(...sessions)
      : (directive.acked_session || 0);

    enrichment[item.id] = {
      directive_id: directive.id || null,
      directive_status: directive.status || null,
      last_activity_session: lastActivity,
      has_recent_notes: notes.length > 50,
    };
  }

  return enrichment;
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith("directive-enrichment.mjs")) {
  if (process.argv.length !== 5) {
    process.stderr.write(`Usage: node directive-enrichment.mjs <directives.json> <work-queue.json> <output.json>\n`);
    process.exit(1);
  }

  const [, , directivesFile, queueFile, outFile] = process.argv;
  const directivesData = JSON.parse(readFileSync(directivesFile, "utf8"));
  const queueData = JSON.parse(readFileSync(queueFile, "utf8"));
  const enrichment = computeEnrichment(directivesData, queueData);
  writeFileSync(outFile, JSON.stringify(enrichment, null, 2) + "\n");
}

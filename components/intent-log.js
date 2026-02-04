/**
 * intent-log.js — Intent-first logging for platform writes (wq-243)
 *
 * Pattern: Log intent BEFORE write, verify AFTER, then mark outcome.
 * Enables crash recovery (detect pending intents from prior session)
 * and dedup verification (content hash prevents double-posts).
 *
 * Flow:
 *   1. intent_log — Log intent with content hash before platform write
 *   2. (perform the write)
 *   3. intent_verify — Mark outcome (success/fail) with optional verification
 *   4. log_engagement — Only call after intent_verify confirms success
 *
 * State file: ~/.config/moltbook/write-intents.json
 */

import { z } from "zod";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const STATE_DIR = join(process.env.HOME, '.config/moltbook');
const INTENTS_PATH = join(STATE_DIR, 'write-intents.json');

// Content hash function — deterministic hash of content for dedup
function contentHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// Load intents state
function loadIntents() {
  if (!existsSync(INTENTS_PATH)) {
    return { pending: [], completed: [], version: 1 };
  }
  try {
    return JSON.parse(readFileSync(INTENTS_PATH, 'utf8'));
  } catch {
    return { pending: [], completed: [], version: 1 };
  }
}

// Save intents state
function saveIntents(state) {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  writeFileSync(INTENTS_PATH, JSON.stringify(state, null, 2) + '\n');
}

// Check for duplicate content hash in recent completed intents (last 48h)
function isDuplicateHash(state, hash) {
  const cutoff = Date.now() - (48 * 60 * 60 * 1000);
  return state.completed.some(i =>
    i.hash === hash &&
    new Date(i.verified_at).getTime() > cutoff &&
    i.outcome === 'success'
  );
}

export function register(server) {
  // Log intent BEFORE a write
  server.tool(
    "intent_log",
    "Log intent BEFORE making a platform write. Returns intent ID to use with intent_verify. Call this BEFORE posting/commenting.",
    {
      platform: z.string().describe("Platform name (e.g. chatr, moltbook, 4claw)"),
      action: z.enum(["post", "comment", "reply", "message"]).describe("Type of write action"),
      content: z.string().describe("The content you intend to write"),
      target: z.string().optional().describe("Target thread/post ID if replying"),
    },
    async ({ platform, action, content, target }) => {
      const session = parseInt(process.env.SESSION_NUM || "0", 10);
      const hash = contentHash(content);
      const state = loadIntents();

      // Check for duplicate content
      if (isDuplicateHash(state, hash)) {
        return {
          content: [{ type: "text", text: `DUPLICATE: Content hash ${hash} already posted within 48h. Skip this write.` }]
        };
      }

      // Check for pending intent with same hash (possible crash recovery)
      const existingPending = state.pending.find(i => i.hash === hash);
      if (existingPending) {
        return {
          content: [{ type: "text", text: `PENDING: Intent ${existingPending.id} already exists for this content (from session ${existingPending.session}). Verify it first with intent_verify.` }]
        };
      }

      // Create new intent
      const intent = {
        id: `int_${Date.now().toString(36)}`,
        session,
        platform,
        action,
        hash,
        content_preview: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
        target: target || null,
        logged_at: new Date().toISOString(),
      };

      state.pending.push(intent);
      saveIntents(state);

      return {
        content: [{ type: "text", text: `Intent logged: ${intent.id}\nHash: ${hash}\nPlatform: ${platform}/${action}\nNow perform the write, then call intent_verify with this ID.` }]
      };
    }
  );

  // Verify outcome AFTER a write
  server.tool(
    "intent_verify",
    "Verify outcome AFTER a platform write. Call this AFTER posting/commenting. Only call log_engagement after intent_verify confirms success.",
    {
      intent_id: z.string().describe("Intent ID from intent_log"),
      outcome: z.enum(["success", "failed", "unknown"]).describe("Result of the write attempt"),
      platform_id: z.string().optional().describe("Platform-assigned ID (post_id, comment_id, etc.) if write succeeded"),
      error: z.string().optional().describe("Error message if write failed"),
    },
    async ({ intent_id, outcome, platform_id, error }) => {
      const state = loadIntents();
      const idx = state.pending.findIndex(i => i.id === intent_id);

      if (idx === -1) {
        // Check if already completed
        const completed = state.completed.find(i => i.id === intent_id);
        if (completed) {
          return {
            content: [{ type: "text", text: `Intent ${intent_id} already verified as ${completed.outcome} at ${completed.verified_at}` }]
          };
        }
        return {
          content: [{ type: "text", text: `Intent ${intent_id} not found. Did you call intent_log first?` }]
        };
      }

      // Move from pending to completed
      const intent = state.pending[idx];
      state.pending.splice(idx, 1);

      const completed = {
        ...intent,
        outcome,
        platform_id: platform_id || null,
        error: error || null,
        verified_at: new Date().toISOString(),
      };

      state.completed.push(completed);

      // Keep completed list bounded (last 200 entries)
      if (state.completed.length > 200) {
        state.completed = state.completed.slice(-200);
      }

      saveIntents(state);

      if (outcome === 'success') {
        return {
          content: [{ type: "text", text: `Verified: ${intent_id} SUCCESS\nPlatform ID: ${platform_id || 'none'}\nNow safe to call log_engagement.` }]
        };
      } else {
        return {
          content: [{ type: "text", text: `Verified: ${intent_id} ${outcome.toUpperCase()}\nError: ${error || 'none'}\nDo NOT call log_engagement.` }]
        };
      }
    }
  );

  // Show pending intents (crash recovery)
  server.tool(
    "intent_status",
    "Show pending write intents. Use at session start to detect unverified writes from prior crashed sessions.",
    {
      show_completed: z.boolean().default(false).describe("Also show recent completed intents"),
    },
    async ({ show_completed }) => {
      const state = loadIntents();
      const session = parseInt(process.env.SESSION_NUM || "0", 10);
      const lines = [];

      // Pending intents
      if (state.pending.length === 0) {
        lines.push("No pending intents.");
      } else {
        lines.push(`${state.pending.length} pending intent(s):`);
        for (const i of state.pending) {
          const age = Math.round((Date.now() - new Date(i.logged_at).getTime()) / 60000);
          const fromSession = i.session !== session ? ` [from s${i.session}]` : '';
          lines.push(`  ${i.id}: ${i.platform}/${i.action} "${i.content_preview}" (${age}m ago)${fromSession}`);
        }
        if (state.pending.some(i => i.session !== session)) {
          lines.push("CRASH RECOVERY: Some intents are from prior sessions. Verify them or clear with outcome=failed.");
        }
      }

      // Recent completed (last 10)
      if (show_completed && state.completed.length > 0) {
        lines.push('');
        lines.push('Recent completed intents:');
        const recent = state.completed.slice(-10).reverse();
        for (const i of recent) {
          const icon = i.outcome === 'success' ? '+' : '-';
          lines.push(`  [${icon}] ${i.id}: ${i.platform}/${i.action} ${i.outcome} (s${i.session})`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join('\n') }]
      };
    }
  );
}

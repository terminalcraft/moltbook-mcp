/**
 * Guardrails transform — runtime validation middleware for MCP tool invocations.
 *
 * Applies deterministic rules before tool handlers run:
 * - Rate limiting per tool per session
 * - Outbound content scanning on write operations
 * - Dedup blocking on write operations
 * - Parameter size enforcement
 *
 * This centralizes safety checks that were previously scattered across components.
 */

import { checkOutbound, dedupKey, isDuplicate, markDedup } from "./security.js";

// --- Rate limiting ---
const callCounts = new Map();
const sessionStart = Date.now();

// Per-tool rate limits (calls per session). Unlisted tools are unlimited.
const RATE_LIMITS = {
  moltbook_post_create: 5,
  moltbook_comment: 30,
  moltbook_vote: 50,
  chatr_send: 40,
  ctxly_remember: 20,
  knowledge_add_pattern: 20,
};

function checkRateLimit(toolName) {
  const limit = RATE_LIMITS[toolName];
  if (!limit) return null;
  const count = callCounts.get(toolName) || 0;
  if (count >= limit) {
    return `Rate limit: ${toolName} called ${count}/${limit} times this session`;
  }
  return null;
}

function recordCall(toolName) {
  callCounts.set(toolName, (callCounts.get(toolName) || 0) + 1);
}

// --- Write operation detection ---
// Tools that send content externally
const WRITE_TOOLS = new Set([
  "moltbook_post_create",
  "moltbook_comment",
  "chatr_send",
  "ctxly_remember",
]);

// Parameter names that carry outbound content
const CONTENT_PARAMS = ["content", "title", "body", "text", "message"];

function scanOutboundParams(toolName, params) {
  if (!WRITE_TOOLS.has(toolName)) return [];
  const warnings = [];
  for (const key of CONTENT_PARAMS) {
    if (params[key] && typeof params[key] === "string") {
      const w = checkOutbound(params[key]);
      if (w.length) warnings.push(...w.map(m => `${key}: ${m}`));
    }
  }
  return warnings;
}

// --- Dedup for write operations ---
function checkWriteDedup(toolName, params) {
  if (!WRITE_TOOLS.has(toolName)) return null;

  let id, content;
  if (toolName === "moltbook_post_create") {
    id = params.submolt || "unknown";
    content = params.title || "";
  } else if (toolName === "moltbook_comment") {
    id = params.post_id || "unknown";
    content = params.content || "";
  } else if (toolName === "chatr_send") {
    id = "chatr";
    content = params.content || "";
  } else if (toolName === "ctxly_remember") {
    id = "ctxly";
    content = params.content || "";
  }

  if (id && content) {
    const dk = dedupKey(toolName, id, content);
    if (isDuplicate(dk, 60000)) {
      return `Duplicate ${toolName} blocked (same content within 1 minute)`;
    }
    markDedup(dk);
  }
  return null;
}

// --- Parameter size limits ---
const PARAM_SIZE_LIMITS = {
  content: 5000,
  title: 300,
  body: 5000,
  text: 5000,
  message: 3000,
  query: 500,
  state_json: 100000,
};

function checkParamSizes(params) {
  const violations = [];
  for (const [key, val] of Object.entries(params)) {
    if (typeof val === "string" && PARAM_SIZE_LIMITS[key] && val.length > PARAM_SIZE_LIMITS[key]) {
      violations.push(`${key} exceeds limit (${val.length}/${PARAM_SIZE_LIMITS[key]})`);
    }
  }
  return violations;
}

/**
 * Main guardrail check. Returns null if OK, or an error string if blocked.
 * Also returns warnings that should be noted but don't block execution.
 */
export function runGuardrails(toolName, params) {
  const errors = [];
  const warnings = [];

  // Rate limit
  const rateErr = checkRateLimit(toolName);
  if (rateErr) errors.push(rateErr);

  // Dedup
  const dedupErr = checkWriteDedup(toolName, params);
  if (dedupErr) errors.push(dedupErr);

  // Outbound content scan
  const outbound = scanOutboundParams(toolName, params);
  if (outbound.length) errors.push(`Outbound content warning: ${outbound.join(", ")}`);

  // Param sizes — warn but truncate rather than block
  const sizeIssues = checkParamSizes(params);
  if (sizeIssues.length) warnings.push(...sizeIssues);

  // Record the call (even if blocked, for tracking)
  recordCall(toolName);

  return {
    blocked: errors.length > 0,
    errors,
    warnings,
  };
}

/**
 * Get current rate limit status for all limited tools.
 */
export function getRateLimitStatus() {
  const status = {};
  for (const [tool, limit] of Object.entries(RATE_LIMITS)) {
    status[tool] = { used: callCounts.get(tool) || 0, limit };
  }
  return status;
}

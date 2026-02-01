import { readFileSync, existsSync } from "fs";
import { join } from "path";

// --- Dedup guard ---
const _recentActions = new Map();

export function dedupKey(action, id, content) {
  return `${action}:${id}:${content.slice(0, 100)}`;
}

export function isDuplicate(key, windowMs = 120000) {
  const now = Date.now();
  for (const [k, t] of _recentActions) { if (now - t > windowMs) _recentActions.delete(k); }
  return _recentActions.has(key);
}

export function markDedup(key) { _recentActions.set(key, Date.now()); }

// --- Blocklist ---
const BLOCKLIST_FILE = join(process.env.HOME || "/tmp", "moltbook-mcp", "blocklist.json");
let _blocklistCache = null;

export function loadBlocklist() {
  if (_blocklistCache) return _blocklistCache;
  try {
    if (existsSync(BLOCKLIST_FILE)) {
      const data = JSON.parse(readFileSync(BLOCKLIST_FILE, "utf8"));
      _blocklistCache = new Set(data.blocked_users || []);
      return _blocklistCache;
    }
  } catch {}
  _blocklistCache = new Set();
  return _blocklistCache;
}

// --- Content size limits ---
export const MAX_POST_TITLE_LEN = 300;
export const MAX_POST_CONTENT_LEN = 5000;
export const MAX_COMMENT_LEN = 3000;

// --- Outbound content check ---
export function checkOutbound(text) {
  if (!text) return [];
  const warnings = [];
  const patterns = [
    [/(?:\/home\/\w+|~\/)\.\w+/g, "possible dotfile path"],
    [/(?:sk-|key-|token-)[a-zA-Z0-9]{20,}/g, "possible API key/token"],
    [/[A-Za-z0-9+/]{40,}={1,2}/g, "possible base64-encoded secret (padded)"],
    [/(?<![a-zA-Z0-9])[A-Za-z0-9]{32,}(?:[+/][A-Za-z0-9]+){2,}(?<![a-zA-Z0-9])/g, "possible base64-encoded secret"],
    [/(?:ANTHROPIC|OPENAI|AWS|GITHUB|MOLTBOOK)_[A-Z_]*(?:KEY|TOKEN|SECRET)/gi, "possible env var name"],
    [/Bearer\s+[a-zA-Z0-9._-]{20,}/g, "possible auth header"],
  ];
  for (const [re, label] of patterns) {
    if (re.test(text)) warnings.push(label);
  }
  return warnings;
}

// --- Inbound tracking detection ---
export function checkInboundTracking(text) {
  if (!text) return [];
  const warnings = [];
  if (/!\[.*?\]\(https?:\/\/[^)]*(?:track|pixel|beacon|1x1|ping|open|click|collect|analytics)/i.test(text)) {
    warnings.push("possible tracking pixel/URL");
  }
  const imgMatches = text.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/g) || [];
  if (imgMatches.length > 0) {
    warnings.push(`${imgMatches.length} external image(s) embedded`);
  }
  if (/<img\s+[^>]*src\s*=/i.test(text)) {
    warnings.push("HTML img tag detected");
  }
  if (text.length > 50000) {
    warnings.push(`very large content (${(text.length / 1000).toFixed(0)}KB)`);
  }
  return warnings;
}

// --- Sanitize untrusted content ---
export function sanitize(text) {
  if (!text) return "";
  return `[USER_CONTENT_START]${text.replace(/\[USER_CONTENT_(?:START|END)\]/g, "")}[USER_CONTENT_END]`;
}

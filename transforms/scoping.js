import { loadState, saveState } from "../providers/state.js";

// --- Tool usage tracking ---
const toolUsage = {};

export function trackTool(name) {
  toolUsage[name] = (toolUsage[name] || 0) + 1;
}

export function saveToolUsage() {
  const s = loadState();
  if (!s.toolUsage) s.toolUsage = {};
  for (const [name, count] of Object.entries(toolUsage)) {
    if (!s.toolUsage[name]) s.toolUsage[name] = { total: 0, lastUsed: null };
    s.toolUsage[name].total += count;
    s.toolUsage[name].lastUsed = new Date().toISOString();
  }
  saveState(s);
}

// --- Per-session tool scoping ---
const SESSION_TYPE = (process.env.SESSION_TYPE || "").toUpperCase().charAt(0);

const TOOL_SCOPES = {
  always: ["moltbook_state", "moltbook_export", "moltbook_import", "moltbook_pending", "knowledge_read", "knowledge_prune"],
  B: ["moltbook_post", "moltbook_search", "moltbook_submolts", "moltbook_profile", "moltbook_digest",
      "moltbook_trust", "moltbook_karma", "moltbook_thread_diff", "moltbook_github_map",
      "knowledge_add_pattern", "agent_crawl_repo", "agent_crawl_suggest", "agent_fetch_knowledge",
      "discover_list", "discover_evaluate", "discover_log_url",
      "ctxly_remember", "ctxly_recall", "chatr_read", "chatr_send", "chatr_agents", "chatr_heartbeat",
      "agentid_lookup"],
  E: ["moltbook_post", "moltbook_post_create", "moltbook_comment", "moltbook_vote", "moltbook_search",
      "moltbook_submolts", "moltbook_profile", "moltbook_profile_update", "moltbook_digest",
      "moltbook_trust", "moltbook_karma", "moltbook_thread_diff", "moltbook_follow",
      "moltbook_bsky_discover", "moltbook_github_map",
      "chatr_read", "chatr_send", "chatr_agents", "chatr_heartbeat",
      "ctxly_remember", "ctxly_recall", "agentid_lookup",
      "discover_log_url"],
  L: ["moltbook_post", "moltbook_search", "moltbook_digest", "moltbook_trust",
      "knowledge_add_pattern", "agent_crawl_repo", "agent_crawl_suggest", "agent_fetch_knowledge",
      "discover_list", "discover_evaluate", "discover_log_url",
      "ctxly_remember", "ctxly_recall", "agentid_lookup",
      "chatr_read", "chatr_agents"],
  R: ["moltbook_post", "moltbook_search", "moltbook_digest", "moltbook_trust", "moltbook_karma",
      "moltbook_thread_diff", "moltbook_profile",
      "ctxly_remember", "ctxly_recall"],
};

export function isToolAllowed(toolName) {
  if (!SESSION_TYPE || !TOOL_SCOPES[SESSION_TYPE]) return true;
  if (TOOL_SCOPES.always.includes(toolName)) return true;
  return TOOL_SCOPES[SESSION_TYPE].includes(toolName);
}

// Wrap server.tool for auto-tracking and scoping
export function wrapServerTool(server) {
  const _origTool = server.tool.bind(server);
  server.tool = function(name, ...args) {
    if (!isToolAllowed(name)) return;
    const handlerIdx = args.findIndex(a => typeof a === "function");
    if (handlerIdx >= 0) {
      const origHandler = args[handlerIdx];
      args[handlerIdx] = function(...hArgs) {
        trackTool(name);
        return origHandler.apply(this, hArgs);
      };
    }
    return _origTool(name, ...args);
  };
}

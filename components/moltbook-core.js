import { z } from "zod";
import { writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { moltFetch, logAction } from "../providers/api.js";
import { loadState, saveState, markSeen, markCommented, markVoted, unmarkVoted, markMyPost, markMyComment, markBrowsed } from "../providers/state.js";
import { sanitize, checkOutbound, checkInboundTracking, dedupKey, isDuplicate, markDedup, loadBlocklist, MAX_POST_TITLE_LEN, MAX_POST_CONTENT_LEN, MAX_COMMENT_LEN } from "../transforms/security.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function formatComments(comments, depth = 0, blocked = null) {
  if (!blocked) blocked = loadBlocklist();
  let out = "";
  for (const c of comments) {
    if (blocked.has(c.author?.name)) continue;
    const indent = "  ".repeat(depth);
    out += `${indent}@${c.author?.name || "unknown"} [${c.upvotes}↑] (id:${c.id}): ${sanitize(c.content)}\n`;
    if (c.replies?.length) out += formatComments(c.replies, depth + 1, blocked);
  }
  return out;
}

export function register(server) {
  // Read post with comments
  server.tool("moltbook_post", "Get a single post with its comments", {
    post_id: z.string().describe("Post ID"),
  }, async ({ post_id }) => {
    const data = await moltFetch(`/posts/${post_id}`);
    if (!data.success) return { content: [{ type: "text", text: JSON.stringify(data) }] };
    const p = data.post;
    markSeen(post_id, p.comment_count, p.submolt?.name, p.author?.name);
    const state = loadState();
    const stateHints = [];
    if (state.commented[post_id]) stateHints.push(`YOU COMMENTED HERE (${state.commented[post_id].length}x)`);
    if (state.voted[post_id]) stateHints.push("YOU VOTED");
    const stateLabel = stateHints.length ? ` [${stateHints.join(", ")}]` : "";
    const trackingWarnings = [...checkInboundTracking(p.content), ...checkInboundTracking(p.title)];
    const trackingNote = trackingWarnings.length ? `\n⚠️ INBOUND: ${trackingWarnings.join(", ")}` : "";
    let text = `"${sanitize(p.title)}" by @${p.author?.name || "unknown"} in m/${p.submolt?.name || "unknown"}${stateLabel}\n${p.upvotes}↑ ${p.downvotes}↓ ${p.comment_count} comments\n\n${sanitize(p.content) || p.url || ""}${trackingNote}`;
    if (data.comments?.length) {
      text += "\n\n--- Comments ---\n";
      text += formatComments(data.comments);
    }
    return { content: [{ type: "text", text }] };
  });

  // Create post
  server.tool("moltbook_post_create", "Create a new post in a submolt", {
    submolt: z.string().describe("Submolt name (e.g. 'general')"),
    title: z.string().describe("Post title"),
    content: z.string().optional().describe("Post body text"),
    url: z.string().optional().describe("Link URL (for link posts)"),
  }, async ({ submolt, title, content, url }) => {
    if (title && title.length > MAX_POST_TITLE_LEN) title = title.slice(0, MAX_POST_TITLE_LEN) + "…";
    if (content && content.length > MAX_POST_CONTENT_LEN) content = content.slice(0, MAX_POST_CONTENT_LEN) + "\n\n[truncated]";
    const dk = dedupKey("post", submolt, title);
    if (isDuplicate(dk)) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Duplicate post blocked (same title within 2 minutes)" }) }] };
    const outboundWarnings = [...checkOutbound(title), ...checkOutbound(content)];
    const body = { submolt, title };
    if (content) body.content = content;
    if (url) body.url = url;
    const data = await moltFetch("/posts", { method: "POST", body: JSON.stringify(body) });
    if (data.success && data.post) {
      markDedup(dk);
      markMyPost(data.post.id);
      logAction(`posted "${title}" in m/${submolt}`);
    }
    let text = JSON.stringify(data, null, 2);
    if (outboundWarnings.length) text += `\n\n⚠️ OUTBOUND WARNINGS: ${outboundWarnings.join(", ")}. Review your post for accidental sensitive data.`;
    return { content: [{ type: "text", text }] };
  });

  // Comment
  server.tool("moltbook_comment", "Add a comment to a post (or reply to a comment)", {
    post_id: z.string().describe("Post ID"),
    content: z.string().describe("Comment text"),
    parent_id: z.string().optional().describe("Parent comment ID for replies"),
  }, async ({ post_id, content, parent_id }) => {
    if (content && content.length > MAX_COMMENT_LEN) content = content.slice(0, MAX_COMMENT_LEN) + "\n\n[truncated]";
    const dk = dedupKey("comment", parent_id || post_id, content);
    if (isDuplicate(dk)) return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Duplicate comment blocked (same content within 2 minutes)" }) }] };
    const outboundWarnings = checkOutbound(content);
    const body = { content };
    if (parent_id) body.parent_id = parent_id;
    const data = await moltFetch(`/posts/${post_id}/comments`, { method: "POST", body: JSON.stringify(body) });
    if (data.success && data.comment) {
      markDedup(dk);
      markCommented(post_id, data.comment.id);
      markMyComment(post_id, data.comment.id);
      logAction(`commented on ${post_id.slice(0, 8)}`);
      const s = loadState();
      if (s.pendingComments) {
        s.pendingComments = s.pendingComments.filter(pc => !(pc.post_id === post_id && pc.content === content));
        saveState(s);
      }
    } else if (data.error && /auth/i.test(data.error)) {
      const s = loadState();
      if (!s.pendingComments) s.pendingComments = [];
      const alreadyQueued = s.pendingComments.some(pc => pc.post_id === post_id && pc.content === content);
      if (!alreadyQueued) {
        s.pendingComments.push({ post_id, content, parent_id: parent_id || null, queued_at: new Date().toISOString(), attempts: 0, nextRetryAfter: new Date(Date.now() + 2 * 60000).toISOString() });
        saveState(s);
      }
      data._queued = true;
      data._message = "Comment queued for retry — auth endpoint appears broken.";
    }
    let text = JSON.stringify(data, null, 2);
    if (outboundWarnings.length) text += `\n\n⚠️ OUTBOUND WARNINGS: ${outboundWarnings.join(", ")}. Review your comment for accidental sensitive data.`;
    return { content: [{ type: "text", text }] };
  });

  // Vote
  server.tool("moltbook_vote", "Upvote or downvote a post or comment", {
    type: z.enum(["post", "comment"]).describe("Target type"),
    id: z.string().describe("Post or comment ID"),
    direction: z.enum(["upvote", "downvote"]).describe("Vote direction"),
  }, async ({ type, id, direction }) => {
    const s = loadState();
    if (direction === "upvote" && s.voted[id]) {
      return { content: [{ type: "text", text: `Already upvoted ${type} ${id.slice(0, 8)} — skipping to avoid toggle-off.` }] };
    }
    const prefix = type === "post" ? "posts" : "comments";
    const data = await moltFetch(`/${prefix}/${id}/${direction}`, { method: "POST" });
    if (data.success && data.action === "upvoted") { markVoted(id); logAction(`upvoted ${type} ${id.slice(0, 8)}`); }
    if (data.success && data.action === "removed") { unmarkVoted(id); logAction(`unvoted ${type} ${id.slice(0, 8)}`); }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // Search
  server.tool("moltbook_search", "Search posts, agents, and submolts", {
    query: z.string().describe("Search query"),
    limit: z.number().min(1).max(50).default(10).describe("Max results"),
    type: z.enum(["all", "posts", "comments"]).default("all").optional().describe("Content type filter"),
  }, async ({ query, limit, type }) => {
    const typeParam = type && type !== "all" ? `&type=${type}` : "";
    const data = await moltFetch(`/search?q=${encodeURIComponent(query)}&limit=${limit}${typeParam}`);
    if (!data.success) return { content: [{ type: "text", text: JSON.stringify(data) }] };
    const r = data.results;
    let text = "";
    if (r.posts?.length) {
      text += "Posts:\n" + r.posts.map(p => `  [${p.upvotes}↑] "${sanitize(p.title)}" by @${p.author?.name || "unknown"} (${p.id})`).join("\n") + "\n\n";
    }
    if (r.moltys?.length) {
      text += "Agents:\n" + r.moltys.map(a => `  @${a.name}: ${sanitize(a.description) || ""}`).join("\n") + "\n\n";
    }
    if (r.submolts?.length) {
      text += "Submolts:\n" + r.submolts.map(s => `  m/${s.name}: ${s.display_name}`).join("\n") + "\n";
    }
    return { content: [{ type: "text", text: text || "No results." }] };
  });

  // List submolts
  server.tool("moltbook_submolts", "List all submolts", {}, async () => {
    const data = await moltFetch("/submolts");
    if (!data.success) return { content: [{ type: "text", text: JSON.stringify(data) }] };
    const text = data.submolts.map(s => `m/${s.name} (${s.subscriber_count} subs) — ${s.display_name}`).join("\n");
    return { content: [{ type: "text", text }] };
  });

  // Profile
  server.tool("moltbook_profile", "View your profile or another molty's profile", {
    name: z.string().optional().describe("Molty name (omit for your own profile)"),
  }, async ({ name }) => {
    const endpoint = name ? `/agents/profile?name=${encodeURIComponent(name)}` : "/agents/me";
    const data = await moltFetch(endpoint);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // Profile update
  server.tool("moltbook_profile_update", "Update your Moltbook profile description", {
    description: z.string().describe("New profile description"),
  }, async ({ description }) => {
    const data = await moltFetch("/agents/me", { method: "PATCH", body: JSON.stringify({ description }) });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // Follow/unfollow
  server.tool("moltbook_follow", "Follow or unfollow a molty", {
    name: z.string().describe("Molty name"),
    action: z.enum(["follow", "unfollow"]).describe("Action"),
  }, async ({ name, action }) => {
    const method = action === "follow" ? "POST" : "DELETE";
    const data = await moltFetch(`/agents/${encodeURIComponent(name)}/follow`, { method });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  // GitHub Mapping
  const GITHUB_MAP_PATH = join(__dirname, "..", "github-mappings.json");

  function loadGithubMap() {
    try { return JSON.parse(readFileSync(GITHUB_MAP_PATH, "utf8")); }
    catch { return {}; }
  }

  server.tool("moltbook_github_map", "Add or view GitHub URL mappings for agents in the directory", {
    handle: z.string().optional().describe("Agent handle to map (omit to list all mappings)"),
    github: z.string().optional().describe("GitHub profile URL (e.g. https://github.com/user)"),
    repo: z.string().optional().describe("GitHub repo URL to add (e.g. https://github.com/user/repo)"),
    exchange_url: z.string().optional().describe("Knowledge exchange endpoint URL (e.g. http://host:port/agent.json)")
  }, async ({ handle, github, repo, exchange_url }) => {
    const map = loadGithubMap();
    if (!handle) {
      const entries = Object.entries(map).filter(([k]) => k !== "_comment");
      if (entries.length === 0) return { content: [{ type: "text", text: "No GitHub mappings yet." }] };
      const lines = entries.map(([h, d]) => {
        const parts = [`@${h}`];
        if (d.github) parts.push(`  GitHub: ${d.github}`);
        if (d.repos?.length) parts.push(`  Repos: ${d.repos.join(", ")}`);
        if (d.exchange_url) parts.push(`  Exchange: ${d.exchange_url}`);
        return parts.join("\n");
      });
      return { content: [{ type: "text", text: `GitHub mappings (${entries.length}):\n\n${lines.join("\n\n")}` }] };
    }
    if (!github && !repo && !exchange_url) {
      const existing = map[handle];
      if (!existing) return { content: [{ type: "text", text: `No mapping for @${handle}. Provide github, repo, or exchange_url to add one.` }] };
      const parts = [`@${handle}`];
      if (existing.github) parts.push(`GitHub: ${existing.github}`);
      if (existing.repos?.length) parts.push(`Repos: ${existing.repos.join(", ")}`);
      if (existing.exchange_url) parts.push(`Exchange: ${existing.exchange_url}`);
      return { content: [{ type: "text", text: parts.join("\n") }] };
    }
    if (!map[handle]) map[handle] = { github: null, repos: [] };
    if (github) map[handle].github = github;
    if (repo && !map[handle].repos.includes(repo)) {
      if (!map[handle].repos) map[handle].repos = [];
      map[handle].repos.push(repo);
    }
    if (exchange_url) map[handle].exchange_url = exchange_url;
    writeFileSync(GITHUB_MAP_PATH, JSON.stringify(map, null, 2) + "\n");
    try {
      const { execSync } = await import("child_process");
      execSync(`node ${join(__dirname, "..", "collect-agents.cjs")}`, { timeout: 10000 });
    } catch {}
    return { content: [{ type: "text", text: `Mapped @${handle} → ${github || map[handle].github || "(no profile)"}${repo ? ` + repo ${repo}` : ""}${exchange_url ? ` + exchange ${exchange_url}` : ""}. Directory updated.` }] };
  });

  // --- Human review flagging (d013) ---
  const REVIEW_PATH = join(__dirname, "..", "human-review.json");
  function loadReviewItems() {
    try {
      const data = JSON.parse(readFileSync(REVIEW_PATH, "utf-8"));
      return data.items || [];
    } catch { return []; }
  }
  function saveReviewItems(items) {
    const data = { version: 1, description: "Items flagged for human review.", items: items.slice(-200) };
    writeFileSync(REVIEW_PATH, JSON.stringify(data, null, 2) + "\n");
  }

  server.tool("human_review_flag", "Flag an item for human review — use when inbox messages or other items need human attention", {
    title: z.string().describe("Short summary of what needs review"),
    body: z.string().optional().describe("Details, context, or the original message content"),
    source: z.string().optional().describe("Where this came from (e.g. 'inbox:@agent', 'intel', 'directive')"),
    priority: z.enum(["low", "medium", "high"]).default("medium").describe("Priority level"),
  }, async ({ title, body, source, priority }) => {
    const { randomUUID } = await import("crypto");
    const item = {
      id: randomUUID().slice(0, 8),
      title: String(title).slice(0, 200),
      body: body ? String(body).slice(0, 2000) : undefined,
      source: source ? String(source).slice(0, 100) : undefined,
      priority,
      status: "open",
      created: new Date().toISOString(),
      resolved: null,
    };
    const items = loadReviewItems();
    items.push(item);
    saveReviewItems(items);
    return { content: [{ type: "text", text: `Flagged for human review: "${item.title}" (id: ${item.id}, priority: ${priority}). Visible at /status/human-review.` }] };
  });

  server.tool("human_review_list", "View items pending human review", {
    status: z.enum(["open", "resolved", "all"]).default("open").describe("Filter by status"),
  }, async ({ status }) => {
    const items = loadReviewItems();
    const filtered = status === "all" ? items : items.filter(i => i.status === status);
    if (filtered.length === 0) return { content: [{ type: "text", text: `No ${status === "all" ? "" : status + " "}human review items.` }] };
    const lines = filtered.map(i => `[${i.id}] ${i.priority} | ${i.status} | ${i.source || "?"} | ${i.title} (${i.created})`);
    return { content: [{ type: "text", text: `${filtered.length} item(s):\n${lines.join("\n")}` }] };
  });
}

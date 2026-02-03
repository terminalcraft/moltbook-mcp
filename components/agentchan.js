import { z } from "zod";

// AgentChan (chan.alphakek.ai) - Anonymous imageboard for agents
// API docs: https://chan.alphakek.ai/skill.md
// No auth required. Rate limits: 30s between posts, 120s between new threads.

const AGENTCHAN_API = "https://chan.alphakek.ai/api";

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

// Normalize post fields (API uses id/comment/subject, some 4chan clones use no/com/sub)
function normalizePost(p) {
  return {
    id: p.id || p.no,
    board: p.board,
    thread_id: p.thread_id || p.resto,
    name: p.name || "Anonymous",
    subject: p.subject || p.sub,
    comment: p.comment || p.com || "",
    time: p.time,
    has_image: p.has_image || p.tim,
    replies: p.replies || 0,
  };
}

export function register(server) {
  server.tool("agentchan_boards", "List all boards on chan.alphakek.ai", {}, async () => {
    try {
      const data = await fetchJson(`${AGENTCHAN_API}/boards.json`);
      const boards = data?.boards || data || [];
      if (!Array.isArray(boards) || !boards.length) return ok("No boards found");
      const summary = boards.map(b => `/${b.uri || b.board || b.id}/ — ${b.name || b.title}: ${b.description || ""}`).join("\n");
      return ok(summary);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("agentchan_recent", "Get recent posts across all boards", {
    limit: z.number().optional().describe("Max posts (default 20, max 50)"),
  }, async ({ limit }) => {
    try {
      const n = Math.min(limit || 20, 50);
      const data = await fetchJson(`${AGENTCHAN_API}/recent.json?limit=${n}`);
      const posts = data?.posts || [];
      if (!posts.length) return ok("No recent posts");
      const summary = posts.map(p => {
        const np = normalizePost(p);
        const subj = np.subject ? `"${np.subject}" ` : "";
        const preview = np.comment.replace(/<[^>]+>/g, "").slice(0, 150);
        return `[/${np.board}/] [${np.id}] ${subj}— ${preview}`;
      }).join("\n\n");
      return ok(`Recent posts:\n\n${summary}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("agentchan_thread", "Get a specific thread with replies", {
    board: z.string().describe("Board ID (e.g. phi, awg, biz)"),
    thread_id: z.number().describe("Thread ID number"),
  }, async ({ board, thread_id }) => {
    try {
      const data = await fetchJson(`${AGENTCHAN_API}/${board}/thread/${thread_id}.json`);
      const posts = data?.posts || [];
      if (!posts.length) return ok("Thread not found or empty");
      const op = normalizePost(posts[0]);
      const replies = posts.slice(1).map(normalizePost);
      let out = `[${op.id}] "${op.subject || "(no subject)"}" by ${op.name}\n${op.comment.replace(/<[^>]+>/g, "")}\n\n--- ${replies.length} replies ---`;
      if (replies.length) {
        out += "\n\n" + replies.slice(0, 30).map(r =>
          `#${r.id} ${r.name}: ${r.comment.replace(/<[^>]+>/g, "").slice(0, 300)}`
        ).join("\n\n");
        if (replies.length > 30) out += `\n\n... and ${replies.length - 30} more replies`;
      }
      return ok(out);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("agentchan_post", "Create a new thread on AgentChan", {
    board: z.string().describe("Board ID (e.g. phi, awg, biz, ai)"),
    subject: z.string().describe("Thread subject/title"),
    comment: z.string().describe("Message text (max 10000 chars, supports greentext with >)"),
    name: z.string().optional().describe("Poster name (default: Anonymous, supports tripcode with name#secret)"),
    image_url: z.string().optional().describe("Image URL from allowed domains (imgur, imgflip, tenor, catbox, pbs.twimg, i.redd.it, i.ibb.co, wikimedia)"),
  }, async ({ board, subject, comment, name, image_url }) => {
    try {
      const formData = new FormData();
      formData.append("board", board);
      formData.append("com", comment);
      formData.append("sub", subject);
      if (name) formData.append("name", name);
      if (image_url) formData.append("image_url", image_url);

      const res = await fetch(`${AGENTCHAN_API}/post.php`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!data.success) {
        const retry = data.retry_after ? ` (retry in ${data.retry_after}s)` : "";
        return err(`Error: ${data.error || "Unknown error"}${retry}`);
      }
      return ok(`Thread created: /${board}/${data.thread_id} (post #${data.post_id})\nURL: https://chan.alphakek.ai${data.url}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("agentchan_reply", "Reply to a thread on AgentChan", {
    board: z.string().describe("Board ID"),
    thread_id: z.number().describe("Thread ID to reply to"),
    comment: z.string().describe("Reply text (max 10000 chars, use >>N to quote post N)"),
    name: z.string().optional().describe("Poster name (default: Anonymous)"),
    sage: z.boolean().optional().describe("If true, don't bump the thread"),
    image_url: z.string().optional().describe("Image URL from allowed domains"),
  }, async ({ board, thread_id, comment, name, sage, image_url }) => {
    try {
      const formData = new FormData();
      formData.append("board", board);
      formData.append("resto", thread_id.toString());
      formData.append("com", comment);
      if (name) formData.append("name", name);
      if (sage) formData.append("email", "sage");
      if (image_url) formData.append("image_url", image_url);

      const res = await fetch(`${AGENTCHAN_API}/post.php`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!data.success) {
        const retry = data.retry_after ? ` (retry in ${data.retry_after}s)` : "";
        return err(`Error: ${data.error || "Unknown error"}${retry}`);
      }
      return ok(`Reply posted: #${data.post_id} in thread ${thread_id}\nURL: https://chan.alphakek.ai${data.url}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("agentchan_stats", "Get activity statistics for AgentChan boards", {}, async () => {
    try {
      const data = await fetchJson(`${AGENTCHAN_API}/stats.json`);
      if (!data) return ok("No stats available");
      const global = data.global || {};
      const boards = data.boards || {};
      let out = `AgentChan stats (${data.generated || "now"}):\n`;
      out += `Total: ${global.total_posts || 0} posts, ${global.total_threads || 0} threads, ${global.posts_last_hour || 0} posts/hr\n\n`;
      out += Object.entries(boards).map(([b, s]) =>
        `/${b}/: ${s.total_posts || 0} posts, ${s.total_threads || 0} threads, ${s.posts_last_hour || 0}/hr`
      ).join("\n");
      return ok(out);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });
}

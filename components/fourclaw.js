import { z } from "zod";
import { getFourclawCredentials, FOURCLAW_API } from "../providers/credentials.js";

// Spam detection for 4claw content
const SPAM_PATTERNS = [
  /0x[a-fA-F0-9]{40}/,                    // ETH addresses
  /\$CLAWIRC/i,                            // Known spam token
  /clawirc\.duckdns/i,                     // Known spam domain
  /trading fees?\s*(sustain|fuel|feed)/i,   // Token shill phrases
  /sustain\w*\s+(the\s+)?(hive|swarm|node|grid|host)/i,
  /protocol\s+(beacon|sync|directive|nexus|breach|update)/i,
  /siphon\s+protocol/i,
  /fees\s+(loop|chain|breathe|sustain)/i,
];

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error(`4claw API returned ${res.status} (${ct || "no content-type"}) instead of JSON — endpoint may be broken`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function authHeaders(creds) {
  return { Authorization: `Bearer ${creds.api_key}` };
}

function isSpam(title, content) {
  const text = `${title || ""} ${content || ""}`;
  let matches = 0;
  for (const p of SPAM_PATTERNS) {
    if (p.test(text)) matches++;
  }
  return matches >= 2;
}

function scoreThread(t) {
  let score = 0;
  const replies = t.replyCount || 0;
  score += Math.min(replies * 2, 20);  // Up to 20 pts for replies
  const len = (t.content || "").length;
  if (len > 200) score += 5;           // Substantive content
  if (len > 500) score += 5;
  if (t.title && t.title.length > 15) score += 2;  // Non-trivial title
  if (/\?$/.test(t.title)) score += 3;  // Questions spark discussion
  return score;
}

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

export function register(server) {
  server.tool("fourclaw_boards", "List all boards on 4claw.org", {}, async () => {
    const creds = getFourclawCredentials();
    if (!creds) return err("No 4claw credentials found");
    try {
      const data = await fetchJson(`${FOURCLAW_API}/boards`, { headers: authHeaders(creds) });
      const summary = data.boards?.map(b => `/${b.slug}/ — ${b.title}: ${b.description}`).join("\n") || "No boards";
      return ok(summary);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("fourclaw_threads", "List threads on a 4claw board", {
    board: z.string().describe("Board slug (e.g. singularity, b, job)"),
    sort: z.enum(["bumped", "new", "top"]).optional().describe("Sort order (default: bumped)"),
  }, async ({ board, sort }) => {
    const creds = getFourclawCredentials();
    if (!creds) return err("No 4claw credentials found");
    try {
      const s = sort || "bumped";
      const data = await fetchJson(`${FOURCLAW_API}/boards/${board}/threads?sort=${s}`, { headers: authHeaders(creds) });
      const summary = data.threads?.map(t =>
        `[${t.id.slice(0, 8)}] "${t.title}" by ${t.anon ? "anon" : (t.agent_name || "unknown")} — ${t.replyCount}r — ${t.content?.slice(0, 120)}...`
      ).join("\n\n") || "No threads";
      return ok(`/${board}/ (${data.threads?.length || 0} threads):\n\n${summary}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("fourclaw_thread", "Get a specific thread with replies", {
    thread_id: z.string().describe("Thread ID"),
  }, async ({ thread_id }) => {
    const creds = getFourclawCredentials();
    if (!creds) return err("No 4claw credentials found");
    try {
      const data = await fetchJson(`${FOURCLAW_API}/threads/${thread_id}`, { headers: authHeaders(creds) });
      const t = data.thread || data;
      let out = `"${t.title}" by ${t.anon ? "anon" : (t.agent_name || "unknown")}\n${t.content}\n\n--- ${t.replyCount || 0} replies ---`;
      if (data.replies?.length) {
        out += "\n\n" + data.replies.map((r, i) =>
          `#${i + 1} ${r.anon ? "anon" : (r.agent_name || "unknown")}: ${r.content}`
        ).join("\n\n");
      }
      return ok(out);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("fourclaw_post", "Create a thread on a 4claw board", {
    board: z.string().describe("Board slug"),
    title: z.string().describe("Thread title"),
    content: z.string().describe("Thread content (greentext supported with >)"),
    anon: z.boolean().optional().describe("Post anonymously (default: false)"),
  }, async ({ board, title, content, anon }) => {
    const creds = getFourclawCredentials();
    if (!creds) return err("No 4claw credentials found");
    try {
      const data = await fetchJson(`${FOURCLAW_API}/boards/${board}/threads`, {
        method: "POST",
        headers: { ...authHeaders(creds), "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, anon: anon || false }),
      });
      return ok(`Thread created: ${data.thread?.id || "ok"}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("fourclaw_reply", "Reply to a thread on 4claw", {
    thread_id: z.string().describe("Thread ID to reply to"),
    content: z.string().describe("Reply content"),
    anon: z.boolean().optional().describe("Post anonymously (default: false)"),
    bump: z.boolean().optional().describe("Bump thread (default: true)"),
  }, async ({ thread_id, content, anon, bump }) => {
    const creds = getFourclawCredentials();
    if (!creds) return err("No 4claw credentials found");
    try {
      const data = await fetchJson(`${FOURCLAW_API}/threads/${thread_id}/replies`, {
        method: "POST",
        headers: { ...authHeaders(creds), "Content-Type": "application/json" },
        body: JSON.stringify({ content, anon: anon || false, bump: bump !== false }),
      });
      return ok(`Reply posted to thread ${thread_id}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("fourclaw_search", "Search posts on 4claw", {
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results (default: 10)"),
  }, async ({ query, limit }) => {
    const creds = getFourclawCredentials();
    if (!creds) return err("No 4claw credentials found");
    try {
      const data = await fetchJson(`${FOURCLAW_API}/search?q=${encodeURIComponent(query)}&limit=${limit || 10}`, { headers: authHeaders(creds) });
      const results = data.results || data.threads || [];
      if (!results.length) return ok("No results");
      const out = results.map(r => `[${r.id?.slice(0, 8)}] "${r.title || "(reply)"}" — ${r.content?.slice(0, 150)}`).join("\n\n");
      return ok(out);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("fourclaw_digest", "Get a signal-filtered digest of a 4claw board (filters spam, ranks by quality)", {
    board: z.string().optional().describe("Board slug (default: singularity)"),
    limit: z.number().optional().describe("Max threads to return (default: 15)"),
    mode: z.enum(["signal", "wide"]).optional().describe("'signal' filters spam (default), 'wide' shows all with scores"),
  }, async ({ board, limit, mode }) => {
    const creds = getFourclawCredentials();
    if (!creds) return err("No 4claw credentials found");
    try {
      const b = board || "singularity";
      const max = limit || 15;
      const m = mode || "signal";
      const data = await fetchJson(`${FOURCLAW_API}/boards/${b}/threads?sort=bumped`, { headers: authHeaders(creds) });
      const threads = data.threads || [];
      let filtered;
      if (m === "signal") {
        filtered = threads.filter(t => !isSpam(t.title, t.content));
      } else {
        filtered = threads;
      }
      const scored = filtered.map(t => ({ ...t, _score: scoreThread(t), _spam: isSpam(t.title, t.content) }));
      scored.sort((a, b) => b._score - a._score);
      const top = scored.slice(0, max);
      if (!top.length) return ok(`/${b}/ digest: no signal found`);
      const out = top.map(t => {
        const spam = t._spam ? " [SPAM]" : "";
        return `[${t._score}pts] [${t.id?.slice(0, 8)}] "${t.title}" (${t.replyCount || 0}r)${spam}\n  ${(t.content || "").slice(0, 100).replace(/\n/g, " ")}`;
      }).join("\n\n");
      const spamCount = threads.length - threads.filter(t => !isSpam(t.title, t.content)).length;
      const header = `/${b}/ digest (${m}): ${top.length} threads shown, ${spamCount} spam filtered from ${threads.length} total`;
      return ok(`${header}\n\n${out}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });
}

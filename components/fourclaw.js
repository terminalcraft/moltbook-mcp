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

// Dedup: collapse near-identical replies in high-reply threads
function dedupReplies(replies) {
  if (!replies || replies.length < 5) return { replies, dupsRemoved: 0 };
  const seen = new Map(); // normalized content -> first index
  const kept = [];
  let dupsRemoved = 0;
  for (const r of replies) {
    // Normalize: lowercase, collapse whitespace, strip URLs
    const norm = (r.content || "").toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
    if (norm.length < 10) { kept.push(r); continue; } // Too short to dedup
    // Check similarity: exact match or >80% overlap with a seen reply
    let isDup = false;
    for (const [key] of seen) {
      if (key === norm) { isDup = true; break; }
      // Simple overlap: shared prefix ratio
      const minLen = Math.min(key.length, norm.length);
      const maxLen = Math.max(key.length, norm.length);
      if (minLen / maxLen > 0.8) {
        let match = 0;
        for (let i = 0; i < minLen; i++) { if (key[i] === norm[i]) match++; }
        if (match / maxLen > 0.8) { isDup = true; break; }
      }
    }
    if (isDup) {
      dupsRemoved++;
    } else {
      seen.set(norm, kept.length);
      kept.push(r);
    }
  }
  return { replies: kept, dupsRemoved };
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
        `[${t.id}] "${t.title}" by ${t.anon ? "anon" : (t.agent_name || "unknown")} — ${t.replyCount}r — ${t.content?.slice(0, 120)}...`
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
      const nonSpamReplies = (data.replies || []).filter(r => !isSpam("", r.content));
      const spamFiltered = (data.replies?.length || 0) - nonSpamReplies.length;
      const { replies: cleanReplies, dupsRemoved } = dedupReplies(nonSpamReplies);
      const filterNotes = [];
      if (dupsRemoved > 0) filterNotes.push(`${dupsRemoved} duplicates`);
      if (spamFiltered > 0) filterNotes.push(`${spamFiltered} spam`);
      const dupNote = filterNotes.length ? ` (${filterNotes.join(", ")} hidden)` : "";
      let out = `"${t.title}" by ${t.anon ? "anon" : (t.agent_name || "unknown")}\n${t.content}\n\n--- ${t.replyCount || 0} replies ---${dupNote}`;
      if (cleanReplies?.length) {
        out += "\n\n" + cleanReplies.map((r, i) =>
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
      const out = results.map(r => `[${r.id}] "${r.title || "(reply)"}" — ${r.content?.slice(0, 150)}`).join("\n\n");
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
      // Author flood detection: count threads per author
      const authorCounts = new Map();
      for (const t of filtered) {
        const author = t.anon ? null : (t.agent_name || null);
        if (author) authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
      }
      const floodAuthors = new Set([...authorCounts.entries()].filter(([, c]) => c > 3).map(([a]) => a));

      const scored = filtered.map(t => ({ ...t, _score: scoreThread(t), _spam: isSpam(t.title, t.content) }));
      // Penalize flood authors in signal mode
      if (m === "signal") {
        for (const t of scored) {
          const author = t.anon ? null : (t.agent_name || null);
          if (author && floodAuthors.has(author)) t._score = Math.max(0, t._score - 10);
        }
      }
      scored.sort((a, b) => b._score - a._score);
      const top = scored.slice(0, max);
      if (!top.length) return ok(`/${b}/ digest: no signal found`);
      const out = top.map(t => {
        const spam = t._spam ? " [SPAM]" : "";
        const author = t.anon ? null : (t.agent_name || null);
        const flood = author && floodAuthors.has(author) ? " [FLOOD]" : "";
        return `[${t._score}pts] [${t.id}] "${t.title}" (${t.replyCount || 0}r)${spam}${flood}\n  ${(t.content || "").slice(0, 100).replace(/\n/g, " ")}`;
      }).join("\n\n");
      const spamCount = threads.length - threads.filter(t => !isSpam(t.title, t.content)).length;
      const floodNote = floodAuthors.size ? `, ${floodAuthors.size} flood author(s): ${[...floodAuthors].join(", ")}` : "";
      const header = `/${b}/ digest (${m}): ${top.length} threads shown, ${spamCount} spam filtered from ${threads.length} total${floodNote}`;
      return ok(`${header}\n\n${out}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });
}

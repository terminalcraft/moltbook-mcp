#!/usr/bin/env node

// mention-respond.mjs — Draft response generator for E sessions (wq-501)
// Takes a mention ID, loads thread context, knowledge, and engagement history,
// then outputs a structured draft response for review.

import fs from "fs";
import path from "path";
import { getFourclawCredentials, FOURCLAW_API, CHATR_API, getChatrCredentials,
         MOLTCHAN_API, getLobchanKey, LOBCHAN_API } from "./providers/credentials.js";
import { processMessages, getActiveThreads, getThreadForMessage, getThreadsForAgent } from "./chatr-thread-tracker.mjs";

const HOME = process.env.HOME || "/home/moltbot";
const CONFIG_DIR = path.join(HOME, ".config/moltbook");
const MCP_DIR = path.join(HOME, "moltbook-mcp");
const MENTIONS_PATH = path.join(CONFIG_DIR, "mentions.json");
const TRACE_PATH = path.join(CONFIG_DIR, "engagement-trace.json");
const KNOWLEDGE_PATH = path.join(MCP_DIR, "knowledge/patterns.json");
const FETCH_TIMEOUT = 8000;

// Platform API bases
const MOLTBOOK_API = "https://www.moltbook.com/api/v1";
const AICQ_BASE = "https://AICQ.chat/api/v1";
const GROVE_API = "https://grove.ctxly.app/api";
const COLONY_API = "https://thecolony.cc/api/v1";
const MDI_API = "https://mydeadinternet.com/api";

// --- Helpers ---

function loadJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, "utf8")); }
  catch { return null; }
}

async function fetchJSON(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function getCredFile(name) {
  try { return JSON.parse(fs.readFileSync(path.join(MCP_DIR, name), "utf8")); }
  catch { return null; }
}

// --- Thread Context Fetchers ---
// Each returns { thread: [{author, content, timestamp}], error: string|null }

async function fetchMoltbookThread(mention) {
  if (!mention.url) return { thread: [], error: "no URL" };
  const postId = mention.url.split("/").pop();
  if (!postId) return { thread: [], error: "bad URL" };
  const data = await fetchJSON(`${MOLTBOOK_API}/posts/${postId}`);
  if (!data) return { thread: [], error: "unreachable" };
  const post = data.post || data;
  const thread = [];
  thread.push({
    author: post.author?.name || post.author || "unknown",
    content: post.body || post.content || post.title || "",
    timestamp: post.created_at || post.createdAt || ""
  });
  const comments = post.comments || data.comments || [];
  for (const c of comments) {
    thread.push({
      author: c.author?.name || c.author || "unknown",
      content: c.body || c.content || "",
      timestamp: c.created_at || c.createdAt || ""
    });
  }
  return { thread, error: null };
}

async function fetchFourclawThread(mention) {
  if (!mention.url) return { thread: [], error: "no URL" };
  const threadId = mention.url.split("/").pop();
  const creds = getFourclawCredentials();
  const key = creds?.apiKey || creds?.api_key;
  if (!key) return { thread: [], error: "no credentials" };
  const data = await fetchJSON(`${FOURCLAW_API}/threads/${threadId}`,
    { headers: { "x-api-key": key } });
  if (!data) return { thread: [], error: "unreachable" };
  const thread = [];
  const t = data.thread || data;
  thread.push({
    author: t.author?.name || t.author || "anonymous",
    content: (t.title || "") + "\n" + (t.body || t.content || ""),
    timestamp: t.created_at || t.createdAt || ""
  });
  const replies = t.replies || t.comments || data.replies || [];
  for (const r of replies) {
    thread.push({
      author: r.author?.name || r.author || "anonymous",
      content: r.body || r.content || "",
      timestamp: r.created_at || r.createdAt || ""
    });
  }
  return { thread, error: null };
}

async function fetchChatrContext(mention) {
  // Chatr thread-aware context (wq-515): use thread tracker to find
  // conversation context instead of dumping last 20 messages
  const creds = getChatrCredentials();
  if (!creds?.apiKey) return { thread: [], error: "no credentials" };

  // Fetch recent messages for thread processing
  const data = await fetchJSON(`${CHATR_API}/messages?limit=50`,
    { headers: { "x-api-key": creds.apiKey } });
  if (!data) return { thread: [], error: "unreachable" };

  const msgs = Array.isArray(data) ? data : (data.messages || data.data || []);
  if (msgs.length === 0) return { thread: [], error: null };

  // Process messages through thread tracker
  const state = { version: 1, lastUpdate: null, lastMessageId: null, threads: {}, messageIndex: {} };
  const { state: updatedState } = processMessages(msgs, state);

  // Extract mention's message ID from the mention.id (format: "chatr-<msgId>")
  const msgId = mention.id?.replace(/^chatr-/, "") || "";

  // Try to find the thread this mention belongs to
  const mentionThread = getThreadForMessage(msgId, updatedState);

  if (mentionThread) {
    // Return only messages from the same conversation thread
    const threadMsgIds = new Set(mentionThread.messageIds);
    const threadMsgs = msgs
      .filter(m => threadMsgIds.has(String(m.id)))
      .map(m => ({
        author: m.agentId || m.author || m.sender || "unknown",
        content: m.content || m.text || m.body || "",
        timestamp: m.timestamp || m.created_at || ""
      }));

    return {
      thread: threadMsgs,
      error: null,
      threadInfo: {
        id: mentionThread.id,
        topic: mentionThread.topic,
        participants: mentionThread.participants,
        messageCount: mentionThread.messageCount,
        engaged: mentionThread.engaged
      }
    };
  }

  // Fallback: if no thread found, try matching by author
  const authorThreads = getThreadsForAgent(mention.author, updatedState);
  if (authorThreads.length > 0) {
    const bestThread = authorThreads[0]; // most recent
    const threadMsgIds = new Set(bestThread.messageIds);
    const threadMsgs = msgs
      .filter(m => threadMsgIds.has(String(m.id)))
      .map(m => ({
        author: m.agentId || m.author || m.sender || "unknown",
        content: m.content || m.text || m.body || "",
        timestamp: m.timestamp || m.created_at || ""
      }));

    return {
      thread: threadMsgs,
      error: null,
      threadInfo: {
        id: bestThread.id,
        topic: bestThread.topic,
        participants: bestThread.participants,
        messageCount: bestThread.messageCount,
        engaged: bestThread.engaged,
        matchType: "author-fallback"
      }
    };
  }

  // Final fallback: return the mention message only
  return {
    thread: [{
      author: mention.author,
      content: mention.content,
      timestamp: mention.timestamp
    }],
    error: null,
    threadInfo: null
  };
}

async function fetchMoltchanThread(mention) {
  if (!mention.url) return { thread: [], error: "no URL" };
  const threadId = mention.url.split("/").pop();
  const data = await fetchJSON(`${MOLTCHAN_API}/threads/${threadId}`);
  if (!data) return { thread: [], error: "unreachable" };
  const t = data.thread || data;
  const thread = [];
  thread.push({
    author: t.author || t.name || "anonymous",
    content: (t.title || "") + "\n" + (t.body || t.content || ""),
    timestamp: t.created_at || t.createdAt || ""
  });
  for (const r of (t.replies || t.comments || data.replies || [])) {
    thread.push({
      author: r.author || r.name || "anonymous",
      content: r.body || r.content || "",
      timestamp: r.created_at || r.createdAt || ""
    });
  }
  return { thread, error: null };
}

async function fetchGenericContext(mention) {
  // For platforms without specific thread fetching, return the mention content only
  return {
    thread: [{
      author: mention.author,
      content: mention.content,
      timestamp: mention.timestamp
    }],
    error: null
  };
}

const THREAD_FETCHERS = {
  moltbook: fetchMoltbookThread,
  "4claw": fetchFourclawThread,
  chatr: fetchChatrContext,
  moltchan: fetchMoltchanThread,
  aicq: fetchGenericContext,
  grove: fetchGenericContext,
  colony: fetchGenericContext,
  lobchan: fetchGenericContext,
  mdi: fetchGenericContext,
};

// --- Knowledge Matching ---

function findRelevantKnowledge(mention, threadContent) {
  const patterns = loadJSON(KNOWLEDGE_PATH);
  if (!patterns || !Array.isArray(patterns)) return [];

  const searchText = (threadContent + " " + mention.content).toLowerCase();
  const scored = [];

  for (const p of patterns) {
    let score = 0;
    const title = (p.title || "").toLowerCase();
    const desc = (p.description || "").toLowerCase();
    const tags = (p.tags || []).map(t => t.toLowerCase());

    // Check keyword overlap
    const words = searchText.split(/\s+/).filter(w => w.length > 3);
    for (const w of words) {
      if (title.includes(w)) score += 3;
      if (desc.includes(w)) score += 1;
      if (tags.some(t => t.includes(w))) score += 2;
    }

    if (score > 0) scored.push({ pattern: p, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.pattern);
}

// --- Engagement History ---

function getAuthorHistory(author, traces) {
  const history = [];
  for (const trace of traces) {
    const agents = trace.agents_interacted || [];
    const normalizedAuthor = author.startsWith("@") ? author : `@${author}`;
    if (agents.some(a => a.toLowerCase() === normalizedAuthor.toLowerCase())) {
      history.push({
        session: trace.session,
        date: trace.date,
        platforms: trace.platforms_engaged || [],
        topics: trace.topics || []
      });
    }
  }
  return history.slice(-5); // last 5 interactions
}

function getPlatformHistory(platform, traces) {
  const history = [];
  for (const trace of traces) {
    const engaged = (trace.platforms_engaged || []).map(p => p.toLowerCase());
    if (engaged.includes(platform.toLowerCase())) {
      for (const tc of (trace.threads_contributed || [])) {
        if (tc.platform?.toLowerCase() === platform.toLowerCase() && tc.action !== "read") {
          history.push({ session: trace.session, topic: tc.topic, action: tc.action });
        }
      }
    }
  }
  return history.slice(-5);
}

// --- Draft Generation ---

function generateDraft(mention, threadContext, knowledge, authorHistory, platformHistory) {
  const sections = [];

  // Header
  sections.push(`# Draft Response for Mention ${mention.id}`);
  sections.push(`Platform: ${mention.platform} | Author: @${mention.author} | ${mention.timestamp || "unknown time"}`);
  if (mention.url) sections.push(`URL: ${mention.url}`);
  sections.push("");

  // Mention content
  sections.push("## Mention Content");
  sections.push(mention.content);
  sections.push("");

  // Thread context
  if (threadContext.thread.length > 1) {
    sections.push("## Thread Context");
    if (threadContext.threadInfo) {
      sections.push(`Conversation: ${threadContext.threadInfo.topic} (${threadContext.threadInfo.messageCount} msgs)`);
      sections.push(`Participants: ${threadContext.threadInfo.participants.map(p => `@${p}`).join(", ")}`);
      if (threadContext.threadInfo.engaged) sections.push("Status: We participated in this conversation");
      if (threadContext.threadInfo.matchType === "author-fallback") sections.push("(Thread matched by author, not exact message)");
      sections.push("");
    }
    for (const msg of threadContext.thread.slice(-10)) {
      sections.push(`@${msg.author}: ${msg.content.slice(0, 200)}`);
    }
    sections.push("");
  }

  // Author relationship
  if (authorHistory.length > 0) {
    sections.push("## Prior Interactions with @" + mention.author);
    for (const h of authorHistory) {
      sections.push(`- s${h.session} (${h.date}): ${h.topics.slice(0, 2).join(", ")}`);
    }
    sections.push("");
  }

  // Platform history
  if (platformHistory.length > 0) {
    sections.push("## Recent Activity on " + mention.platform);
    for (const h of platformHistory) {
      sections.push(`- s${h.session}: ${h.action} — ${h.topic?.slice(0, 100) || "?"}`);
    }
    sections.push("");
  }

  // Relevant knowledge
  if (knowledge.length > 0) {
    sections.push("## Relevant Knowledge Patterns");
    for (const k of knowledge) {
      sections.push(`- [${k.category || "?"}] ${k.title}: ${(k.description || "").slice(0, 150)}`);
    }
    sections.push("");
  }

  // Response guidance
  sections.push("## Response Guidelines");
  const isDirect = mention.direct || /\b@moltbook\b/i.test(mention.content);
  const isQuestion = /\?/.test(mention.content);

  if (isDirect && isQuestion) {
    sections.push("- Direct question to @moltbook. Prioritize a clear, helpful answer.");
    sections.push("- Draw from knowledge patterns above if applicable.");
  } else if (isDirect) {
    sections.push("- Direct mention. Acknowledge and contribute if you have something substantive.");
    sections.push("- Avoid low-value replies (don't just say 'thanks' or 'agreed').");
  } else {
    sections.push("- Keyword mention (not direct @). Only respond if you have genuine value to add.");
    sections.push("- Consider whether engagement adds to the conversation or is noise.");
  }

  if (authorHistory.length > 0) {
    sections.push("- You have history with this author. Reference shared context if natural.");
  }

  sections.push("- Keep response concise and practical. Build on the thread, don't repeat it.");
  sections.push("");

  // Draft placeholder
  sections.push("## Suggested Draft");
  sections.push("[E session: compose your response here using the context above]");

  return sections.join("\n");
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    console.log(`Usage: mention-respond.mjs <mention-id> [--json]

Generates a draft response context for a mention from mentions.json.

Options:
  <mention-id>   The mention ID (e.g., "4claw-abc123" or "chatr-xyz")
  --json         Output as JSON instead of markdown
  --list         List unread mentions with IDs for quick reference
  --help         Show this help

Example:
  node mention-respond.mjs chatr-msg123
  node mention-respond.mjs --list`);
    return;
  }

  if (args.includes("--list")) {
    const state = loadJSON(MENTIONS_PATH);
    if (!state?.mentions) { console.log("No mentions found."); return; }
    const unread = state.mentions.filter(m => !m.read);
    if (unread.length === 0) { console.log("No unread mentions."); return; }
    console.log(`${unread.length} unread mention(s):\n`);
    for (const m of unread.slice(-20)) {
      const flag = /\b@moltbook\b/i.test(m.content) ? "@" : " ";
      console.log(`${flag} ${m.id}  [${m.platform}] @${m.author}: ${m.content.slice(0, 80)}`);
    }
    return;
  }

  const mentionId = args.find(a => !a.startsWith("--"));
  const jsonFlag = args.includes("--json");

  if (!mentionId) {
    console.error("Error: provide a mention ID. Use --list to see available mentions.");
    process.exit(1);
  }

  // Load mention
  const state = loadJSON(MENTIONS_PATH);
  if (!state?.mentions) {
    console.error("Error: cannot read mentions.json. Run mention-scan first.");
    process.exit(1);
  }

  let mention = state.mentions.find(m => m.id === mentionId);
  if (!mention) {
    // Try partial match
    mention = state.mentions.find(m => m.id.includes(mentionId));
    if (!mention) {
      console.error(`Error: mention "${mentionId}" not found. Use --list to see available IDs.`);
      process.exit(1);
    }
    console.error(`Partial match: using ${mention.id}`);
  }

  return main_with_mention(mention, jsonFlag);
}

export { loadJSON, MENTIONS_PATH };

export async function main_with_mention(mention, jsonFlag) {
  const platform = mention.platform.toLowerCase();

  // Fetch thread context
  console.error(`[mention-respond] Fetching thread context from ${mention.platform}...`);
  const fetcher = THREAD_FETCHERS[platform] || fetchGenericContext;
  const threadContext = await fetcher(mention);
  if (threadContext.error) {
    console.error(`[mention-respond] Thread fetch warning: ${threadContext.error}`);
  }

  // Load engagement traces
  const traces = loadJSON(TRACE_PATH) || [];

  // Build full thread text for knowledge matching
  const fullText = threadContext.thread.map(m => m.content).join(" ");

  // Find relevant knowledge
  const knowledge = findRelevantKnowledge(mention, fullText);

  // Get author and platform history
  const authorHistory = getAuthorHistory(mention.author, traces);
  const platformHistory = getPlatformHistory(mention.platform, traces);

  const result = {
    mention,
    thread: threadContext.thread,
    thread_error: threadContext.error,
    knowledge: knowledge.map(k => ({ title: k.title, category: k.category, description: k.description })),
    author_history: authorHistory,
    platform_history: platformHistory,
    is_direct: /\b@moltbook\b/i.test(mention.content),
    is_question: /\?/.test(mention.content)
  };

  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  // Generate markdown draft
  const draft = generateDraft(mention, threadContext, knowledge, authorHistory, platformHistory);
  console.log(draft);
  return result;
}

// Only run CLI when executed directly (not when imported as module)
const isDirectRun = process.argv[1] && process.argv[1].endsWith("mention-respond.mjs");
if (isDirectRun) {
  main().catch(e => {
    console.error(`[mention-respond] Fatal: ${e.message}`);
    process.exit(1);
  });
}

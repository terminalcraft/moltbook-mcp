#!/usr/bin/env node

// chatr-thread-tracker.mjs — Synthetic conversation threading for Chatr (wq-515)
// Chatr has no native threading. This module clusters messages into conversations
// using @mention chains, temporal proximity, and topic continuity.
// E sessions consume thread context to make contextual follow-ups.

import fs from "fs";
import path from "path";
import { getChatrCredentials, CHATR_API } from "./providers/credentials.js";

const HOME = process.env.HOME || "/home/moltbot";
const CONFIG_DIR = path.join(HOME, ".config/moltbook");
const THREADS_PATH = path.join(CONFIG_DIR, "chatr-threads.json");
const TRACE_PATH = path.join(CONFIG_DIR, "engagement-trace.json");
const FETCH_TIMEOUT = 8000;

// --- Configuration ---
const THREAD_WINDOW_MS = 30 * 60 * 1000;  // 30-minute window for conversation grouping
const MIN_THREAD_MESSAGES = 2;              // Minimum messages to form a thread
const MAX_THREADS = 50;                     // Max threads to keep in state
const OUR_HANDLE = "moltbook";

// --- Helpers ---

function loadJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, "utf8")); }
  catch { return null; }
}

function saveJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
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

// --- Thread State ---

function loadThreadState() {
  return loadJSON(THREADS_PATH) || {
    version: 1,
    lastUpdate: null,
    lastMessageId: null,
    threads: {},       // threadId -> thread object
    messageIndex: {}   // messageId -> threadId (reverse lookup)
  };
}

function saveThreadState(state) {
  state.lastUpdate = new Date().toISOString();
  // Prune old threads beyond MAX_THREADS (keep most recent by lastActivity)
  const threadIds = Object.keys(state.threads);
  if (threadIds.length > MAX_THREADS) {
    const sorted = threadIds
      .map(id => ({ id, lastActivity: state.threads[id].lastActivity }))
      .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
    const keep = new Set(sorted.slice(0, MAX_THREADS).map(t => t.id));
    for (const id of threadIds) {
      if (!keep.has(id)) {
        // Clean up message index references
        for (const msgId of state.threads[id].messageIds) {
          delete state.messageIndex[msgId];
        }
        delete state.threads[id];
      }
    }
  }
  saveJSON(THREADS_PATH, state);
}

// --- Mention Extraction ---

function extractMentions(content) {
  const mentions = [];
  const re = /@(\w+)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    mentions.push(match[1].toLowerCase());
  }
  return mentions;
}

// --- Topic Fingerprint ---
// Simple keyword extraction for topic similarity detection.
// Filters stopwords, keeps substantive words for matching.

const STOP_WORDS = new Set([
  "the", "is", "at", "which", "on", "a", "an", "and", "or", "but", "in",
  "to", "for", "of", "with", "that", "this", "it", "not", "are", "was",
  "be", "has", "have", "had", "do", "does", "did", "will", "would",
  "can", "could", "should", "may", "might", "just", "also", "very",
  "too", "so", "than", "then", "now", "how", "what", "when", "where",
  "who", "why", "all", "each", "every", "both", "few", "more", "most",
  "other", "some", "such", "no", "nor", "only", "own", "same", "from",
  "into", "about", "between", "through", "during", "before", "after",
  "above", "below", "up", "down", "out", "off", "over", "under", "again",
  "further", "once", "here", "there", "if", "its", "you", "your", "im",
  "ive", "dont", "wont", "cant", "youre", "thats", "been"
]);

function getTopicWords(content) {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));
}

function topicSimilarity(wordsA, wordsB) {
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let overlap = 0;
  for (const w of setA) {
    if (setB.has(w)) overlap++;
  }
  // Jaccard similarity
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : overlap / union;
}

// --- Conversation Clustering ---

function findBestThread(msg, state, recentMessages) {
  const mentions = extractMentions(msg.content || "");
  const msgWords = getTopicWords(msg.content || "");
  const msgAgent = (msg.agentId || msg.author || "").toLowerCase();

  let bestThreadId = null;
  let bestScore = 0;

  for (const [threadId, thread] of Object.entries(state.threads)) {
    let score = 0;

    // 1. Direct mention chain: message mentions a thread participant
    const threadParticipants = new Set(thread.participants.map(p => p.toLowerCase()));
    for (const m of mentions) {
      if (threadParticipants.has(m)) score += 3;
    }

    // 2. Reverse mention: a thread participant mentions this message's author
    if (threadParticipants.has(msgAgent)) score += 2;

    // 3. Author is replying to someone who was in the thread
    // Check if the @mentioned agent recently posted in this thread
    const threadMsgIds = new Set(thread.messageIds);
    for (const recent of recentMessages) {
      if (threadMsgIds.has(String(recent.id))) {
        const recentAgent = (recent.agentId || recent.author || "").toLowerCase();
        if (mentions.includes(recentAgent)) score += 4; // strong signal: replying to thread participant
      }
    }

    // 4. Topic similarity
    const similarity = topicSimilarity(msgWords, thread.topicWords || []);
    score += similarity * 3;

    // 5. Temporal proximity - prefer recent threads
    const threadAge = Date.now() - new Date(thread.lastActivity).getTime();
    if (threadAge < THREAD_WINDOW_MS) score += 2;
    else if (threadAge < THREAD_WINDOW_MS * 2) score += 1;
    else score -= 1; // penalize stale threads

    if (score > bestScore) {
      bestScore = score;
      bestThreadId = threadId;
    }
  }

  // Minimum score threshold to join existing thread
  return bestScore >= 3 ? bestThreadId : null;
}

function generateThreadId(msg) {
  const agent = (msg.agentId || msg.author || "unknown").toLowerCase();
  const mentions = extractMentions(msg.content || "");
  const participants = [agent, ...mentions].sort().join("-");
  const ts = Date.now().toString(36);
  return `chatr-${participants.slice(0, 30)}-${ts}`;
}

function deriveTopicLabel(thread) {
  // Get the most common substantive words across all messages as a topic label
  const wordCounts = {};
  for (const w of (thread.topicWords || [])) {
    wordCounts[w] = (wordCounts[w] || 0) + 1;
  }
  const sorted = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);
  return sorted.join(", ") || "general chat";
}

// --- Core: Process Messages ---

export function processMessages(messages, state) {
  if (!state) state = loadThreadState();
  const newThreads = [];
  const updatedThreads = [];

  // Sort messages by ID (sequential/chronological)
  const sorted = [...messages].sort((a, b) => {
    const idA = parseInt(a.id, 10) || 0;
    const idB = parseInt(b.id, 10) || 0;
    return idA - idB;
  });

  for (const msg of sorted) {
    const msgId = String(msg.id);

    // Skip if already indexed
    if (state.messageIndex[msgId]) continue;

    const agent = (msg.agentId || msg.author || "unknown").toLowerCase();
    const content = msg.content || msg.text || msg.body || "";
    const timestamp = msg.timestamp || msg.created_at || new Date().toISOString();
    const msgWords = getTopicWords(content);

    // Try to find an existing thread for this message
    const existingThreadId = findBestThread(msg, state, sorted);

    if (existingThreadId) {
      // Add to existing thread
      const thread = state.threads[existingThreadId];
      thread.messageIds.push(msgId);
      thread.lastActivity = timestamp;
      if (!thread.participants.includes(agent)) {
        thread.participants.push(agent);
      }
      thread.topicWords = [...(thread.topicWords || []), ...msgWords].slice(-100);
      thread.topic = deriveTopicLabel(thread);
      thread.messageCount = thread.messageIds.length;
      state.messageIndex[msgId] = existingThreadId;

      if (!updatedThreads.includes(existingThreadId)) {
        updatedThreads.push(existingThreadId);
      }
    } else {
      // Create new thread
      const threadId = generateThreadId(msg);
      const mentions = extractMentions(content);
      const participants = [agent, ...mentions.filter(m => m !== agent)];

      state.threads[threadId] = {
        id: threadId,
        messageIds: [msgId],
        participants,
        topicWords: msgWords,
        topic: msgWords.slice(0, 3).join(", ") || "general",
        firstActivity: timestamp,
        lastActivity: timestamp,
        messageCount: 1,
        engaged: false  // whether we've participated
      };
      state.messageIndex[msgId] = threadId;
      newThreads.push(threadId);
    }
  }

  // Mark threads where we participated
  for (const thread of Object.values(state.threads)) {
    thread.engaged = thread.participants.includes(OUR_HANDLE);
  }

  // Update last seen message ID
  if (sorted.length > 0) {
    const lastId = String(sorted[sorted.length - 1].id);
    const currentLast = parseInt(state.lastMessageId || "0", 10);
    const newLast = parseInt(lastId, 10);
    if (newLast > currentLast) {
      state.lastMessageId = lastId;
    }
  }

  return { state, newThreads, updatedThreads };
}

// --- Query API ---

/** Get all active threads, sorted by most recent activity */
export function getActiveThreads(state, opts = {}) {
  if (!state) state = loadThreadState();
  const maxAge = opts.maxAge || 24 * 60 * 60 * 1000; // default 24h
  const now = Date.now();

  return Object.values(state.threads)
    .filter(t => {
      const age = now - new Date(t.lastActivity).getTime();
      if (age > maxAge) return false;
      if (opts.minMessages && t.messageCount < opts.minMessages) return false;
      if (opts.engagedOnly && !t.engaged) return false;
      if (opts.unengagedOnly && t.engaged) return false;
      return true;
    })
    .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
}

/** Get thread context for a specific message ID */
export function getThreadForMessage(messageId, state) {
  if (!state) state = loadThreadState();
  const threadId = state.messageIndex[String(messageId)];
  if (!threadId) return null;
  return state.threads[threadId] || null;
}

/** Get threads involving a specific agent */
export function getThreadsForAgent(agentName, state) {
  if (!state) state = loadThreadState();
  const normalized = agentName.toLowerCase().replace(/^@/, "");
  return Object.values(state.threads)
    .filter(t => t.participants.includes(normalized))
    .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
}

/** Get threads we participated in but haven't followed up on */
export function getStaleEngagements(state, opts = {}) {
  if (!state) state = loadThreadState();
  const staleAfter = opts.staleAfter || 6 * 60 * 60 * 1000; // 6h default
  const now = Date.now();

  return Object.values(state.threads)
    .filter(t => {
      if (!t.engaged) return false;
      const age = now - new Date(t.lastActivity).getTime();
      // Thread has activity after we might have last checked, but not too old
      return age > staleAfter && age < 48 * 60 * 60 * 1000;
    })
    .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
}

// --- Fetch & Update ---

export async function fetchAndUpdate() {
  const creds = getChatrCredentials();
  if (!creds?.apiKey) {
    return { error: "no chatr credentials", state: null };
  }

  const state = loadThreadState();
  const sinceParam = state.lastMessageId ? `&since=${state.lastMessageId}` : "";
  const data = await fetchJSON(`${CHATR_API}/messages?limit=50${sinceParam}`,
    { headers: { "x-api-key": creds.apiKey } });

  if (!data) {
    return { error: "chatr unreachable", state };
  }

  const msgs = Array.isArray(data) ? data : (data.messages || data.data || []);
  if (msgs.length === 0) {
    return { error: null, state, newThreads: [], updatedThreads: [] };
  }

  const result = processMessages(msgs, state);
  saveThreadState(result.state);

  return {
    error: null,
    state: result.state,
    newThreads: result.newThreads,
    updatedThreads: result.updatedThreads,
    messagesProcessed: msgs.length
  };
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(`Usage: chatr-thread-tracker.mjs [command] [options]

Commands:
  update          Fetch new messages and update thread state (default)
  threads         List active conversation threads
  thread <id>     Show details for a specific thread
  agent <name>    Show threads involving an agent
  stale           Show engaged threads needing follow-up
  context <msgId> Get thread context for a message

Options:
  --json          Output as JSON
  --hours=N       Max thread age in hours (default: 24)
  --help          Show this help`);
    return;
  }

  const command = args.find(a => !a.startsWith("--")) || "update";
  const jsonFlag = args.includes("--json");
  const hoursArg = args.find(a => a.startsWith("--hours="));
  const maxHours = hoursArg ? parseInt(hoursArg.split("=")[1], 10) : 24;
  const maxAge = maxHours * 60 * 60 * 1000;

  if (command === "update") {
    console.error("[chatr-threads] Fetching new messages...");
    const result = await fetchAndUpdate();
    if (result.error) {
      console.error(`[chatr-threads] Error: ${result.error}`);
      if (!result.state) process.exit(1);
    }
    const threadCount = result.state ? Object.keys(result.state.threads).length : 0;
    console.error(`[chatr-threads] ${result.messagesProcessed || 0} messages processed, ${threadCount} threads tracked`);
    if (result.newThreads?.length > 0) {
      console.error(`[chatr-threads] New threads: ${result.newThreads.length}`);
    }
    if (result.updatedThreads?.length > 0) {
      console.error(`[chatr-threads] Updated threads: ${result.updatedThreads.length}`);
    }

    // Show active threads summary
    const active = getActiveThreads(result.state, { maxAge, minMessages: MIN_THREAD_MESSAGES });
    if (jsonFlag) {
      console.log(JSON.stringify({ threads: active, total: threadCount }));
    } else {
      outputThreadSummary(active);
    }
    return;
  }

  if (command === "threads") {
    const state = loadThreadState();
    const active = getActiveThreads(state, { maxAge, minMessages: MIN_THREAD_MESSAGES });
    if (jsonFlag) {
      console.log(JSON.stringify(active));
    } else {
      outputThreadSummary(active);
    }
    return;
  }

  if (command === "thread") {
    const threadId = args[args.indexOf("thread") + 1];
    if (!threadId) { console.error("Usage: thread <id>"); process.exit(1); }
    const state = loadThreadState();
    const thread = state.threads[threadId];
    if (!thread) {
      // Try partial match
      const match = Object.keys(state.threads).find(k => k.includes(threadId));
      if (match) {
        outputThreadDetail(state.threads[match], jsonFlag);
      } else {
        console.error(`Thread not found: ${threadId}`);
        process.exit(1);
      }
    } else {
      outputThreadDetail(thread, jsonFlag);
    }
    return;
  }

  if (command === "agent") {
    const agentName = args[args.indexOf("agent") + 1];
    if (!agentName) { console.error("Usage: agent <name>"); process.exit(1); }
    const state = loadThreadState();
    const threads = getThreadsForAgent(agentName, state);
    if (jsonFlag) {
      console.log(JSON.stringify(threads));
    } else {
      console.log(`Threads involving @${agentName}: ${threads.length}`);
      outputThreadSummary(threads);
    }
    return;
  }

  if (command === "stale") {
    const state = loadThreadState();
    const stale = getStaleEngagements(state);
    if (jsonFlag) {
      console.log(JSON.stringify(stale));
    } else {
      if (stale.length === 0) {
        console.log("No stale engagements needing follow-up.");
      } else {
        console.log(`${stale.length} engaged thread(s) may need follow-up:`);
        outputThreadSummary(stale);
      }
    }
    return;
  }

  if (command === "context") {
    const msgId = args[args.indexOf("context") + 1];
    if (!msgId) { console.error("Usage: context <messageId>"); process.exit(1); }
    const state = loadThreadState();
    const thread = getThreadForMessage(msgId, state);
    if (!thread) {
      console.error(`No thread found for message ${msgId}`);
      process.exit(1);
    }
    outputThreadDetail(thread, jsonFlag);
    return;
  }

  console.error(`Unknown command: ${command}. Use --help for usage.`);
  process.exit(1);
}

function outputThreadSummary(threads) {
  if (threads.length === 0) {
    console.log("No active conversation threads.");
    return;
  }
  console.log(`\n--- ${threads.length} Active Thread(s) ---`);
  for (const t of threads) {
    const engaged = t.engaged ? " [engaged]" : "";
    const age = timeSince(t.lastActivity);
    const participants = t.participants.slice(0, 4).map(p => `@${p}`).join(", ");
    const extra = t.participants.length > 4 ? ` +${t.participants.length - 4}` : "";
    console.log(`[${t.messageCount} msgs] ${age} | ${t.topic} | ${participants}${extra}${engaged}`);
    console.log(`  id: ${t.id}`);
  }
}

function outputThreadDetail(thread, jsonFlag) {
  if (jsonFlag) {
    console.log(JSON.stringify(thread, null, 2));
    return;
  }
  console.log(`Thread: ${thread.id}`);
  console.log(`Topic: ${thread.topic}`);
  console.log(`Messages: ${thread.messageCount}`);
  console.log(`Participants: ${thread.participants.map(p => `@${p}`).join(", ")}`);
  console.log(`First activity: ${thread.firstActivity}`);
  console.log(`Last activity: ${thread.lastActivity}`);
  console.log(`Engaged: ${thread.engaged ? "yes" : "no"}`);
  console.log(`Message IDs: ${thread.messageIds.join(", ")}`);
}

function timeSince(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
  return `${Math.round(ms / 86400000)}d ago`;
}

// Only run CLI when executed directly
const isDirectRun = process.argv[1] && process.argv[1].endsWith("chatr-thread-tracker.mjs");
if (isDirectRun) {
  main().catch(e => {
    console.error(`[chatr-threads] Fatal: ${e.message}`);
    process.exit(1);
  });
}

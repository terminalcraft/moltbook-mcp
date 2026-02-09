import { z } from "zod";
import fs from "fs";
import path from "path";
import { getFourclawCredentials, FOURCLAW_API, CHATR_API, getChatrCredentials, MOLTCHAN_API } from "../providers/credentials.js";
import { main_with_mention, loadJSON as loadJSONFromRespond, MENTIONS_PATH as RESPOND_MENTIONS_PATH } from "../mention-respond.mjs";

// Cross-platform mention aggregator (wq-463)
// Scans active platforms for @moltbook mentions, writes unified feed to mentions.json

const MENTIONS_PATH = path.join(process.env.HOME || "/home/moltbot", ".config/moltbook/mentions.json");
const MOLTBOOK_API = "https://www.moltbook.com/api/v1";
const AICQ_BASE = "https://AICQ.chat/api/v1";
const SCAN_TIMEOUT = 8000;

function ok(msg) { return { content: [{ type: "text", text: msg }] }; }
function err(msg) { return { content: [{ type: "text", text: `Error: ${msg}` }] }; }

function loadMentions() {
  try {
    return JSON.parse(fs.readFileSync(MENTIONS_PATH, "utf8"));
  } catch {
    return { version: 1, lastScan: null, mentions: [], seenIds: [] };
  }
}

function saveMentions(data) {
  // Keep last 200 mentions and 500 seen IDs
  data.mentions = data.mentions.slice(-200);
  data.seenIds = data.seenIds.slice(-500);
  fs.writeFileSync(MENTIONS_PATH, JSON.stringify(data, null, 2));
}

async function fetchWithTimeout(url, opts = {}, timeout = SCAN_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
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

// Platform scanners — each returns { mentions: [{id, platform, author, content, url, timestamp}], errors: [] }
async function scanMoltbook() {
  const results = { mentions: [], errors: [] };
  try {
    const data = await fetchWithTimeout(`${MOLTBOOK_API}/search?q=moltbook&limit=20&type=all`);
    if (!data) { results.errors.push("moltbook: fetch failed"); return results; }
    const items = data.results || data.posts || data.data || [];
    for (const item of items) {
      const content = item.title || item.body || item.content || "";
      if (/\bmoltbook\b/i.test(content) || /\b@moltbook\b/i.test(content)) {
        results.mentions.push({
          id: `moltbook-${item.id || item._id}`,
          platform: "Moltbook",
          author: item.author?.name || item.author || "unknown",
          content: content.slice(0, 300),
          url: item.id ? `https://www.moltbook.com/post/${item.id}` : null,
          timestamp: item.created_at || item.createdAt || new Date().toISOString()
        });
      }
    }
  } catch (e) { results.errors.push(`moltbook: ${e.message}`); }
  return results;
}

async function scanFourclaw() {
  const results = { mentions: [], errors: [] };
  try {
    const creds = getFourclawCredentials();
    if (!creds?.apiKey) { results.errors.push("4claw: no credentials"); return results; }
    const headers = { "x-api-key": creds.apiKey };
    const data = await fetchWithTimeout(`${FOURCLAW_API}/search?q=moltbook&limit=20`, { headers });
    if (!data) { results.errors.push("4claw: fetch failed"); return results; }
    const items = data.results || data.threads || data.data || [];
    for (const item of items) {
      const content = item.title || item.body || item.content || "";
      results.mentions.push({
        id: `4claw-${item.id || item._id}`,
        platform: "4claw",
        author: item.author?.name || item.author || "anonymous",
        content: content.slice(0, 300),
        url: item.id ? `https://www.4claw.org/thread/${item.id}` : null,
        timestamp: item.created_at || item.createdAt || new Date().toISOString()
      });
    }
  } catch (e) { results.errors.push(`4claw: ${e.message}`); }
  return results;
}

async function scanChatr() {
  const results = { mentions: [], errors: [] };
  try {
    const creds = getChatrCredentials();
    if (!creds?.apiKey) { results.errors.push("chatr: no credentials"); return results; }
    const headers = { "x-api-key": creds.apiKey };
    const data = await fetchWithTimeout(`${CHATR_API}/messages?limit=50`, { headers });
    if (!data) { results.errors.push("chatr: fetch failed"); return results; }
    const messages = data.messages || data.data || data || [];
    if (!Array.isArray(messages)) { return results; }
    for (const msg of messages) {
      const content = msg.content || msg.text || msg.body || "";
      if (/\bmoltbook\b/i.test(content) || /\b@moltbook\b/i.test(content)) {
        results.mentions.push({
          id: `chatr-${msg.id || msg._id}`,
          platform: "Chatr",
          author: msg.agentId || msg.author || msg.sender || "unknown",
          content: content.slice(0, 300),
          url: null,
          timestamp: msg.timestamp || msg.created_at || new Date().toISOString()
        });
      }
    }
  } catch (e) { results.errors.push(`chatr: ${e.message}`); }
  return results;
}

async function scanMoltchan() {
  const results = { mentions: [], errors: [] };
  try {
    const data = await fetchWithTimeout(`${MOLTCHAN_API}/search?q=moltbook&limit=20`);
    if (!data) { results.errors.push("moltchan: fetch failed"); return results; }
    const items = data.results || data.threads || data.data || [];
    for (const item of items) {
      const content = item.title || item.body || item.content || "";
      results.mentions.push({
        id: `moltchan-${item.id || item._id}`,
        platform: "Moltchan",
        author: item.author || item.name || "anonymous",
        content: content.slice(0, 300),
        url: item.id ? `https://www.moltchan.org/thread/${item.id}` : null,
        timestamp: item.created_at || item.createdAt || new Date().toISOString()
      });
    }
  } catch (e) { results.errors.push(`moltchan: ${e.message}`); }
  return results;
}

async function scanAicq() {
  const results = { mentions: [], errors: [] };
  try {
    const credPath = path.join(process.env.HOME || "/home/moltbot", "moltbook-mcp", ".aicq-credentials.json");
    let token;
    try { token = JSON.parse(fs.readFileSync(credPath, "utf8")).token; } catch { /* ignore */ }
    if (!token) { results.errors.push("aicq: no credentials"); return results; }
    const headers = { "Authorization": `Bearer ${token}` };
    const data = await fetchWithTimeout(`${AICQ_BASE}/messages?limit=50`, { headers });
    if (!data) { results.errors.push("aicq: fetch failed"); return results; }
    const messages = data.messages || data.data || data || [];
    if (!Array.isArray(messages)) { return results; }
    for (const msg of messages) {
      const content = msg.content || msg.text || msg.body || "";
      if (/\bmoltbook\b/i.test(content) || /\b@moltbook\b/i.test(content)) {
        results.mentions.push({
          id: `aicq-${msg.id || msg._id}`,
          platform: "AICQ",
          author: msg.username || msg.author || "unknown",
          content: content.slice(0, 300),
          url: null,
          timestamp: msg.timestamp || msg.created_at || new Date().toISOString()
        });
      }
    }
  } catch (e) { results.errors.push(`aicq: ${e.message}`); }
  return results;
}

export function register(server, ctx) {
  server.tool("mentions_scan", "Scan all active platforms for @moltbook mentions. Returns new mentions since last scan.", {
    force: z.boolean().optional().describe("Force full rescan even if recently scanned")
  }, async ({ force }) => {
    const state = loadMentions();
    const seenSet = new Set(state.seenIds);

    // Rate limit: don't scan more than once per 5 minutes unless forced
    if (!force && state.lastScan) {
      const elapsed = Date.now() - new Date(state.lastScan).getTime();
      if (elapsed < 5 * 60 * 1000) {
        const unread = state.mentions.filter(m => !m.read);
        return ok(`Last scan ${Math.round(elapsed / 1000)}s ago. ${unread.length} unread mentions. Use force=true to rescan.`);
      }
    }

    // Run all platform scans in parallel
    const [moltbook, fourclaw, chatr, moltchan, aicq] = await Promise.all([
      scanMoltbook(), scanFourclaw(), scanChatr(), scanMoltchan(), scanAicq()
    ]);

    const allResults = [moltbook, fourclaw, chatr, moltchan, aicq];
    const allErrors = allResults.flatMap(r => r.errors);
    let newMentions = 0;

    for (const result of allResults) {
      for (const mention of result.mentions) {
        if (!seenSet.has(mention.id)) {
          seenSet.add(mention.id);
          state.seenIds.push(mention.id);
          state.mentions.push({ ...mention, read: false });
          newMentions++;
        }
      }
    }

    state.lastScan = new Date().toISOString();
    saveMentions(state);

    const unread = state.mentions.filter(m => !m.read);
    const lines = [`Scan complete: ${newMentions} new mentions found, ${unread.length} total unread.`];
    if (allErrors.length > 0) lines.push(`Errors: ${allErrors.join("; ")}`);
    if (newMentions > 0) {
      lines.push("\n--- New mentions ---");
      for (const m of state.mentions.slice(-newMentions)) {
        lines.push(`[${m.platform}] @${m.author}: ${m.content.slice(0, 120)}${m.content.length > 120 ? "..." : ""}`);
      }
    }
    return ok(lines.join("\n"));
  });

  server.tool("mentions_list", "List recent mentions. Filter by platform or show unread only.", {
    platform: z.string().optional().describe("Filter by platform name"),
    unread: z.boolean().optional().describe("Show only unread mentions"),
    limit: z.number().optional().describe("Max mentions to show (default 20)")
  }, async ({ platform, unread, limit }) => {
    const state = loadMentions();
    let mentions = state.mentions;
    if (platform) mentions = mentions.filter(m => m.platform.toLowerCase() === platform.toLowerCase());
    if (unread) mentions = mentions.filter(m => !m.read);
    mentions = mentions.slice(-(limit || 20));

    if (mentions.length === 0) return ok("No mentions found matching filters.");

    const lines = [`${mentions.length} mention(s):`];
    for (const m of mentions) {
      const flag = m.read ? " " : "*";
      const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(0, 16) : "?";
      lines.push(`${flag} [${m.platform}] ${ts} @${m.author}: ${m.content.slice(0, 120)}`);
    }
    return ok(lines.join("\n"));
  });

  server.tool("mentions_mark_read", "Mark mentions as read by platform or mark all read.", {
    platform: z.string().optional().describe("Mark only mentions from this platform as read"),
    all: z.boolean().optional().describe("Mark all mentions as read")
  }, async ({ platform, all }) => {
    const state = loadMentions();
    let count = 0;
    for (const m of state.mentions) {
      if (m.read) continue;
      if (all || (platform && m.platform.toLowerCase() === platform.toLowerCase())) {
        m.read = true;
        count++;
      }
    }
    if (!all && !platform) return err("Specify platform or all=true");
    saveMentions(state);
    return ok(`Marked ${count} mention(s) as read.`);
  });

  server.tool("mentions_draft_response", "Generate structured draft response context for a mention. Returns thread context, relevant knowledge, author history, and response guidelines.", {
    mention_id: z.string().describe("The mention ID (e.g. '4claw-abc123', 'chatr-xyz'). Use mentions_list to find IDs.")
  }, async ({ mention_id }) => {
    const state = loadMentions();
    if (!state?.mentions) return err("No mentions found. Run mentions_scan first.");

    // Find mention by exact or partial match
    let mention = state.mentions.find(m => m.id === mention_id);
    if (!mention) {
      mention = state.mentions.find(m => m.id.includes(mention_id));
    }
    if (!mention) return err(`Mention "${mention_id}" not found. Use mentions_list to see available IDs.`);

    try {
      const result = await main_with_mention(mention, true);
      if (!result) return err("Failed to generate draft context.");

      // Format as structured text for E session consumption
      const lines = [];
      lines.push(`## Draft Context for ${mention.id}`);
      lines.push(`Platform: ${result.mention.platform} | Author: @${result.mention.author}`);
      lines.push(`Direct: ${result.is_direct ? "yes" : "no"} | Question: ${result.is_question ? "yes" : "no"}`);
      if (result.thread_error) lines.push(`Thread fetch warning: ${result.thread_error}`);
      lines.push("");

      // Thread context
      if (result.thread.length > 0) {
        lines.push("### Thread Context");
        for (const msg of result.thread.slice(-10)) {
          lines.push(`@${msg.author}: ${(msg.content || "").slice(0, 200)}`);
        }
        lines.push("");
      }

      // Knowledge
      if (result.knowledge.length > 0) {
        lines.push("### Relevant Knowledge");
        for (const k of result.knowledge) {
          lines.push(`- [${k.category}] ${k.title}: ${(k.description || "").slice(0, 150)}`);
        }
        lines.push("");
      }

      // Author history
      if (result.author_history.length > 0) {
        lines.push(`### Prior Interactions with @${mention.author}`);
        for (const h of result.author_history) {
          lines.push(`- s${h.session} (${h.date}): ${(h.topics || []).slice(0, 2).join(", ")}`);
        }
        lines.push("");
      }

      // Response guidelines
      lines.push("### Response Guidelines");
      if (result.is_direct && result.is_question) {
        lines.push("- Direct question. Prioritize a clear, helpful answer.");
      } else if (result.is_direct) {
        lines.push("- Direct mention. Contribute if you have something substantive.");
      } else {
        lines.push("- Keyword mention. Only respond if you have genuine value to add.");
      }
      if (result.author_history.length > 0) {
        lines.push("- You have history with this author. Reference shared context if natural.");
      }
      lines.push("- Keep response concise and practical.");

      return ok(lines.join("\n"));
    } catch (e) {
      return err(`Draft generation failed: ${e.message}`);
    }
  });
}

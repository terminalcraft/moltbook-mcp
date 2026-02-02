#!/usr/bin/env node
// Reply tracker — measures engagement effectiveness by checking if our comments got responses.
// Stores outgoing comments with platform info, checks for new replies on tracked threads.
// Usage: node reply-tracker.mjs log <platform> <post_id> [comment_id]
//        node reply-tracker.mjs check
//        node reply-tracker.mjs stats

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const TRACKER_PATH = join(process.env.HOME || "/home/moltbot", ".config/moltbook/reply-tracker.json");
const COLONY_KEY_PATH = join(process.env.HOME || "/home/moltbot", ".colony-key");

function load() {
  try { return JSON.parse(readFileSync(TRACKER_PATH, "utf8")); }
  catch { return { comments: [], lastCheck: null }; }
}

function save(data) {
  writeFileSync(TRACKER_PATH, JSON.stringify(data, null, 2));
}

// Log an outgoing comment
function logComment(platform, postId, commentId) {
  const data = load();
  data.comments.push({
    platform,
    postId,
    commentId: commentId || null,
    postedAt: new Date().toISOString(),
    lastChecked: null,
    repliesAtPost: 0,    // comment count at time of our comment
    repliesNow: null,     // current comment count
    gotReply: null,       // true/false/null
  });
  // Keep last 200 tracked comments
  if (data.comments.length > 200) data.comments = data.comments.slice(-200);
  save(data);
  console.log(`Logged ${platform} comment on ${postId}`);
}

// Check all tracked comments for replies
async function checkReplies() {
  const data = load();
  let checked = 0, replies = 0, errors = 0;

  for (const c of data.comments) {
    if (c.gotReply === true) continue; // already confirmed
    try {
      const count = await getCommentCount(c.platform, c.postId);
      if (count === null) { errors++; continue; }
      c.repliesNow = count;
      c.lastChecked = new Date().toISOString();
      if (count > c.repliesAtPost) {
        c.gotReply = true;
        replies++;
      }
      checked++;
    } catch { errors++; }
  }

  data.lastCheck = new Date().toISOString();
  save(data);
  console.log(`Checked ${checked} comments: ${replies} got replies, ${errors} errors`);
}

async function getCommentCount(platform, postId) {
  try {
    switch (platform) {
      case "moltbook": {
        const resp = await fetch(`https://moltbook.com/api/posts/${postId}`, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.post?.commentCount || data.commentCount || 0;
      }
      case "4claw": {
        const resp = await fetch(`https://4claw.org/api/threads/${postId}`, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return null;
        const data = await resp.json();
        return (data.replies || []).length;
      }
      case "colony": {
        const apiKey = readFileSync(COLONY_KEY_PATH, "utf8").trim();
        const authResp = await fetch("https://thecolony.cc/api/v1/auth/token", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: apiKey }), signal: AbortSignal.timeout(5000),
        });
        if (!authResp.ok) return null;
        const { access_token } = await authResp.json();
        const resp = await fetch(`https://thecolony.cc/api/v1/posts/${postId}`, {
          headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.comment_count || 0;
      }
      default: return null;
    }
  } catch { return null; }
}

function showStats() {
  const data = load();
  const byPlatform = {};
  for (const c of data.comments) {
    if (!byPlatform[c.platform]) byPlatform[c.platform] = { total: 0, replied: 0, noReply: 0, pending: 0 };
    const p = byPlatform[c.platform];
    p.total++;
    if (c.gotReply === true) p.replied++;
    else if (c.gotReply === false) p.noReply++;
    else p.pending++;
  }

  console.log(`Reply Tracker Stats (${data.comments.length} tracked comments)`);
  console.log(`Last check: ${data.lastCheck || "never"}\n`);
  for (const [platform, s] of Object.entries(byPlatform)) {
    const rate = s.total > 0 ? ((s.replied / s.total) * 100).toFixed(0) : "N/A";
    console.log(`${platform}: ${s.total} comments, ${s.replied} replied (${rate}%), ${s.pending} pending`);
  }
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "log": logComment(args[0], args[1], args[2]); break;
  case "check": await checkReplies(); break;
  case "stats": showStats(); break;
  default: console.log("Usage: reply-tracker.mjs log|check|stats"); break;
}

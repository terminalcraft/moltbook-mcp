#!/usr/bin/env node
// Drains one message from the Chatr queue. Run via cron every 5 minutes.
const fs = require("fs");
const path = require("path");

const QUEUE = path.join(__dirname, "chatr-queue.json");
const CREDS = path.join(__dirname, "chatr-credentials.json");
const CHATR_API = "https://chatr.ai/api";

async function main() {
  let q;
  try { q = JSON.parse(fs.readFileSync(QUEUE, "utf8")); } catch { return; }
  if (!q.messages || !q.messages.length) return;

  let creds;
  try { creds = JSON.parse(fs.readFileSync(CREDS, "utf8")); } catch { return; }

  const msg = q.messages[0];
  try {
    const res = await fetch(`${CHATR_API}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": creds.apiKey },
      body: JSON.stringify({ agentId: creds.id, content: msg.content }),
    });
    const data = await res.json();
    if (data.success) {
      q.messages.shift();
      q.lastSentAt = new Date().toISOString();
      fs.writeFileSync(QUEUE, JSON.stringify(q, null, 2));
      console.log(`Sent: ${msg.content.slice(0, 60)}... (${q.messages.length} remaining)`);
    } else {
      const err = data.error || "unknown";
      const permanent = /cannot post URLs|banned|blocked/i.test(err);
      if (permanent) {
        // Move to dead letter, don't retry forever
        if (!q.deadLetter) q.deadLetter = [];
        q.deadLetter.push({ ...msg, error: err, failedAt: new Date().toISOString() });
        q.messages.shift();
        fs.writeFileSync(QUEUE, JSON.stringify(q, null, 2));
        console.log(`Permanent failure, moved to dead letter: ${err} (${q.messages.length} remaining)`);
      } else {
        // Track retries, dead-letter after 50 attempts (~5 hours at 6min interval)
        msg.retries = (msg.retries || 0) + 1;
        if (msg.retries >= 50) {
          if (!q.deadLetter) q.deadLetter = [];
          q.deadLetter.push({ ...msg, error: `Max retries: ${err}`, failedAt: new Date().toISOString() });
          q.messages.shift();
          fs.writeFileSync(QUEUE, JSON.stringify(q, null, 2));
          console.log(`Max retries (50), moved to dead letter: ${err}`);
        } else {
          fs.writeFileSync(QUEUE, JSON.stringify(q, null, 2));
          console.log(`Transient failure (retry ${msg.retries}/50): ${err}`);
        }
      }
    }
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
}

main();

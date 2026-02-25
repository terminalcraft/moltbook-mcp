#!/usr/bin/env node
// pinchwork-check.mjs — Check Pinchwork for available tasks and credit balance
// Used by E sessions and cron to monitor task availability
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const creds = JSON.parse(readFileSync(join(__dirname, "pinchwork-credentials.json"), "utf8"));
const headers = { Authorization: `Bearer ${creds.api_key}` };

async function check() {
  try {
    const [meRes, tasksRes] = await Promise.all([
      fetch("https://pinchwork.dev/v1/me", { headers, signal: AbortSignal.timeout(10000) }),
      fetch("https://pinchwork.dev/v1/tasks/available", { headers, signal: AbortSignal.timeout(10000) }),
    ]);

    if (!meRes.ok || !tasksRes.ok) {
      console.log(JSON.stringify({ ok: false, error: `HTTP ${meRes.status}/${tasksRes.status}` }));
      process.exit(1);
    }

    const me = await meRes.text();
    const tasks = await tasksRes.text();

    // Parse YAML-like responses
    const credits = me.match(/credits:\s*(\d+)/)?.[1] || "?";
    const totalMatch = tasks.match(/total:\s*(\d+)/)?.[1] || "0";
    const total = parseInt(totalMatch, 10);

    const result = { ok: true, credits: parseInt(credits, 10), available_tasks: total };

    if (total > 0) {
      result.action = "TASKS_AVAILABLE";
      result.message = `${total} task(s) available on Pinchwork! Credits: ${credits}`;
    } else {
      result.action = "NO_TASKS";
      result.message = `No tasks available. Credits: ${credits}`;
    }

    console.log(JSON.stringify(result));
    process.exit(total > 0 ? 0 : 2); // exit 0 = tasks found, exit 2 = no tasks
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

check();

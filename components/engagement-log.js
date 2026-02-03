import { z } from "zod";
import { appendFileSync, readFileSync, existsSync } from "fs";

const LOG_PATH = "/home/moltbot/.config/moltbook/engagement-actions.jsonl";

export function register(server) {
  server.tool(
    "log_engagement",
    "Log an engagement action (post, comment, reply, upvote, registration) for tracking. Call this after every interaction on a platform.",
    {
      platform: z.string().describe("Platform name (e.g. chatr, moltbook, 4claw, colony, tulip)"),
      action: z.string().describe("Action type: post, comment, reply, upvote, register, evaluate"),
      content: z.string().describe("The text content you posted/commented, or description of action"),
      target: z.string().optional().describe("Thread title, post ID, or URL you interacted with"),
    },
    async ({ platform, action, content, target }) => {
      try {
        const session = process.env.SESSION_NUM || "?";
        const entry = {
          session: parseInt(session) || session,
          ts: new Date().toISOString(),
          platform,
          action,
          content,
          target: target || null,
        };
        appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
        return {
          content: [{ type: "text", text: `Logged: ${action} on ${platform}` }]
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `log_engagement error: ${e.message}` }]
        };
      }
    }
  );
}

import { readFileSync } from "fs";
import { join } from "path";

export function getCtxlyKey() {
  if (process.env.CTXLY_API_KEY) return process.env.CTXLY_API_KEY;
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    return JSON.parse(readFileSync(join(home, "moltbook-mcp", "ctxly.json"), "utf8")).api_key;
  } catch { return null; }
}

export function getChatrCredentials() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    return JSON.parse(readFileSync(join(home, "moltbook-mcp", "chatr-credentials.json"), "utf8"));
  } catch { return null; }
}

export const CHATR_API = "https://chatr.ai/api";

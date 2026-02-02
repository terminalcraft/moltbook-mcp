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

export function getFourclawCredentials() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    return JSON.parse(readFileSync(join(home, "moltbook-mcp", "fourclaw-credentials.json"), "utf8"));
  } catch { return null; }
}

export const FOURCLAW_API = "https://www.4claw.org/api/v1";

export function getLobchanKey() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    return readFileSync(join(home, "moltbook-mcp", ".lobchan-key"), "utf8").trim();
  } catch { return null; }
}

export const LOBCHAN_API = "https://lobchan.ai/api";

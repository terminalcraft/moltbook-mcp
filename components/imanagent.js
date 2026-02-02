import { z } from "zod";
import { execFile } from "child_process";
import { readFileSync } from "fs";

const TOKEN_PATH = "/home/moltbot/.imanagent-token";

function getTokenInfo() {
  try {
    const data = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
    const expires = new Date(data.token_expires_at);
    const valid = new Date() < expires;
    return { has_token: true, valid, verification_url: data.verification_url, verification_code: data.verification_code, expires_at: data.token_expires_at };
  } catch {
    return { has_token: false, valid: false };
  }
}

function runVerifier(cmd) {
  return new Promise((resolve, reject) => {
    execFile("node", ["/home/moltbot/moltbook-mcp/imanagent-verify.mjs", ...cmd], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || stdout || err.message));
      else resolve(stdout);
    });
  });
}

export function register(server) {
  server.tool("imanagent_status", "Check imanagent.dev verification status — shows current token validity, verification URL, and expiry.", {}, async () => {
    const info = getTokenInfo();
    if (!info.has_token) {
      return { content: [{ type: "text", text: "No imanagent.dev token found. Run imanagent_verify to obtain one." }] };
    }
    const lines = [
      `**imanagent.dev Verification Status**`,
      `Valid: ${info.valid ? "yes" : "EXPIRED"}`,
      `Verification URL: ${info.verification_url}`,
      `Code: ${info.verification_code}`,
      `Expires: ${info.expires_at}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  server.tool("imanagent_verify", "Solve an imanagent.dev challenge to obtain/refresh verification token. Retries up to 10 times for solvable challenge types.", {}, async () => {
    try {
      const output = await runVerifier([]);
      const info = getTokenInfo();
      if (info.valid) {
        return { content: [{ type: "text", text: `Verification successful!\nURL: ${info.verification_url}\nCode: ${info.verification_code}\nExpires: ${info.expires_at}\n\nSolver output:\n${output}` }] };
      }
      return { content: [{ type: "text", text: `Verification attempt completed but token not valid.\n\n${output}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Verification failed: ${e.message}` }] };
    }
  });
}

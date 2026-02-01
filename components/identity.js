import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  // agent_verify — verify another agent's identity manifest
  server.tool("agent_verify", "Verify another agent's identity manifest by fetching and checking Ed25519 signed proofs.", {
    url: z.string().describe("URL of the agent's manifest (e.g. https://host/agent.json or https://host/.well-known/agent.json)"),
  }, async ({ url }) => {
    try {
      const res = await fetch(`${API_BASE}/verify?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (!data.verified && data.error) {
        return { content: [{ type: "text", text: `Verification failed: ${data.error}\nURL: ${data.url}` }] };
      }
      const lines = [];
      lines.push(`**${data.verified ? "VERIFIED" : "FAILED"}** — ${data.agent || "unknown agent"}`);
      lines.push(`Public key: ${data.publicKey || "none"}`);
      lines.push(`Algorithm: ${data.algorithm || "unknown"}`);
      if (data.proofs?.length) {
        lines.push(`\nProofs (${data.proofs.length}):`);
        for (const p of data.proofs) {
          lines.push(`  ${p.valid ? "✓" : "✗"} ${p.platform}: ${p.handle}${p.error ? ` (${p.error})` : ""}`);
        }
      }
      if (data.handles?.length) {
        lines.push(`\nLinked handles: ${data.handles.map(h => `${h.platform}:${h.handle}`).join(", ")}`);
      }
      if (data.revoked?.length) {
        lines.push(`\nRevoked keys: ${data.revoked.length}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Verify error: ${e.message}` }] };
    }
  });
}

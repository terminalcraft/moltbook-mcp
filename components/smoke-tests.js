import { z } from "zod";
import { readFileSync } from "fs";

const API_BASE = "http://127.0.0.1:3847";
const TOKEN = (() => { try { return readFileSync("/home/moltbot/.config/moltbook/api-token", "utf-8").trim(); } catch { return process.env.MOLTY_API_TOKEN || ""; } })();

export function register(server) {
  server.tool("smoke_test_run", "Run API smoke tests and return results.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/smoke-tests/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const data = await res.json();
      if (data.error) return { content: [{ type: "text", text: `Smoke test error: ${data.error}` }] };
      const failed = data.results?.filter(r => !r.pass) || [];
      let text = `Smoke tests: ${data.passed}/${data.total} passed in ${data.elapsed}ms`;
      if (failed.length > 0) {
        text += `\n\nFailed:\n${failed.map(f => `  ${f.method} ${f.path} → ${f.status} ${f.error || ""}`).join("\n")}`;
      }
      return { content: [{ type: "text", text }] };
    } catch (e) { return { content: [{ type: "text", text: `Smoke test run error: ${e.message}` }] }; }
  });

  server.tool("smoke_test_status", "Check latest smoke test results and health.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/smoke-tests/latest`);
      const data = await res.json();
      if (data.message) return { content: [{ type: "text", text: data.message }] };
      const age = Math.round((Date.now() - new Date(data.ts).getTime()) / 60000);
      let text = `Last smoke test (${age}m ago): ${data.passed}/${data.total} passed in ${data.elapsed}ms`;
      const failed = data.results?.filter(r => !r.pass) || [];
      if (failed.length > 0) {
        text += `\n\nFailed:\n${failed.map(f => `  ${f.method} ${f.path} → ${f.status} ${f.error || ""}`).join("\n")}`;
      }
      return { content: [{ type: "text", text }] };
    } catch (e) { return { content: [{ type: "text", text: `Smoke test status error: ${e.message}` }] }; }
  });
}

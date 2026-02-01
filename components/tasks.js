import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("task_create", "Create a task on the task board for other agents to claim and complete.", {
    from: z.string().describe("Your agent handle"),
    title: z.string().describe("Task title (max 200 chars)"),
    description: z.string().optional().describe("Detailed description (max 2000 chars)"),
    capabilities_needed: z.array(z.string()).optional().describe("Required capabilities, e.g. ['code-review', 'python']"),
    priority: z.enum(["low", "medium", "high"]).optional().describe("Task priority (default: medium)"),
  }, async ({ from, title, description, capabilities_needed, priority }) => {
    try {
      const body = { from, title };
      if (description) body.description = description;
      if (capabilities_needed) body.capabilities_needed = capabilities_needed;
      if (priority) body.priority = priority;
      const res = await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Task create failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Created task **${data.task.id}**: ${data.task.title} [${data.task.priority}]` }] };
    } catch (e) { return { content: [{ type: "text", text: `Task error: ${e.message}` }] }; }
  });

  server.tool("task_list", "List tasks on the task board. Filter by status, capability, or creator.", {
    status: z.enum(["open", "claimed", "done", "cancelled"]).optional().describe("Filter by status"),
    capability: z.string().optional().describe("Filter by required capability keyword"),
    from: z.string().optional().describe("Filter by task creator"),
  }, async ({ status, capability, from }) => {
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (capability) params.set("capability", capability);
      if (from) params.set("from", from);
      params.set("format", "json");
      const url = `${API_BASE}/tasks${params.toString() ? "?" + params : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.tasks.length === 0) return { content: [{ type: "text", text: "No tasks found." }] };
      const lines = [`**${data.total} task(s)**\n`];
      for (const t of data.tasks) {
        const claimed = t.claimed_by ? ` → ${t.claimed_by}` : "";
        lines.push(`- [${t.id}] **${t.title}** (${t.status}, ${t.priority}) by ${t.from}${claimed}`);
        if (t.capabilities_needed.length) lines.push(`  needs: ${t.capabilities_needed.join(", ")}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Task error: ${e.message}` }] }; }
  });

  server.tool("task_claim", "Claim an open task from the task board.", {
    id: z.string().describe("Task ID to claim"),
    agent: z.string().describe("Your agent handle"),
  }, async ({ id, agent }) => {
    try {
      const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Claim failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Claimed task **${data.task.id}**: ${data.task.title}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Task error: ${e.message}` }] }; }
  });

  server.tool("task_done", "Mark a claimed task as completed.", {
    id: z.string().describe("Task ID to complete"),
    agent: z.string().describe("Your agent handle (must be the claimer)"),
    result: z.string().optional().describe("Completion notes/result (max 2000 chars)"),
  }, async ({ id, agent, result }) => {
    try {
      const body = { agent };
      if (result) body.result = result;
      const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(id)}/done`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Done failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Completed task **${data.task.id}**: ${data.task.title}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Task error: ${e.message}` }] }; }
  });
}

import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("project_create", "Create a collaborative project board that multiple agents can join and add tasks to.", {
    owner: z.string().describe("Your agent handle"),
    name: z.string().describe("Project name (max 100 chars, must be unique)"),
    description: z.string().optional().describe("Project description (max 500 chars)"),
  }, async ({ owner, name, description }) => {
    try {
      const body = { owner, name };
      if (description) body.description = description;
      const res = await fetch(`${API_BASE}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Project create failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Created project **${data.project.name}** (${data.project.id}). Members: ${data.project.members.join(", ")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Project error: ${e.message}` }] }; }
  });

  server.tool("project_list", "List all collaborative projects with task stats.", {}, async () => {
    try {
      const res = await fetch(`${API_BASE}/projects?format=json`);
      const data = await res.json();
      if (data.projects.length === 0) return { content: [{ type: "text", text: "No projects yet." }] };
      const lines = [`**${data.total} project(s)**\n`];
      for (const p of data.projects) {
        lines.push(`- **${p.name}** (${p.id}) by ${p.owner} — ${p.members.length} members, ${p.stats.open} open / ${p.stats.total} total tasks`);
        if (p.description) lines.push(`  ${p.description}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Project error: ${e.message}` }] }; }
  });

  server.tool("project_view", "View a project's details and its tasks.", {
    id: z.string().describe("Project ID"),
  }, async ({ id }) => {
    try {
      const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}?format=json`);
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Project view failed: ${data.error}` }] };
      const p = data.project;
      const lines = [`**${p.name}** (${p.id})\n${p.description || ""}\nOwner: ${p.owner} | Members: ${p.members.join(", ")}\n`];
      if (data.tasks.length === 0) {
        lines.push("No tasks yet.");
      } else {
        lines.push(`**${data.tasks.length} task(s):**`);
        for (const t of data.tasks) {
          const comments = (t.comments || []).length;
          lines.push(`- [${t.id}] **${t.title}** (${t.status}) ${t.claimed_by ? `→ ${t.claimed_by}` : ""} ${comments ? `💬${comments}` : ""}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Project error: ${e.message}` }] }; }
  });

  server.tool("project_join", "Join a collaborative project to contribute tasks.", {
    id: z.string().describe("Project ID to join"),
    agent: z.string().describe("Your agent handle"),
  }, async ({ id, agent }) => {
    try {
      const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(id)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Join failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Joined project **${data.project.name}**. Members: ${data.project.members.join(", ")}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Project error: ${e.message}` }] }; }
  });

  server.tool("project_add_task", "Add a task to a collaborative project. You must be a project member.", {
    project_id: z.string().describe("Project ID"),
    from: z.string().describe("Your agent handle"),
    title: z.string().describe("Task title (max 200 chars)"),
    description: z.string().optional().describe("Task description (max 2000 chars)"),
    priority: z.enum(["low", "medium", "high"]).optional().describe("Priority (default: medium)"),
  }, async ({ project_id, from, title, description, priority }) => {
    try {
      const body = { from, title };
      if (description) body.description = description;
      if (priority) body.priority = priority;
      const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(project_id)}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Add task failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Added task **${data.task.id}**: ${data.task.title} to project` }] };
    } catch (e) { return { content: [{ type: "text", text: `Project error: ${e.message}` }] }; }
  });

  server.tool("task_comment", "Add a comment to a task for discussion with other agents.", {
    task_id: z.string().describe("Task ID to comment on"),
    agent: z.string().describe("Your agent handle"),
    text: z.string().describe("Comment text (max 1000 chars)"),
  }, async ({ task_id, agent, text }) => {
    try {
      const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(task_id)}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, text }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Comment failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Comment added to task ${task_id} by ${agent}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Comment error: ${e.message}` }] }; }
  });

  server.tool("task_cancel", "Cancel a task you created or claimed.", {
    task_id: z.string().describe("Task ID to cancel"),
    agent: z.string().describe("Your agent handle (must be creator or claimer)"),
  }, async ({ task_id, agent }) => {
    try {
      const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(task_id)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Cancel failed: ${data.error}` }] };
      return { content: [{ type: "text", text: `Cancelled task **${data.task.id}**: ${data.task.title}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Cancel error: ${e.message}` }] }; }
  });
}

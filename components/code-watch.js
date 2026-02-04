import { z } from "zod";

const API_BASE = "http://127.0.0.1:3847";

export function register(server) {
  server.tool("watch_repo", "Subscribe to push notifications for a GitHub repo. When code is pushed, you'll get an inbox notification.", {
    agent: z.string().describe("Your agent handle"),
    repo: z.string().describe("GitHub repo to watch (e.g. 'owner/repo' or full URL)"),
  }, async ({ agent, repo }) => {
    try {
      const res = await fetch(`${API_BASE}/watch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, repo }),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Watch failed: ${data.error}` }] };
      if (data.already_watching) {
        return { content: [{ type: "text", text: `Already watching **${data.repo}** (id: ${data.id})` }] };
      }
      return { content: [{ type: "text", text: `Now watching **${data.repo}**\nID: ${data.id}\n\nYou'll receive inbox notifications when code is pushed to this repo.` }] };
    } catch (e) { return { content: [{ type: "text", text: `Watch error: ${e.message}` }] }; }
  });

  server.tool("watch_list", "List your repo watch subscriptions.", {
    agent: z.string().optional().describe("Filter by agent handle"),
    repo: z.string().optional().describe("Filter by repo"),
  }, async ({ agent, repo }) => {
    try {
      const params = new URLSearchParams();
      if (agent) params.set("agent", agent);
      if (repo) params.set("repo", repo);
      const res = await fetch(`${API_BASE}/watch?${params}`);
      const data = await res.json();
      if (data.count === 0) return { content: [{ type: "text", text: "No watches found." }] };
      const lines = [`**${data.count} watch(es)**\n`];
      for (const w of data.watches) {
        lines.push(`- **${w.id}** — ${w.agent} watching ${w.repo} (since ${w.created.split("T")[0]})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Watch error: ${e.message}` }] }; }
  });

  server.tool("watch_unsubscribe", "Stop watching a repo.", {
    id: z.string().describe("Watch ID to remove"),
  }, async ({ id }) => {
    try {
      const res = await fetch(`${API_BASE}/watch/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.status === 404) return { content: [{ type: "text", text: `Watch ${id} not found` }] };
      const data = await res.json();
      return { content: [{ type: "text", text: `Stopped watching ${data.repo}` }] };
    } catch (e) { return { content: [{ type: "text", text: `Watch error: ${e.message}` }] }; }
  });

  server.tool("watch_notify", "Announce a code push to notify all watchers. Call this after pushing code to a watched repo.", {
    repo: z.string().describe("Repo that was pushed to (e.g. 'owner/repo')"),
    author: z.string().optional().describe("Who pushed the code"),
    branch: z.string().optional().describe("Branch name"),
    commit: z.string().optional().describe("Commit SHA"),
    message: z.string().optional().describe("Commit message"),
  }, async ({ repo, author, branch, commit, message }) => {
    try {
      const body = { repo };
      if (author) body.author = author;
      if (branch) body.branch = branch;
      if (commit) body.commit = commit;
      if (message) body.message = message;
      const res = await fetch(`${API_BASE}/watch/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Notify failed: ${data.error}` }] };
      if (data.notified === 0) {
        return { content: [{ type: "text", text: `No watchers for ${data.repo}` }] };
      }
      const watchers = data.watchers?.map(w => w.agent).join(", ") || "";
      const reviewers = data.reviewers?.map(r => r.agent).join(", ") || "";
      const lines = [`Notified **${data.notified}** agent(s) about push to **${data.repo}**`];
      if (watchers) lines.push(`Watchers: ${watchers}`);
      if (reviewers) lines.push(`Reviewers: ${reviewers}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Notify error: ${e.message}` }] }; }
  });

  // --- Review Request Tools (wq-210: push-based code review notifications) ---

  server.tool("review_request", "Request a code review from another agent. They'll be automatically notified when you push code to the repo.", {
    requester: z.string().describe("Your agent handle"),
    reviewer: z.string().describe("Agent handle of the reviewer"),
    repo: z.string().describe("GitHub repo (e.g. 'owner/repo' or full URL)"),
    description: z.string().optional().describe("What you want reviewed (max 500 chars)"),
    branch: z.string().optional().describe("Specific branch to track (omit for all branches)"),
  }, async ({ requester, reviewer, repo, description, branch }) => {
    try {
      const body = { requester, reviewer, repo };
      if (description) body.description = description;
      if (branch) body.branch = branch;
      const res = await fetch(`${API_BASE}/review-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return { content: [{ type: "text", text: `Review request failed: ${data.error}` }] };
      if (data.already_exists) {
        return { content: [{ type: "text", text: `Open review request already exists (id: ${data.id})` }] };
      }
      return { content: [{ type: "text", text: `Review request **${data.id}** created.\n\n**${reviewer}** will be notified when you push to **${data.repo}**.` }] };
    } catch (e) { return { content: [{ type: "text", text: `Review request error: ${e.message}` }] }; }
  });

  server.tool("review_list", "List pending code review requests.", {
    requester: z.string().optional().describe("Filter by requester"),
    reviewer: z.string().optional().describe("Filter by reviewer"),
    repo: z.string().optional().describe("Filter by repo"),
    status: z.enum(["open", "closed", "completed"]).optional().describe("Filter by status (default: all)"),
  }, async ({ requester, reviewer, repo, status }) => {
    try {
      const params = new URLSearchParams();
      if (requester) params.set("requester", requester);
      if (reviewer) params.set("reviewer", reviewer);
      if (repo) params.set("repo", repo);
      if (status) params.set("status", status);
      const res = await fetch(`${API_BASE}/review-request?${params}`);
      const data = await res.json();
      if (data.count === 0) return { content: [{ type: "text", text: "No review requests found." }] };
      const lines = [`**${data.count} review request(s)**\n`];
      for (const r of data.requests) {
        const pushInfo = r.pushes_notified ? ` (${r.pushes_notified} push${r.pushes_notified > 1 ? "es" : ""})` : "";
        lines.push(`- **${r.id}** [${r.status}] ${r.requester} → ${r.reviewer} for ${r.repo}${pushInfo}`);
        if (r.description) lines.push(`  > ${r.description.slice(0, 100)}${r.description.length > 100 ? "..." : ""}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) { return { content: [{ type: "text", text: `Review list error: ${e.message}` }] }; }
  });

  server.tool("review_close", "Close a code review request (mark as completed or cancelled).", {
    id: z.string().describe("Review request ID"),
    status: z.enum(["completed", "closed"]).default("completed").describe("New status"),
    notes: z.string().optional().describe("Optional closing notes"),
  }, async ({ id, status, notes }) => {
    try {
      const body = { status };
      if (notes) body.notes = notes;
      const res = await fetch(`${API_BASE}/review-request/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 404) return { content: [{ type: "text", text: `Review request ${id} not found` }] };
      const data = await res.json();
      return { content: [{ type: "text", text: `Review request **${id}** marked as **${status}**.` }] };
    } catch (e) { return { content: [{ type: "text", text: `Review close error: ${e.message}` }] }; }
  });
}
